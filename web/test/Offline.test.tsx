// @vitest-environment jsdom
// Component test of the panels' requests failing on the network (fetch rejecting, as when the connection drops): each
// says what failed and leaves no unhandled rejection. The administration dialog's tabs (Members, Invites, Activity,
// Office > Rename, Announce, Plugins' on/off) and the map editor opening. The Settings dialog's own (Save profile,
// Create a sign-in link) are in SettingsDialog.test.tsx. The browser keeps one bundle-level check of the same path
// through the real page and its aborted request: the map editor's Save, in e2e/scenarios/offline.ts.
import { offlineFetch, onCleanup, renderUI, stubFetch, unhandledRejections } from "./support"; // first: canvas before PixiJS
import { mockSession } from "./support/session";
import { screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { MapData } from "../src/net/protocol";
import { getState } from "../src/store";
import { AdminDialog } from "../src/ui/AdminDialog";
import { MapEditor } from "../src/ui/MapEditor";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());

const tick = () => new Promise((r) => setTimeout(r, 0));
const MEMBERS = { json: { you: 1, members: [{ id: 1, name: "Ada", role: "admin", joinedAt: 1_794_000_000 }] } };

/** A route that fails on the network, as offlineFetch does for every request. */
const drop = () => Promise.reject(new TypeError("Failed to fetch"));

/** The toast once it says `text`, then no unhandled rejection after the failed request. */
async function says(text: string, rejections: unknown[]) {
  await waitFor(() => expect(getState().toast).toBe(text));
  await tick();
  expect(rejections).toEqual([]);
}

it.each([
  ["Members", "GET /api/admin/members"],
  ["Invites", "GET /api/admin/invites"],
  ["Activity", "GET /api/admin/audit"],
])("Admin > %s with no network: \"Something went wrong.\"", async (tab, request) => {
  const rejections = unhandledRejections();
  const net = offlineFetch();
  const { user } = renderUI(<AdminDialog onClose={() => {}} />);
  if (tab !== "Members") await user.click(screen.getByRole("tab", { name: tab }));
  await says("Something went wrong.", rejections);
  expect(net.requests.map((r) => `${r.method} ${r.path}`)).toContain(request);
  screen.getByRole("status"); // still loading, nothing shown as if it were empty
});

it("Admin > Office > Rename with no network: \"Something went wrong.\", the name typed kept", async () => {
  const rejections = unhandledRejections();
  stubFetch({ "GET /api/admin/members": MEMBERS, "GET /api/admin/templates": { json: { templates: [] } }, "PATCH /api/admin/office": drop });
  const { user } = renderUI(<AdminDialog onClose={() => {}} />, { office: "Harbour" });
  await user.click(screen.getByRole("tab", { name: "Office" }));
  const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Office name" });
  await user.type(field, " 2");
  await user.click(screen.getByRole("button", { name: "Rename" }));
  await says("Something went wrong.", rejections);
  expect(field.value).toBe("Harbour 2");
});

it("Admin > Announce with no network: \"Something went wrong.\", the message kept", async () => {
  const rejections = unhandledRejections();
  const net = stubFetch({ "GET /api/admin/members": MEMBERS, "POST /api/admin/announce": drop });
  const { user } = renderUI(<AdminDialog onClose={() => {}} />);
  await user.click(screen.getByRole("tab", { name: "Announce" }));
  const text = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message to everybody online" });
  await user.type(text, "Back in five");
  await user.click(screen.getByRole("button", { name: "Announce" }));
  await says("Something went wrong.", rejections);
  expect(net.requests.at(-1)?.body).toEqual({ text: "Back in five" });
  expect(text.value).toBe("Back in five");
});

it("Admin > Plugins, turning one on with no network: \"<plugin> could not start: Something went wrong.\"", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); // the tab reloads its list every 3 s
  onCleanup(() => vi.useRealTimers());
  const rejections = unhandledRejections();
  stubFetch({
    "GET /api/admin/members": MEMBERS,
    "GET /api/admin/plugins": { json: [{ name: "hq-pets", title: "Pets", version: "1.0.0", description: "", state: "disabled", error: "", source: "bundled", refused: false }] },
    "PUT /api/admin/plugins/*": drop,
  });
  const { user } = renderUI(<AdminDialog onClose={() => {}} />);
  await user.click(screen.getByRole("tab", { name: "Plugins" }));
  await user.click(await screen.findByRole("button", { name: "Turn on Pets" }));
  await says("Pets could not start: Something went wrong.", rejections);
});

it("the map editor opening with no network says it could not load the map, and leaves no unhandled rejection", async () => {
  const rejections = unhandledRejections();
  const map: MapData = { version: 1, tile: 16, w: 4, h: 3, walls: ["....", "....", "...."], solid: [], props: [], areas: [], spawn: { x: 1, y: 1 } };
  mockSession().view!.currentMap.mockReturnValue(map);
  const net = offlineFetch();
  renderUI(<MapEditor onClose={() => {}} />);
  await says("Could not load the editable map. Close the editor and try again.", rejections);
  expect(net.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/admin/map"]);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true); // nothing to save over the server's map
});

