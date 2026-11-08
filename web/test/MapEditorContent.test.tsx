// @vitest-environment jsdom
// Component test of the office editor's "Edit content" tool (web/src/ui/MapEditor.tsx), with the session and fetch
// faked: the world map hides what a note says, so the editor loads the full map (GET /api/admin/map) and shows the
// note's text, and an edit is saved with the map (PUT /api/map). It replaces the browser checks "editor restores hidden
// content before editing" and "saved note edits are delivered through the real interaction" (features); the server's
// half is httpapi TestPutMapIsAdminOnlyValidatedLiveAndSurvivesARestart, TestBoardStrokesAndNoteEditsSurviveAGracefulRestart
// and world TestObjectContentIsHiddenFromTheMapAndServedOnlyNextToTheObject. The browser keeps painting walls and
// saving through the editor's real controls (e2e/scenarios/editor.ts) and opening a note with X (features).
import { renderUI, stubFetch } from "./support"; // first: its canvas is in place before PixiJS loads
import { mockSession } from "./support/session";
import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { t } from "../src/i18n";
import type { MapData } from "../src/net/protocol";
import { getState } from "../src/store";
import { MapEditor } from "../src/ui/MapEditor";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());

const NOTE = "Welcome to Home Quarters!";
/** A 6x4 office with a plant and a note at (4, 2), as the world map has it: the note's text left out. */
const world = (): MapData => ({
  version: 1, tile: 16, w: 6, h: 4, spawn: { x: 1, y: 1 },
  walls: ["......", "......", "......", "......"], solid: ["000000", "000000", "000000", "000000"],
  props: [{ t: "plant", x: 1, y: 1 }, { t: "note", x: 4, y: 2, label: "Welcome" }],
  areas: [],
});

it("Edit content shows a note's hidden text from the full map, and Save sends the edit with the map", async () => {
  mockSession().view!.currentMap.mockReturnValue(world());
  const full = world();
  full.props[1].data = NOTE;
  const api = stubFetch({ "GET /api/admin/map": { json: full }, "PUT /api/map": { json: {} } });
  const { user } = renderUI(<MapEditor onClose={() => {}} />, { role: "admin" });
  await user.click(screen.getByRole("button", { name: t("editor.tool.content") }));
  const pick = await screen.findByRole("combobox", { name: t("editor.objectPick") });
  await user.selectOptions(pick, screen.getByRole("option", { name: "Welcome (4, 2)" }));
  const text = screen.getByRole("textbox", { name: t("editor.objectData") });
  expect((text as HTMLTextAreaElement).value).toBe(NOTE);

  fireEvent.change(text, { target: { value: "A saved team note" } });
  await user.click(screen.getByRole("button", { name: t("editor.applyContent") }));
  await user.click(screen.getByRole("button", { name: t("editor.save") }));
  await vi.waitFor(() => expect(getState().toast).toBe(t("editor.saved")));
  const put = api.requests.find((r) => r.method === "PUT")!;
  expect((put.body as MapData).props).toEqual([{ t: "plant", x: 1, y: 1 }, { t: "note", x: 4, y: 2, label: "Welcome", data: "A saved team note" }]);
}, 20000); // jsdom on a loaded machine (the gauntlet runs everything at once) can take seconds
