// @vitest-environment jsdom
// Component test of Administration > Office (OfficeName and Layouts in web/src/ui/AdminDialog.tsx): the layouts the
// server offers, with what each holds and the one in use; switching asks first, saying the whole map is replaced and
// how many desks carry over, then asks the server and tells the administrator; a refusal is explained; the office
// name is renamed with its own form. The server's answers are stubbed. The server's side (admin only, desks carried
// over by number, the new spawn, the audit row, everybody told and reconnected) is
// TestAdminAppliesATemplateAndDesksCarryOver (httpapi/templates_test.go) and TestReplaceMapChangesSizeAndRespawnsEverybody
// (world/template_test.go); the row the activity log shows for it is the last test here. The browser keeps one switch through this tab's real controls, against the real server:
// e2e/scenarios/templates.ts (the member online gets the new map without a reload and walks past the old edge).
import { renderUI, stubFetch, type StubRequest } from "./support";
import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { t } from "../src/i18n";
import { getState } from "../src/store";
import { AdminDialog } from "../src/ui/AdminDialog";
import { expectNoAxeViolations } from "./axe";

const row = (id: string, name: string, w: number, h: number, desks: number, rooms: number, corners: number, current = false) =>
  ({ id, name, w, h, current, summary: { desks, rooms, corners, offices: id === "loft" ? 4 : 0 }, carry: { kept: 1, lost: 0 } });
/** What GET /api/admin/templates answers on the Loft with one desk assigned (as the browser suite's office). */
const TEMPLATES = { templates: [row("loft", "Loft", 60, 46, 18, 6, 0, true), row("manor", "Manor", 85, 51, 48, 10, 12), row("lodge", "Lodge", 77, 51, 36, 8, 6)] };

/** The dialog on its Office tab, the server answering `apply` to the switch. */
async function office(apply: (req: StubRequest) => { status?: number; json?: unknown } = () => ({ json: { carry: { kept: 1, lost: 0 } } })) {
  const server = stubFetch({
    "GET /api/admin/members": { json: { you: 1, members: [] } }, // the tab it opens on
    "GET /api/admin/templates": { json: TEMPLATES },
    "POST /api/admin/map/template": apply,
    "PATCH /api/admin/office": (req) => ({ json: { name: (req.body as { name: string }).name } }),
  });
  const ui = renderUI(<AdminDialog onClose={() => {}} />);
  await ui.user.click(screen.getByRole("tab", { name: t("admin.tab.office") }));
  const list = await screen.findByRole("list");
  return { ...ui, server, list };
}

it("lists the three layouts with what they offer, the one in use marked", async () => {
  const { list, container } = await office();
  const rows = within(list).getAllByRole("listitem").map((li) => li.textContent);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatch(/^Loft · in use18 desks · 6 rooms · 4 private offices · 60 × 46 tiles/);
  expect(rows[1]).toMatch(/^Manor48 desks · 10 rooms · 12 corners · 85 × 51 tiles/);
  expect(rows[2]).toMatch(/^Lodge36 desks/);
  // the layout in use offers a reset, the others a switch
  expect(screen.getByRole("button", { name: "Reset the Loft layout" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Use the Manor layout" })).toBeTruthy();
  await expectNoAxeViolations(container);
});

it("switching asks first, says the whole map is replaced and how many desks carry over, then switches", async () => {
  const { user, server } = await office();
  await user.click(screen.getByRole("button", { name: "Use the Manor layout" }));
  const dialog = screen.getByRole("dialog", { name: "Switch to Manor?" });
  expect(dialog.textContent).toContain("The whole map is replaced");
  expect(dialog.textContent).toContain("Desk assignments carry over by desk number: 1 kept.");
  expect(server.requests.some((r) => r.method === "POST")).toBe(false); // nothing switched before the confirmation
  await expectNoAxeViolations(dialog);

  await user.click(within(dialog).getByRole("button", { name: "Switch to Manor" }));
  expect(server.requests.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([{ template: "manor" }]);
  expect(getState().toast).toBe("The office now uses the Manor layout.");
  expect(screen.queryByRole("dialog", { name: "Switch to Manor?" })).toBeNull();
  expect(server.requests.filter((r) => r.path === "/api/admin/templates")).toHaveLength(2); // the list again, its new "in use"
});

it("a switch the server refuses is explained: too soon, or its own reason", async () => {
  let answer: { status: number; json: unknown } = { status: 429, json: {} };
  const { user } = await office(() => answer);
  await user.click(screen.getByRole("button", { name: "Use the Lodge layout" }));
  await user.click(screen.getByRole("button", { name: "Switch to Lodge" }));
  expect(getState().toast).toBe(t("layout.wait"));
  answer = { status: 400, json: { error: "unknown template" } };
  await user.click(screen.getByRole("button", { name: "Use the Lodge layout" }));
  await user.click(screen.getByRole("button", { name: "Switch to Lodge" }));
  expect(getState().toast).toBe("unknown template");
});

it("the activity log names a layout switch (the row the server writes for it)", async () => {
  stubFetch({
    "GET /api/admin/members": { json: { you: 1, members: [] } },
    "GET /api/admin/audit": { json: { entries: [{ id: 1, actor: "Ada", action: "map.template", target: "Manor", detail: "template=manor rev=2 kept=1 lost=0", at: 1_794_000_000 }] } },
  });
  const { user } = renderUI(<AdminDialog onClose={() => {}} />);
  await user.click(screen.getByRole("tab", { name: t("admin.tab.activity") }));
  const log = await screen.findByRole("list", { name: t("admin.tab.activity") });
  expect(log.textContent).toContain("Ada switched the office to the Manor layout (template=manor rev=2 kept=1 lost=0)");
});

it("renames the office with its own form", async () => {
  const { user, server } = await office();
  const name = screen.getByLabelText(t("office.nameLabel"));
  const rename = screen.getByRole("button", { name: t("office.save") });
  expect((rename as HTMLButtonElement).disabled).toBe(true); // the name in use: nothing to rename
  await user.clear(name);
  await user.type(name, "Night shift");
  await user.click(rename);
  expect(server.requests.filter((r) => r.method === "PATCH").map((r) => r.body)).toEqual([{ name: "Night shift" }]);
  expect(getState().toast).toBe(t("office.renamed"));
});
