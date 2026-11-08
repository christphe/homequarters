// @vitest-environment jsdom
// Cues the server triggers (web/src/audioOut.ts, through notify.ts's chime) against a model of WebKit's
// rule (Safari, the macOS app), the one e2e/scenarios/sounds.ts stubs in Chrome: a cue's element plays only
// once it has been played while a key or pointer press is handled. The browser suite keeps the real reload,
// key press and wave (refused, then played on the chosen speaker); these are the rules behind them.
import { afterAll, beforeEach, expect, test, vi } from "vitest";

let pressing = false; // true while a key or pointer press is being handled
let plays = 0; // play() calls on the cues' elements
let unplayable = false; // an engine that cannot decode the cues at all
const allowed = new WeakSet<HTMLMediaElement>();
const speakers = new Set(["spk-1"]);

const proto = HTMLMediaElement.prototype as HTMLMediaElement & { sinkId: string; setSinkId(id: string): Promise<void> };
const saved = { play: proto.play, pause: proto.pause, createObjectURL: URL.createObjectURL };
let blobs = 0;
URL.createObjectURL = () => "blob:cue-" + ++blobs;
proto.play = function (this: HTMLMediaElement) {
  plays++;
  if (unplayable) return Promise.reject(new DOMException("no decoder (stub)", "NotSupportedError"));
  if (pressing) allowed.add(this);
  if (!allowed.has(this)) return Promise.reject(new DOMException("refused before a gesture (stub of WebKit's rule)", "NotAllowedError"));
  return Promise.resolve();
};
proto.pause = () => {};
Object.defineProperty(proto, "sinkId", { value: "", writable: true, configurable: true });
proto.setSinkId = function (this: { sinkId: string }, id: string) {
  if (id && !speakers.has(id)) return Promise.reject(new DOMException("no such speaker", "NotFoundError"));
  this.sinkId = id;
  return Promise.resolve();
};
afterAll(() => {
  Object.assign(proto, { play: saved.play, pause: saved.pause });
  URL.createObjectURL = saved.createObjectURL;
});

let clock = 0;
vi.spyOn(performance, "now").mockImplementation(() => clock);

const settle = () => new Promise((r) => setTimeout(r, 0));
async function press(kind: "keydown" | "pointerdown" = "keydown") {
  pressing = true;
  window.dispatchEvent(new Event(kind));
  pressing = false;
  await settle();
}

/** A page just (re)loaded with these saved values, as the update banner's reload starts it: no touch yet. */
async function page(items: { spkId?: string; sounds?: boolean }) {
  localStorage.clear();
  localStorage.setItem("hq.prefs", JSON.stringify({ micOn: false, camOn: false, micId: "", camId: "", spkId: items.spkId ?? "" }));
  localStorage.setItem("hq.settings", JSON.stringify({ sounds: items.sounds ?? true }));
  vi.resetModules();
  const out = await import("../src/audioOut");
  const notify = await import("../src/notify");
  // waves come seconds apart (the server's cooldown), past chime's 400 ms burst guard
  const wave = async () => { clock += 2200; notify.chime("wave"); await settle(); };
  return { log: out.soundLog, wave };
}

beforeEach(() => { plays = 0; unplayable = false; });

test("refused before any touch; one key press lets the next cue play on the chosen speaker; later presses play nothing", async () => {
  const { log, wave } = await page({ spkId: "spk-1" });
  await wave();
  expect(log.at(-1), "before any touch the cue is refused and dropped").toEqual({ cue: "wave", result: "blocked", sink: "spk-1" });
  await press();
  await wave();
  expect(log.at(-1)).toEqual({ cue: "wave", result: "played", sink: "spk-1" });
  const before = plays;
  for (let i = 0; i < 3; i++) await press();
  expect(plays, "once every cue can play, key presses play nothing more").toBe(before);
});

test("with a speaker that is gone, after a pointer press, the cue plays on the default output", async () => {
  const { log, wave } = await page({ spkId: "gone-spk" });
  await press("pointerdown"); // a click on the map counts as much as a key
  await wave();
  expect(log.at(-1)).toEqual({ cue: "wave", result: "played", sink: "" });
});

test("cues the engine cannot play are tried once (5 players), not at every press", async () => {
  await page({});
  unplayable = true;
  await press();
  expect(plays).toBe(5);
  for (let i = 0; i < 5; i++) await press();
  expect(plays).toBe(5);
});

// last: with sounds off nothing settles, so this page's listeners stay
test("with sounds off, a wave plays nothing, and a key press prepares nothing either", async () => {
  const { log, wave } = await page({ sounds: false });
  await press();
  await wave();
  expect(log).toEqual([]);
  expect(plays).toBe(0);
});
