import { useEffect, useRef, useState } from "react";
import { createLocalAudioTrack } from "livekit-client";
import { media, micCapture, spotlightMedia } from "../media/MediaManager";
import { getState, saveSettings, useStore, type NoiseEngine } from "../store";
import { t, type Key } from "../i18n";
import { Modal } from "./Modal";

const ENGINES: NoiseEngine[] = ["gtcrn", "rnnoise", "speex"];
const RECORD_S = 5;

// what the playback runs through: recording -> (engine) -> out (a level meter) -> headphones
type Player = { ctx: AudioContext; src: AudioBufferSourceNode; node: (AudioNode & { destroy(): void }) | null; out: AnalyserNode };

function stopPlayer(p: Player | null) {
  if (!p) return;
  p.src.stop();
  p.src.disconnect();
  p.node?.disconnect();
  p.node?.destroy();
  p.out.disconnect();
  void p.ctx.close();
}

// Choose the noise suppression engine and compare them on one recording of yourself, played back in a
// loop. The call is paused while this is open: nobody hears the test, and the test is not drowned by the call.
export function NoiseDialog({ onClose }: { onClose: () => void }) {
  const engine = useStore((s) => s.settings.noiseEngine);
  const [clip, setClip] = useState<AudioBuffer | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [filtered, setFiltered] = useState(true);
  const [error, setError] = useState("");
  // what was recorded, shown under the buttons: an empty or silent take says why the test hears nothing
  const [take, setTake] = useState<{ seconds: number; peakDb: number; device: string; processing: string; url: string } | null>(null);
  const player = useRef<Player | null>(null);
  const meter = useRef<HTMLDivElement>(null);

  // pause the call while the dialog is open, and put things back (with the chosen engine) on close
  useEffect(() => {
    void media.pauseForMicTest(true);
    void spotlightMedia.pauseForMicTest(true);
    return () => {
      stopPlayer(player.current);
      player.current = null;
      void media.pauseForMicTest(false).then(() => media.applyNoiseSuppression());
      void spotlightMedia.pauseForMicTest(false).then(() => spotlightMedia.applyNoiseSuppression());
    };
  }, []);

  // (re)wire the playback whenever the engine or the filter switch changes
  useEffect(() => {
    const cur = player.current;
    if (!playing || !cur) return;
    let cancelled = false;
    cur.src.disconnect();
    cur.node?.disconnect();
    cur.node?.destroy();
    cur.node = null;
    if (!filtered) {
      cur.src.connect(cur.out);
      return;
    }
    void import("../media/noise")
      .then(({ noiseNode }) => noiseNode(cur.ctx, engine))
      .then((node) => {
        if (cancelled || player.current !== cur) return node.destroy();
        cur.node = node;
        cur.src.connect(node).connect(cur.out);
      })
      .catch(() => setError(t("media.noiseFailed")));
    return () => {
      cancelled = true;
    };
  }, [playing, filtered, engine]);

  // the level of what is played, so silence is visibly the recording's and not the player's
  useEffect(() => {
    const cur = player.current;
    if (!playing || !cur) return;
    const buf = new Float32Array(cur.out.fftSize);
    let raf = 0;
    const draw = () => {
      cur.out.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      if (meter.current) {
        meter.current.style.width = Math.round(level * 100) + "%";
        meter.current.dataset.level = level.toFixed(3);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  async function record() {
    stopPlayer(player.current);
    player.current = null;
    setPlaying(false);
    setError("");
    let stream: MediaStream;
    let lkTrack: Awaited<ReturnType<typeof createLocalAudioTrack>>;
    try {
      // captured by LiveKit with the call's own settings: the engines are compared on the very sound a
      // call sends (the call's microphone is released meanwhile, so this is the only capture)
      lkTrack = await createLocalAudioTrack(micCapture());
      stream = new MediaStream([lkTrack.mediaStreamTrack]);
    } catch {
      return setError(t("noise.micDenied"));
    }
    const device = stream.getAudioTracks()[0]?.label ?? "";
    // what the browser actually applied, for the diagnosis under the buttons
    const st = stream.getAudioTracks()[0]?.getSettings() ?? {};
    const processing = `${st.sampleRate ?? "?"} Hz, ${st.channelCount ?? "?"} ch, echo ${st.echoCancellation ? "on" : "off"}, noise ${st.noiseSuppression ? "on" : "off"}, gain ${st.autoGainControl ? "on" : "off"}`;
    const rec = new MediaRecorder(stream);
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.start();
    for (let s = RECORD_S; s > 0; s--) {
      setCountdown(s);
      await new Promise((r) => setTimeout(r, 1000));
    }
    rec.stop();
    await done;
    lkTrack.stop(); // recording done: capture stops
    setCountdown(0);
    try {
      const decoder = new AudioContext({ sampleRate: 48000 });
      const blob = new Blob(parts, { type: rec.mimeType });
      const audio = await decoder.decodeAudioData(await blob.arrayBuffer());
      void decoder.close();
      let peak = 0;
      for (let c = 0; c < audio.numberOfChannels; c++) for (const v of audio.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
      if (take) URL.revokeObjectURL(take.url);
      setTake({ seconds: audio.duration, peakDb: 20 * Math.log10(peak || 1e-6), device, processing, url: URL.createObjectURL(blob) });
      setClip(audio);
    } catch {
      setError(t("noise.recordFailed"));
    }
  }

  async function togglePlay() {
    if (playing) {
      stopPlayer(player.current);
      player.current = null;
      setPlaying(false);
      return;
    }
    if (!clip) return;
    // created and started inside the click: made after an await, the browser may keep it paused (silent)
    const ctx = new AudioContext({ sampleRate: 48000 });
    void ctx.resume();
    const { spkId } = getState().prefs;
    const sink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (spkId && sink.setSinkId) await sink.setSinkId(spkId).catch(() => {}); // the output chosen for calls
    const src = ctx.createBufferSource();
    src.buffer = clip;
    src.loop = true;
    const out = ctx.createAnalyser();
    out.fftSize = 1024;
    out.connect(ctx.destination);
    src.start();
    player.current = { ctx, src, node: null, out };
    setPlaying(true);
  }

  return (
    <Modal title={t("noise.title")} onClose={onClose}>
      <div className="noise-engines" role="radiogroup" aria-label={t("noise.engine")}>
        {ENGINES.map((e) => (
          <label key={e} className={"noise-engine" + (engine === e ? " on" : "")}>
            <input type="radio" name="noise-engine" checked={engine === e} onChange={() => saveSettings({ noiseEngine: e })} />
            <span>
              <b>{t(`noise.${e}` as Key)}</b>
              <small className="muted">{t(`noise.${e}Hint` as Key)}</small>
            </span>
          </label>
        ))}
      </div>
      <div className="noise-test">
        <p className="muted">{t("noise.testHint", { s: RECORD_S })}</p>
        <div className="modal-actions">
          <button className="btn" disabled={countdown > 0} onClick={() => void record()}>
            {countdown > 0 ? t("noise.recording", { s: countdown }) : clip ? t("noise.recordAgain") : t("noise.record", { s: RECORD_S })}
          </button>
          <button className={playing ? "primary" : "btn"} aria-pressed={playing} disabled={!clip || countdown > 0} onClick={() => void togglePlay()}>
            {playing ? t("noise.stop") : t("noise.play")}
          </button>
          {playing && (
            <button className="btn" aria-pressed={filtered} onClick={() => setFiltered((f) => !f)}>
              {filtered ? t("noise.filterOn") : t("noise.filterOff")}
            </button>
          )}
        </div>
        {playing && (
          <div className="noise-meter" role="img" aria-label={t("noise.level")}>
            <div ref={meter} className="noise-meter-bar" data-level="0" />
          </div>
        )}
        {take && (
          <p className={"muted noise-take" + (take.peakDb < -50 ? " silent" : "")}>
            {t("noise.take", { s: take.seconds.toFixed(1), db: take.peakDb.toFixed(0), device: take.device || "?" })} <span className="noise-processing">({take.processing})</span>
            {take.peakDb < -50 && <> {t("noise.takeSilent")}</>}{" "}
            <a href={take.url} download="tilework-mic-test.webm">{t("noise.download")}</a>
          </p>
        )}
        {error && <p className="setting-note" role="alert">{error}</p>}
      </div>
      <div className="modal-actions">
        <button className="primary" onClick={onClose}>{t("settings.close")}</button>
      </div>
    </Modal>
  );
}
