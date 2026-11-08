// @vitest-environment jsdom
// The run keys on the map (game/input.ts): Shift runs while held, R toggles "always run". It replaces the browser
// check "Shift held while walking runs too" (movement); what running does to my speed is web/test/localPlayer.test.ts,
// and LocalPlayer's Shift-inverts-always-run rule web/test/layers.test.ts. The browser keeps the HUD's run button
// pressed for real before the movement scenario's jitter checks.
import { afterEach, expect, test, vi } from "vitest";
import { InputController } from "../src/game/input";
import type { ViewContext } from "../src/game/layer";
import type { LocalPlayer } from "../src/game/localPlayer";

let input: InputController | null = null;
afterEach(() => { input?.destroy(); input = null; });

function setup() {
  const player = { setDirection: vi.fn(), setRunHeld: vi.fn(), toggleRun: vi.fn() };
  const ctx = { app: { canvas: document.createElement("canvas"), screen: { width: 800, height: 450 } }, map: null } as unknown as ViewContext;
  const view = { goTo: vi.fn(), zoomBy: vi.fn(), interact: vi.fn(), screenToTile: vi.fn() };
  input = new InputController(ctx, player as unknown as LocalPlayer, {} as never, view);
  input.init();
  return player;
}
const key = (type: "keydown" | "keyup", key: string, code: string, shiftKey = false) =>
  window.dispatchEvent(new KeyboardEvent(type, { key, code, shiftKey, bubbles: true }));

test("Shift held runs, released walks again, and still walks with the arrow held meanwhile", () => {
  const player = setup();
  key("keydown", "ArrowRight", "ArrowRight");
  key("keydown", "Shift", "ShiftLeft", true);
  expect(player.setRunHeld.mock.calls).toEqual([[true]]);
  key("keyup", "Shift", "ShiftLeft");
  expect(player.setRunHeld.mock.calls).toEqual([[true], [false]]);
  expect(player.setDirection.mock.calls.at(-1)).toEqual([1, 0]);
});

test("R toggles always-run once per press", () => {
  const player = setup();
  key("keydown", "r", "KeyR");
  key("keyup", "r", "KeyR");
  expect(player.toggleRun).toHaveBeenCalledTimes(1);
});
