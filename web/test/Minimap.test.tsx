// @vitest-environment jsdom
// Component test of the minimap (web/src/ui/Minimap.tsx), with the session's world view faked: the head counts the
// server sends drawn per area (a desk room's counted in the area around it), a click running to that spot, and the
// M key showing and hiding it (not Shift+M: "?" on AZERTY). The browser keeps the minimap drawn from the real map,
// shown again with M, across pixel-ratio changes (e2e/scenarios/presence.ts); the counts themselves are the server's
// (world TestAreaHeadCountsArePublishedOnChangeOnly).
import { renderUI } from "./support"; // first: canvas before PixiJS
import { mockSession } from "./support/session";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorldView } from "../src/game/WorldView";
import type { Area, MapData } from "../src/net/protocol";
import { getState } from "../src/store";
import { Minimap } from "../src/ui/Minimap";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());

const area = (name: string, kind: string, x: number, y: number, w: number, h: number, auto = false) => ({ id: name, name, kind, x, y, w, h, auto }) as unknown as Area;
// 60 x 40 tiles: the minimap is 200 css px wide, so a tile is 200 / 60 px
const MAP = {
  w: 60, h: 40,
  areas: [area("Open space", "area", 0, 0, 30, 20), area("Pat's desk", "room", 4, 4, 3, 3, true), area("Horizon", "room", 40, 10, 10, 10)],
} as unknown as MapData;
const TILE = 200 / 60;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  const view = mockSession().view!;
  view.currentMap.mockReturnValue(MAP);
  view.mapImage.mockReturnValue(document.createElement("canvas"));
  view.position.mockReturnValue({ x: 10 * 16, y: 10 * 16 });
  // what the minimap reads besides the support's spies, typed by WorldView's own methods
  Object.assign(view, {
    debugEntities: vi.fn<WorldView["debugEntities"]>(() => []),
    destination: vi.fn<WorldView["destination"]>(() => null),
  });
});
afterEach(() => { vi.useRealTimers(); });

/** The texts drawn on the minimap's canvas at its next redraw (4 a second). */
function drawnTexts(canvas: HTMLCanvasElement) {
  const fillText = vi.spyOn(canvas.getContext("2d")!, "fillText");
  act(() => { vi.advanceTimersByTime(250); });
  return fillText.mock.calls.map(([text, x, y]) => ({ text, x: Math.round(x), y: Math.round(y) }));
}
const canvasOf = () => screen.getByRole<HTMLCanvasElement>("img", { name: /Click a spot to run there/ });

it("draws the server's head count in the middle of each area, a desk room's counted with the area around it", () => {
  renderUI(<Minimap />, { areaCounts: [2, 1, 3] });
  const mid = (a: Area) => ({ x: Math.round((a.x + a.w / 2) * TILE), y: Math.round((a.y + a.h / 2) * TILE + 0.5) }); // text drawn half a pixel low
  expect(drawnTexts(canvasOf())).toEqual([
    { text: "3", ...mid(MAP.areas[0]) },
    { text: "3", ...mid(MAP.areas[2]) },
  ]);
});

it("nobody anywhere: no count drawn", () => {
  renderUI(<Minimap />, { areaCounts: [0, 0, 0] });
  expect(drawnTexts(canvasOf())).toEqual([]);
});

it("clicking the minimap runs to that tile", () => {
  renderUI(<Minimap />);
  fireEvent.click(canvasOf(), { clientX: 4.5 * TILE, clientY: 30.5 * TILE });
  expect(mockSession().view!.goTo.mock.calls).toEqual([[4, 30]]);
});

const press = (code: string, key: string, o: KeyboardEventInit = {}) => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { code, key, bubbles: true, ...o })); });

it("M hides the minimap and shows it again, and the choice is saved", () => {
  renderUI(<Minimap />);
  press("KeyM", "m");
  expect(screen.queryByRole("region", { name: "Minimap" })).toBeNull();
  expect(getState().settings.minimap).toBe(false);
  press("KeyM", "m");
  screen.getByRole("region", { name: "Minimap" });
  expect((JSON.parse(localStorage.getItem("hq.settings")!) as { minimap: boolean }).minimap).toBe(true);
});

it("? typed on the M position (Shift on AZERTY) does not toggle the minimap, nor M in a text field or under a dialog", () => {
  renderUI(<Minimap />);
  press("KeyM", "?", { shiftKey: true });
  const field = document.body.appendChild(document.createElement("input"));
  act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", key: "m", bubbles: true })); });
  document.body.appendChild(Object.assign(document.createElement("div"), { className: "scrim" }));
  press("KeyM", "m");
  expect(getState().settings.minimap).toBe(true);
  document.querySelector(".scrim")!.remove();
  field.remove();
});
