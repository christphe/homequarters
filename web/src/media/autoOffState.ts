// Wires the turn-off after a conversation (autoOff.ts) to the store, the settings and browser storage.
import { getState, savePrefs, subscribe, type MediaPrefs } from "../store";
import { AutoOff, inCall, type Pending } from "./autoOff";

const KEY = "hq.autoOff";

function load(): Pending | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Pending> | null;
    if (!p || typeof p.mic !== "boolean" || typeof p.cam !== "boolean" || !(p.at === null || typeof p.at === "number")) return null;
    return { at: p.at, mic: p.mic, cam: p.cam };
  } catch {
    return null;
  }
}

function save(p: Pending | null) {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {
    /* no storage: the turn-off still happens in this page, not after a reload */
  }
}

export const autoOff = new AutoOff({
  now: () => Date.now(),
  load,
  save,
  turnOff(mic, cam) {
    const { autoMuteMic, autoCamOff } = getState().settings;
    const off: Partial<MediaPrefs> = {};
    if (mic && autoMuteMic) off.micOn = false;
    if (cam && autoCamOff) off.camOn = false;
    if (Object.keys(off).length) savePrefs(off);
  },
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (id) => window.clearTimeout(id),
});

let started = false;
/** Once per page: follows calls starting and ending for as long as the page lives. */
export function startAutoOff() {
  if (started) return;
  started = true;
  autoOff.resume();
  addEventListener("pagehide", () => autoOff.hidden());
  subscribe(() => autoOff.update(inCall(getState())));
}
