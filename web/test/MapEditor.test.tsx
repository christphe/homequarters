// @vitest-environment jsdom
// Component test of the admin map editor (web/src/ui/MapEditor.tsx) on a fake session, its world view answering the
// Loft (web/dev/default-map.json) and a tile per screen pixel: the objects offered (a desk, never a pc alone), a room
// drawn by dragging, named, given its access and created, then saved as one PUT /api/map; the eraser takes a desk
// with its pc; a refused save is explained and keeps the edit unsaved. The rules behind them are unit tests
// (web/test/mapModel.test.ts, web/test/deskPC.test.ts), the server's side of a save is TestPutMapIsAdminOnlyValidatedLiveAndSurvivesARestart
// (httpapi/editor_test.go) and TestAnEditedMapAppliesItsNewWallsAndRoomsAtOnce (world/editor_test.go). The browser
// keeps the editor through its real controls on the real map: walls painted with the mouse and saved
// (e2e/scenarios/editor.ts), a private office assigned (offices.ts), a desk erased and the change drawn at once (depth.ts).
import { renderUI, stubFetch } from "./support";
import { mockSession } from "./support/session";
import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { t } from "../src/i18n";
import type { MapData } from "../src/net/protocol";
import { getState } from "../src/store";
import { MapEditor } from "../src/ui/MapEditor";
import loft from "../dev/default-map.json" with { type: "json" };

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());

const LOFT = loft as unknown as MapData;

beforeEach(() => {
  const view = mockSession().view!;
  view.currentMap.mockReturnValue(structuredClone(LOFT));
  view.screenToTile.mockImplementation((x: number, y: number) => [x, y]); // a tile per pixel
  // jsdom has no pointer capture
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {};
});

/** The editor open on the Loft, the server answering the editable map and the save with `save`. */
async function editor(save: { status?: number; json?: unknown } = { json: {} }) {
  const server = stubFetch({ "GET /api/admin/map": { json: structuredClone(LOFT) }, "PUT /api/map": save });
  const ui = renderUI(<MapEditor onClose={() => {}} />);
  const saveButton = screen.getByRole("button", { name: t("editor.save") }) as HTMLButtonElement;
  const layer = ui.container.querySelector<HTMLElement>(".editor-layer")!;
  await vi.waitFor(() => expect(server.requests.some((r) => r.path === "/api/admin/map")).toBe(true));
  await act(() => new Promise((r) => setTimeout(r, 0))); // its answer becomes the draft
  const at = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1 });
  /** Pointer down on `from`, through every tile on the way (as a mouse goes), up on `to`. */
  const drag = (from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(layer, at(...from));
    const n = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]));
    for (let i = 1; i <= n; i++) fireEvent.pointerMove(layer, at(Math.round(from[0] + ((to[0] - from[0]) * i) / n), Math.round(from[1] + ((to[1] - from[1]) * i) / n)));
    fireEvent.pointerUp(layer, at(...to));
  };
  const click = (x: number, y: number) => { fireEvent.pointerDown(layer, at(x, y)); fireEvent.pointerUp(layer, at(x, y)); };
  const saved = () => server.requests.filter((r) => r.method === "PUT").map((r) => r.body as MapData);
  return { ...ui, server, saveButton, drag, click, saved };
}

const previewed = () => mockSession().view!.previewMap.mock.lastCall![0];

it("offers a desk among the objects, never a pc on its own (a desk without one draws its screen)", async () => {
  const { user } = await editor();
  await user.click(screen.getByRole("button", { name: t("editor.tool.prop") }));
  const offered = [...screen.getByLabelText(t("editor.object")).querySelectorAll("option")].map((o) => o.value);
  expect(offered).toContain("desk");
  expect(offered).not.toContain("pc");
});

it("a room dragged, named and given its access is created, previewed, and saved in one PUT", async () => {
  const { user, drag, saveButton, saved } = await editor();
  await user.click(screen.getByRole("button", { name: t("editor.tool.room") }));
  drag([14, 28], [19, 32]);
  await user.type(screen.getByPlaceholderText(t("editor.roomName")), "Test room");
  await user.selectOptions(screen.getByLabelText(t("editor.access")), "admins");
  await user.click(screen.getByRole("button", { name: t("editor.createRoom") }));
  const room = { id: "test-room", name: "Test room", kind: "room", x: 14, y: 28, w: 6, h: 5, access: { mode: "admins" } };
  expect(previewed().areas).toContainEqual(expect.objectContaining(room)); // shown at once, before the save
  expect(saved()).toEqual([]);

  await user.click(saveButton);
  expect(saved()).toHaveLength(1);
  expect(saved()[0].areas).toContainEqual(expect.objectContaining(room));
  expect(saved()[0].areas).toHaveLength(LOFT.areas.length + 1);
  expect(saved()[0]).not.toHaveProperty("solid"); // the wire form: the server computes what is solid
  expect(getState().toast).toBe(t("editor.saved"));
  expect(saveButton.disabled).toBe(true);
});

it("one click of the eraser on a desk's pc takes the desk and its pc", async () => {
  const { user, click } = await editor();
  const desk = LOFT.props.find((p) => p.t === "desk" && !p.up)!;
  await user.click(screen.getByRole("button", { name: t("editor.tool.erase") }));
  click(desk.x, desk.y);
  const after = previewed().props;
  expect(after.some((p) => p.t === "desk" && p.x === desk.x && p.y === desk.y)).toBe(false);
  expect(after.filter((p) => p.t === "pc")).toHaveLength(LOFT.props.filter((p) => p.t === "pc").length - 1);
  expect(after.filter((p) => p.t === "desk")).toHaveLength(LOFT.props.filter((p) => p.t === "desk").length - 1);
});

it("a save the server refuses says why and keeps the edit to save again", async () => {
  const { drag, user, saveButton } = await editor({ status: 422, json: { error: "spawn is inside a wall" } });
  drag([35, 20], [35, 24]); // the default tool: walls
  expect([20, 21, 22, 23, 24].every((y) => previewed().walls[y][35] === "#")).toBe(true);
  await user.click(saveButton);
  expect(getState().toast).toBe(`${t("editor.saveError")}: spawn is inside a wall`);
  expect(saveButton.disabled).toBe(false);
});
