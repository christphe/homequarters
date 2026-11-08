// @vitest-environment jsdom
// Keyboard shortcuts on the map (game/input.ts) follow key positions, not the characters a layout types:
// what InputController asks of the player and the session for real KeyboardEvents on the window.
import { afterEach, expect, test, vi } from "vitest";
import { InputController } from "../src/game/input";
import type { ViewContext } from "../src/game/layer";
import type { LocalPlayer } from "../src/game/localPlayer";
import { DANCE } from "../src/game/emotes";

let input: InputController | null = null;
afterEach(() => { input?.destroy(); input = null; });

function setup() {
  const player = { setDirection: vi.fn(), setRunHeld: vi.fn(), toggleRun: vi.fn() };
  const hooks = { onEmote: vi.fn(), onHand: vi.fn(), onHome: vi.fn(), onBusy: vi.fn() };
  const ctx = { app: { canvas: document.createElement("canvas"), screen: { width: 800, height: 450 } }, map: null } as unknown as ViewContext;
  const view = { goTo: vi.fn(), zoomBy: vi.fn(), interact: vi.fn(), screenToTile: vi.fn() };
  input = new InputController(ctx, player as unknown as LocalPlayer, hooks as never, view);
  input.init();
  return { player, hooks };
}
const key = (type: "keydown" | "keyup", key: string, code: string) => window.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true }));

test("the digit row sends reactions whatever character the layout types there (AZERTY: & on Digit1)", () => {
  const { hooks, player } = setup();
  key("keydown", "&", "Digit1");
  key("keyup", "&", "Digit1");
  expect(hooks.onEmote.mock.calls).toEqual([[1]]);
  expect(player.setDirection).not.toHaveBeenCalled();
});

test("the key at the W position (Z on AZERTY) walks up and does not dance", () => {
  const { hooks, player } = setup();
  key("keydown", "z", "KeyW");
  expect(player.setDirection.mock.calls.at(-1)).toEqual([0, -1]);
  key("keyup", "z", "KeyW");
  expect(player.setDirection.mock.calls.at(-1)).toEqual([0, 0]);
  expect(hooks.onEmote).not.toHaveBeenCalledWith(DANCE);
  expect(hooks.onEmote).not.toHaveBeenCalled();
});

test("the keypad without Num Lock (it types arrows) still walks", () => {
  const { hooks, player } = setup();
  key("keydown", "ArrowUp", "Numpad8");
  expect(player.setDirection.mock.calls.at(-1)).toEqual([0, -1]);
  key("keyup", "ArrowUp", "Numpad8");
  expect(player.setDirection.mock.calls.at(-1)).toEqual([0, 0]);
  expect(hooks.onEmote).not.toHaveBeenCalled();
});
