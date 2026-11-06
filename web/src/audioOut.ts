import { getState } from "./store";

// Where the cues (a wave, a direct message, a conversation starting...) are heard. Each cue is a short
// WAV synthesised here once (no audio file to license or download), played by an Audio element that is
// never put in the page, on the speaker chosen for calls where the engine can pick one (setSinkId).
//
// Browsers refuse sound before the person has touched the page, and a reload (the update banner's)
// starts a page with no touch at all while a conversation may start at once. WebKit (Safari, the macOS
// app) keeps refusing what was set up before the first gesture, so a refused cue is dropped and every
// key or pointer press, until each element has played once, plays the elements muted inside the
// gesture: that is what lets later cues play.

export type Cue = "wave" | "dm" | "knock" | "convIn" | "convOut";

const TUNES: Record<Cue, number[]> = {
  wave: [660, 880],
  dm: [988],
  knock: [294, 294],
  // like the wave (two quick triangle notes) but a major third, so they are told apart:
  convIn: [523, 659], // rising: you are heard now
  convOut: [659, 523], // falling: you are not any more
};

const RATE = 22050;
const STEP = 0.15; // seconds between two notes of a cue
const NOTE = 0.22; // seconds a note lasts
const PEAK = 0.12;

/** One cue as 16-bit mono PCM samples: triangle notes, a 12 ms attack, an exponential fall to silence. */
export function cueSamples(notes: readonly number[], rate = RATE): Int16Array {
  const out = new Float32Array(Math.ceil((STEP * (notes.length - 1) + NOTE) * rate));
  const floor = 0.0001;
  notes.forEach((f, k) => {
    const start = Math.round(k * STEP * rate);
    const len = Math.round(NOTE * rate);
    for (let i = 0; i < len && start + i < out.length; i++) {
      const t = i / rate;
      const env = t < 0.012 ? floor * (PEAK / floor) ** (t / 0.012) : t < 0.2 ? PEAK * (floor / PEAK) ** ((t - 0.012) / 0.188) : floor;
      const x = (f * t) % 1;
      out[start + i] += env * (1 - 4 * Math.abs(x - 0.5)); // triangle, from -1 to 1
    }
  });
  const pcm = new Int16Array(out.length);
  for (let i = 0; i < out.length; i++) pcm[i] = Math.max(-1, Math.min(1, out[i])) * 0x7fff;
  return pcm;
}

/** A RIFF/WAVE file around 16-bit mono samples. */
export function wavFile(pcm: Int16Array, rate = RATE): ArrayBuffer {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // bytes per second
  v.setUint16(32, 2, true); // bytes per frame
  v.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i], true);
  return buf;
}

type SinkAudio = HTMLAudioElement & { sinkId?: string; setSinkId?: (id: string) => Promise<void> };

const elements = new Map<Cue, SinkAudio>();
const unlocked = new Set<SinkAudio>();

/** What became of the last cues, newest last (read by the browser tests). */
export const soundLog: { cue: Cue; result: "played" | "blocked" | "failed"; sink: string }[] = [];
function record(cue: Cue, result: "played" | "blocked" | "failed", el: SinkAudio) {
  soundLog.push({ cue, result, sink: el.sinkId ?? "" });
  if (soundLog.length > 20) soundLog.shift();
}

function element(cue: Cue): SinkAudio {
  let el = elements.get(cue);
  if (!el) {
    el = new Audio(URL.createObjectURL(new Blob([wavFile(cueSamples(TUNES[cue]))], { type: "audio/wav" }))) as SinkAudio;
    el.preload = "auto";
    elements.set(cue, el);
  }
  return el;
}

/** The chosen speaker when the engine can pick one; a speaker that is not there gives way to the default. */
async function applySpeaker(el: SinkAudio) {
  if (!el.setSinkId) return;
  const id = getState().prefs.spkId;
  if (el.sinkId === id) return;
  try {
    await el.setSinkId(id);
  } catch {
    if (el.sinkId) await el.setSinkId("").catch(() => {});
  }
}

/** Plays a cue now, or drops it when the browser refuses sound (nothing is thrown). */
export function playCue(cue: Cue) {
  const el = element(cue);
  void (async () => {
    await applySpeaker(el);
    el.muted = false;
    el.currentTime = 0;
    try {
      await el.play();
      unlocked.add(el);
      if (unlocked.size === Object.keys(TUNES).length) stopListening();
      record(cue, "played", el);
    } catch (e) {
      record(cue, e instanceof DOMException && e.name === "NotAllowedError" ? "blocked" : "failed", el);
    }
  })();
}

/** Inside a key or pointer press: each element plays once, muted, so the browser lets it play later. */
function unlock() {
  for (const cue of Object.keys(TUNES) as Cue[]) {
    const el = element(cue);
    if (unlocked.has(el) || !el.paused) continue;
    el.muted = true;
    el.play().then(
      () => {
        if (el.muted) { // still the silent play: a cue played meanwhile unmuted it and keeps playing
          el.pause();
          el.currentTime = 0;
          el.muted = false;
        }
        unlocked.add(el);
        if (unlocked.size === Object.keys(TUNES).length) stopListening();
      },
      () => { el.muted = false; },
    );
  }
}

const opts = { capture: true, passive: true } as const;
function stopListening() {
  window.removeEventListener("keydown", unlock, opts);
  window.removeEventListener("pointerdown", unlock, opts);
}
if (typeof window !== "undefined") {
  window.addEventListener("keydown", unlock, opts);
  window.addEventListener("pointerdown", unlock, opts);
}
