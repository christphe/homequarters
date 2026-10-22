import { useCallback, useEffect, useRef, useState } from "react";
import { describeMediaError, media, spotlightMedia } from "../media/MediaManager";
import { isListed, isMissingDevice } from "../media/devices";
import { session } from "../session";
import { savePrefs, saveSettings, toast, useStore } from "../store";
import { AUTO_OFF_GRACE_MS } from "../media/autoOff";
import { t } from "../i18n";
import { Modal } from "./Modal";

const canPickOutput = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

/**
 * "enable": the first opt-in to audio and video, with device choice. "devices": the same choice later, from
 * the settings; the call is paused meanwhile and resumes on the chosen devices.
 */
export function MediaDialog({ onClose, mode = "enable" }: { onClose: () => void; mode?: "enable" | "devices" }) {
  const prefs = useStore((s) => s.prefs);
  const settings = useStore((s) => s.settings);
  // The preview always shows the microphone's level, and the camera when the bar has it on.
  const [camOn] = useState(prefs.camOn);
  const [autoMuteMic, setAutoMuteMic] = useState(settings.autoMuteMic);
  const [autoCamOff, setAutoCamOff] = useState(settings.autoCamOff);
  const [micId, setMicId] = useState(prefs.micId);
  const [camId, setCamId] = useState(prefs.camId);
  const [spkId, setSpkId] = useState(prefs.spkId);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [err, setErr] = useState("");
  const [level, setLevel] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const stopAudio = useRef<() => void>(() => {});
  // one message per dialog, whichever devices fell back (a second toast would replace the first at once)
  const toldGone = useRef(false);
  const tellGone = useCallback(() => {
    if (toldGone.current) return;
    toldGone.current = true;
    toast(t("media.deviceGone"), 6000);
  }, []);

  const stop = useCallback(() => {
    stopAudio.current();
    stopAudio.current = () => {}; // once: stopping twice would close a closed AudioContext
    stream.current?.getTracks().forEach((tr) => tr.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setLevel(0);
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list);
      return list;
    } catch {
      return []; // no device API
    }
  }, []);

  // (Re)start the preview whenever the selection changes. Nothing is captured before this dialog opens.
  useEffect(() => {
    let cancelled = false;
    stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      setErr(t("media.noDevice"));
      return;
    }
    navigator.mediaDevices
      .getUserMedia({
        audio: micId ? { deviceId: { exact: micId } } : true,
        video: camOn ? (camId ? { deviceId: { exact: camId }, width: 640, height: 360 } : { width: 640, height: 360 }) : false,
      })
      .then(async (s) => {
        if (cancelled) return s.getTracks().forEach((tr) => tr.stop());
        stream.current = s;
        setErr("");
        if (video.current) video.current.srcObject = s;
        const list = await refreshDevices();
        if (cancelled) return; // the cleanup stopped this stream
        // a chosen speaker that is not there now: the default one (kept as the choice only if saved)
        if (spkId && isListed(list, "audiooutput", spkId) === false) {
          setSpkId("");
          tellGone();
        }
        if (s.getAudioTracks().length) {
          const ctx = new AudioContext();
          const an = ctx.createAnalyser();
          an.fftSize = 512;
          ctx.createMediaStreamSource(s).connect(an);
          const buf = new Uint8Array(an.fftSize);
          const timer = window.setInterval(() => {
            an.getByteTimeDomainData(buf);
            let sum = 0;
            for (const v of buf) sum += (v - 128) * (v - 128);
            setLevel(Math.min(1, Math.sqrt(sum / buf.length) / 40));
          }, 100);
          stopAudio.current = () => {
            clearInterval(timer);
            void ctx.close();
          };
        }
      })
      .catch(async (e) => {
        if (cancelled) return;
        if (isMissingDevice(e)) {
          // a chosen microphone or camera that is not there now (or not known yet): preview the default one
          const list = await refreshDevices();
          if (cancelled) return;
          const dropMic = !!micId && isListed(list, "audioinput", micId) !== true;
          const dropCam = camOn && !!camId && isListed(list, "videoinput", camId) !== true;
          if (dropMic || dropCam) {
            if (dropMic) setMicId("");
            if (dropCam) setCamId("");
            tellGone();
            return; // the preview restarts on the default
          }
        }
        setErr(describeMediaError(e));
      });
    return () => {
      cancelled = true;
      stop();
    };
    // spkId is read for the check only: choosing a speaker does not restart the preview
  }, [camOn, micId, camId, stop, refreshDevices, tellGone]);

  const opts = (kind: MediaDeviceKind) => devices.filter((d) => d.kind === kind);
  const activate = () => {
    stop();
    savePrefs({ micId, camId, spkId });
    saveSettings({ autoMuteMic, autoCamOff });
    if (mode === "enable") session.setConsent(true);
    else
      for (const m of [media, spotlightMedia]) {
        void m.switchDevice("videoinput", camId);
        void m.switchDevice("audiooutput", spkId);
      }
    onClose();
  };

  useEffect(() => {
    if (mode !== "devices") return;
    void media.pauseForMicTest(true);
    void spotlightMedia.pauseForMicTest(true);
    return () => {
      void media.pauseForMicTest(false);
      void spotlightMedia.pauseForMicTest(false);
    };
  }, [mode]);

  return (
    <Modal title={mode === "enable" ? t("media.enable") : t("media.devices")} onClose={onClose}>
      {mode === "enable" ? <p className="muted">{t("media.consentText")}</p> : <p className="muted">{t("media.devicesText")}</p>}
      <div className="preview">
        <video ref={video} autoPlay muted playsInline className="mirror" />
        {!camOn && <span className="ph">{t("media.cameraOff")}</span>}
      </div>
      <div className="meter" aria-hidden><i style={{ width: `${Math.round(level * 100)}%` }} /></div>
      {err && <p className="error" role="alert">{err}</p>}
      <label className="check"><input type="checkbox" checked={autoMuteMic} onChange={(e) => setAutoMuteMic(e.target.checked)} /> {t("media.autoMuteMic")}</label>
      <label className="check"><input type="checkbox" checked={autoCamOff} onChange={(e) => setAutoCamOff(e.target.checked)} /> {t("media.autoCamOff")}</label>
      <small className="muted">{t("media.autoOffHint", { seconds: AUTO_OFF_GRACE_MS / 1000 })}</small>
      <label className="field"><span>{t("media.mic")}</span>
        <select value={micId} onChange={(e) => setMicId(e.target.value)}>
          <option value="">{t("media.default")}</option>
          {opts("audioinput").map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
        </select>
      </label>
      <label className="field"><span>{t("media.camera")}</span>
        <select value={camId} onChange={(e) => setCamId(e.target.value)}>
          <option value="">{t("media.default")}</option>
          {opts("videoinput").map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
        </select>
      </label>
      {canPickOutput && (
        <label className="field"><span>{t("media.speaker")}</span>
          <select value={spkId} onChange={(e) => setSpkId(e.target.value)}>
            <option value="">{t("media.default")}</option>
            {opts("audiooutput").map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
          </select>
        </label>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>{t("media.cancel")}</button>
        <button className="primary" onClick={activate}>{mode === "enable" ? t("media.activate") : t("media.save")}</button>
      </div>
    </Modal>
  );
}
