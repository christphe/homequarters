// @vitest-environment jsdom
// The mouse on the map (game/input.ts) with a real Camera (game/camera.ts): Ctrl+wheel zoom steps and left-drag
// panning, driven by DOM wheel and pointer events on the canvas as Chrome sends them. The browser keeps one
// Ctrl+wheel zoom and one left-drag through Chrome's real mouse (e2e/scenarios/presence.ts).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InputController } from "../src/game/input";
import { Camera } from "../src/game/camera";
import type { ViewContext } from "../src/game/layer";
import type { LocalPlayer } from "../src/game/localPlayer";

const W = 800, H = 450; // E2E_VIEWPORT=small, CI's viewport
const MAP_W = 60 * 16, MAP_H = 40 * 16;
const ME = { x: 30 * 16, y: 20 * 16 }; // the middle of the map: no edge in the way of a pan

let input: InputController | null = null;
let now = 1000;
beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  input?.destroy();
  input = null;
  document.body.style.userSelect = "";
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function setup() {
  const canvas = document.createElement("canvas");
  const capture = vi.fn<(id: number) => void>();
  canvas.setPointerCapture = capture; // jsdom has none
  document.body.append(canvas);
  const cam = new Camera({ read: () => 0, write: () => {} });
  cam.setInterest(128, 2, 8);
  cam.fit(W, H);
  const ctx = { app: { canvas, screen: { width: W, height: H } }, cam, dirty: false, map: { w: MAP_W / 16, h: MAP_H / 16 } } as unknown as ViewContext;
  const self = { x: ME.x, y: ME.y, ox: 0, oy: 0 };
  const player = { self, setDirection: vi.fn(), setRunHeld: vi.fn(), toggleRun: vi.fn() };
  const view = {
    goTo: vi.fn(),
    zoomBy: vi.fn((steps: number) => cam.zoomBy(steps, W, H)),
    interact: vi.fn(),
    screenToTile: vi.fn((): [number, number] => [3, 4]),
  };
  input = new InputController(ctx, player as unknown as LocalPlayer, {} as never, view);
  input.init();
  /** What the next frame does: place the camera following me (WorldView.frame). */
  const frame = () => { cam.follow(W, H, self.x + self.ox, self.y + self.oy, MAP_W, MAP_H); return { x: cam.x, y: cam.y }; };
  frame();
  return { canvas, cam, view, frame, capture };
}

const wheel = (c: HTMLCanvasElement, deltaY: number, o: WheelEventInit = {}) => {
  const e = new WheelEvent("wheel", { deltaY, clientX: 400, clientY: 225, bubbles: true, cancelable: true, ...o });
  c.dispatchEvent(e);
  return e;
};
const pointer = (c: HTMLCanvasElement, type: string, x: number, y: number, buttons = 1) =>
  c.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons, clientX: x, clientY: y, bubbles: true, cancelable: true }));
/**
 * A left-button drag from (x0, y0) to (x1, y1) in `steps` moves, a frame after each as the ticker draws them,
 * released at the end unless `release` is false.
 */
function drag(c: HTMLCanvasElement, frame: () => unknown, x0: number, y0: number, x1: number, y1: number, steps = 8, release = true) {
  pointer(c, "pointerdown", x0, y0);
  for (let i = 1; i <= steps; i++) { pointer(c, "pointermove", x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); frame(); }
  if (release) pointer(c, "pointerup", x1, y1, 0);
}

// ---- Ctrl+wheel

test("the plain mouse wheel does not zoom the map, and leaves the page to scroll", () => {
  const { canvas, view } = setup();
  const e = wheel(canvas, -100);
  expect(view.zoomBy).not.toHaveBeenCalled();
  expect(e.defaultPrevented).toBe(false);
});

test("Ctrl+wheel (Cmd+wheel on a Mac): one notch, however small, is one whole zoom step, and not the browser's page zoom", () => {
  const { canvas, view, cam } = setup();
  const s0 = cam.S;
  const e = wheel(canvas, -33, { ctrlKey: true }); // a mouse sending 33 px per notch
  expect(e.defaultPrevented).toBe(true);
  expect(view.zoomBy.mock.calls).toEqual([[1]]);
  expect(cam.S).toBe(s0 + 1);
  now += 200;
  wheel(canvas, 400, { metaKey: true }); // a big notch out is still one step
  expect(view.zoomBy.mock.calls.at(-1)).toEqual([-1]);
  expect(cam.S).toBe(s0);
});

test("one wheel notch in line mode (Firefox: 3 lines) is one zoom step", () => {
  const { canvas, view } = setup();
  wheel(canvas, -3, { ctrlKey: true, deltaMode: WheelEvent.DOM_DELTA_LINE });
  expect(view.zoomBy.mock.calls).toEqual([[1]]);
});

test("a trackpad or a free-spinning wheel takes at most one step per 120 ms", () => {
  const { canvas, view } = setup();
  wheel(canvas, 10, { ctrlKey: true });
  now += 50;
  wheel(canvas, 10, { ctrlKey: true });
  expect(view.zoomBy).toHaveBeenCalledTimes(1);
  now += 120;
  wheel(canvas, 10, { ctrlKey: true });
  expect(view.zoomBy).toHaveBeenCalledTimes(2);
});

test("zooming out with Ctrl+wheel stops at the limit the server's largest radius allows", () => {
  const { canvas, cam } = setup();
  const [lo] = cam.range(W, H);
  for (let i = 0; i < 12; i++) { wheel(canvas, 33, { ctrlKey: true }); now += 150; }
  expect(cam.S).toBe(lo);
  expect(lo).toBeLessThan(2);
});

test("Ctrl+wheel does nothing while a dialog is open", () => {
  const { canvas, view } = setup();
  document.body.append(Object.assign(document.createElement("div"), { className: "scrim" }));
  wheel(canvas, -100, { ctrlKey: true });
  expect(view.zoomBy).not.toHaveBeenCalled();
});

// ---- left-drag

test("dragging the map with the left button moves the view the same way, 1:1, and ends with the cursor and text selection back", () => {
  const { canvas, frame, capture } = setup();
  const c0 = frame();
  drag(canvas, frame, 400, 225, 250, 145, 8, false);
  expect(canvas.style.cursor).toBe("grabbing");
  expect(document.body.style.userSelect).toBe("none");
  expect(capture).toHaveBeenCalledWith(1);
  pointer(canvas, "pointerup", 250, 145, 0);
  const c1 = frame();
  expect([c1.x - c0.x, c1.y - c0.y]).toEqual([-150, -80]);
  expect(canvas.style.cursor).toBe("");
  expect(document.body.style.userSelect).toBe("");
});

test("a press that barely moves is a click, not a drag", () => {
  const { canvas, frame, capture } = setup();
  const c0 = frame();
  drag(canvas, frame, 400, 225, 402, 226, 1);
  expect(frame()).toEqual(c0);
  expect(capture).not.toHaveBeenCalled();
  expect(canvas.style.cursor).toBe("");
});

test("a press released off the map before it became a drag leaves no drag behind: hovering afterwards does not pan", () => {
  const { canvas, frame } = setup();
  const c0 = frame();
  pointer(canvas, "pointerdown", 400, 40);
  pointer(canvas, "pointermove", 400, 38); // still a click when it leaves for the top bar, where it is released
  pointer(canvas, "pointermove", 380, 225, 0); // back over the map, no button held
  for (let x = 360; x >= 300; x -= 20) pointer(canvas, "pointermove", x, 225, 0);
  expect(frame()).toEqual(c0);
  expect(canvas.style.cursor).not.toBe("grabbing");
  expect(input!.pressed).toBe(false);
});

test("a double-click right after a drag does not send me running; later it does", () => {
  const { canvas, view, frame } = setup();
  drag(canvas, frame, 400, 225, 250, 145);
  const dbl = () => canvas.dispatchEvent(new MouseEvent("dblclick", { clientX: 250, clientY: 145, bubbles: true }));
  now += 300;
  dbl();
  expect(view.goTo).not.toHaveBeenCalled();
  now += 300;
  dbl();
  expect(view.goTo.mock.calls).toEqual([[3, 4]]);
});

test("zooming with Ctrl+wheel during a drag keeps the drag 1:1 at the new scale", () => {
  const { canvas, cam, frame } = setup();
  drag(canvas, frame, 400, 225, 460, 225, 4, false);
  const s0 = cam.S;
  wheel(canvas, -100, { ctrlKey: true, clientX: 460, clientY: 225 });
  expect(cam.S).toBe(s0 + 1);
  const mid = frame(); // the frame after the zoom places the camera
  pointer(canvas, "pointermove", 475, 225);
  pointer(canvas, "pointermove", 490, 225);
  const c3 = frame();
  pointer(canvas, "pointerup", 490, 225, 0);
  expect(c3.x - mid.x).toBe(30);
  expect(c3.y).toBe(mid.y);
});

test("a drag ends when the window loses the focus or the pointer is cancelled", () => {
  const { canvas, frame } = setup();
  drag(canvas, frame, 400, 225, 300, 225, 4, false);
  window.dispatchEvent(new Event("blur"));
  expect(input!.pressed).toBe(false);
  expect(canvas.style.cursor).toBe("");
  drag(canvas, frame, 400, 225, 300, 225, 4, false);
  canvas.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, pointerType: "mouse" }));
  expect(input!.pressed).toBe(false);
  expect(document.body.style.userSelect).toBe("");
});

test("touch keeps the browser's own gestures: a finger never pans the map", () => {
  const { canvas, frame } = setup();
  const c0 = frame();
  canvas.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, pointerType: "touch", button: 0, buttons: 1, clientX: 400, clientY: 225 }));
  canvas.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, pointerType: "touch", buttons: 1, clientX: 200, clientY: 225 }));
  expect(frame()).toEqual(c0);
});

test("dragged toward the office's west wall, the view stops with the wall's edge in the middle of the screen, never beyond", () => {
  const { canvas, cam, frame } = setup();
  for (let i = 0; i < 6; i++) { drag(canvas, frame, 100, 225, 700, 225); frame(); } // 6 x 600 px at scale 2: far past the wall
  expect((W / 2 - cam.x) / cam.S).toBe(0);
});
