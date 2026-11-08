// @vitest-environment jsdom
// The turn-off after a conversation wired to the store and the two settings (web/src/media/autoOffState.ts):
// what the media bar shows and the next call starts with (prefs.micOn, prefs.camOn). The timing rules
// themselves are in autoOff.test.ts; the browser suite (autooff) keeps the real dialog, the bar and a call.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

type Store = typeof import("../src/store");
type State = typeof import("../src/media/autoOffState");

// A fresh page: the store reads localStorage as it loads, the turn-off starts once per page.
async function page(settings: { autoMuteMic: boolean; autoCamOff: boolean } | null) {
  localStorage.clear();
  // a browser that saved its settings before the two existed gets the defaults
  localStorage.setItem("hq.settings", JSON.stringify({ eco: false, sounds: true, minimap: true, ...settings }));
  localStorage.setItem("hq.prefs", JSON.stringify({ micOn: true, camOn: true, micId: "", camId: "", spkId: "" }));
  vi.resetModules();
  const store: Store = await import("../src/store");
  const off: State = await import("../src/media/autoOffState");
  off.startAutoOff();
  const call = (on: boolean) => store.setState({ conv: on ? { kind: "p", name: "", members: [1, 2], state: "live" } : null });
  const bar = () => ({ mic: store.getState().prefs.micOn, cam: store.getState().prefs.camOn });
  return { store, off, call, bar };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test("the grace is 15 s outside tests", async () => {
  const { off } = await page(null);
  expect(off.autoOff.grace).toBe(15_000);
});

test("by default, after the grace the camera is off and the microphone untouched", async () => {
  const { store, call, bar } = await page(null);
  expect(store.getState().settings).toMatchObject({ autoMuteMic: false, autoCamOff: true });
  call(true);
  call(false);
  vi.advanceTimersByTime(15_000 - 1);
  expect(bar(), "during the grace the camera is still on").toEqual({ mic: true, cam: true });
  vi.advanceTimersByTime(1);
  expect(bar()).toEqual({ mic: true, cam: false });
});

test("with both settings, the microphone and the camera are off after the grace", async () => {
  const { call, bar } = await page({ autoMuteMic: true, autoCamOff: true });
  call(true);
  call(false);
  vi.advanceTimersByTime(15_000);
  expect(bar()).toEqual({ mic: false, cam: false });
});

test("a new conversation within the grace keeps the microphone and camera as they were", async () => {
  const { call, bar } = await page({ autoMuteMic: true, autoCamOff: true });
  call(true);
  call(false);
  vi.advanceTimersByTime(5_000);
  call(true);
  vi.advanceTimersByTime(60_000);
  expect(bar()).toEqual({ mic: true, cam: true });
});
