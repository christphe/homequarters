// @vitest-environment jsdom
// Component test of the administration dialog's Members, Invites and Activity tabs (web/src/ui/AdminDialog.tsx) and of
// the top bar's Admin button: what each tab shows, the request each control sends and what it says back, with the
// server's answers stubbed. The rules behind them are Go tests: roles, removal and the last-admin guard
// (TestRoleChangeRemovalAndTheLastAdminGuard), who may call the admin API (TestAdminEndpointsRequireTheAdminRole), the
// invite lifecycle and that a list never holds an invite's secret (TestInviteLifecycleThroughTheAPI), the audit trail
// (TestAuditTrailOrderAndPruning). The browser keeps one round trip of each through the real dialog, in
// e2e/scenarios/admin.ts: a role change reaching the online member, an invite created, a member removed and told why.
// Axe audits of these tabs are AdminDialog.test.tsx; the tabs failing on the network are Offline.test.tsx.
import { renderUI, stubFetch } from "./support"; // first: canvas before PixiJS
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { getState } from "../src/store";
import { AdminButton, AdminDialog } from "../src/ui/AdminDialog";

const now = 1_794_000_000;
const ADA = { id: 1, name: "Ada", role: "admin", joinedAt: now - 86400 };
const BO = { id: 2, name: "Bo", role: "member", joinedAt: now - 3600 };
const members = (...rows: object[]) => ({ json: { you: 1, members: rows } });
// the dialog opens on Members: the other tabs' tests answer its list too
const OPENS = { "GET /api/admin/members": members(ADA, BO) };
const show = (patch = {}) => renderUI(<AdminDialog onClose={() => {}} />, patch);
const sent = (net: { requests: { method: string; path: string; body: unknown }[] }) => net.requests.filter((r) => r.method !== "GET").map((r) => [r.method + " " + r.path, r.body]);

it("the top bar offers Admin to an administrator only", () => {
  const { unmount } = renderUI(<AdminButton onOpen={() => {}} />, { role: "member" });
  expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
  unmount();
  renderUI(<AdminButton onOpen={() => {}} />, { role: "admin" });
  screen.getByRole("button", { name: "Admin" });
});

it("Members lists everybody, marks me, and offers no Remove on my own row", async () => {
  stubFetch({ "GET /api/admin/members": members(ADA, BO) });
  show();
  const table = await screen.findByRole("table", { name: "Members" });
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows.map((r) => r.querySelector("td")?.textContent)).toEqual(["Ada (you)", "Bo"]);
  expect(within(rows[0]!).queryByRole("button")).toBeNull();
  within(rows[1]!).getByRole("button", { name: "Remove Bo" });
});

it("choosing a role sends it, says so and reloads the list", async () => {
  let promoted = false;
  const net = stubFetch({
    "GET /api/admin/members": () => members(ADA, { ...BO, role: promoted ? "admin" : "member" }),
    "PATCH /api/admin/members/2": () => { promoted = true; return { status: 200 }; },
  });
  const { user } = show();
  await user.selectOptions(await screen.findByRole("combobox", { name: "Role of Bo" }), "admin");
  await waitFor(() => expect(getState().toast).toBe("Role of Bo updated"));
  expect(sent(net)).toEqual([["PATCH /api/admin/members/2", { role: "admin" }]]);
  await waitFor(() => expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Role of Bo" }).value).toBe("admin"));
});

it("a role the server refuses shows its reason (the last administrator)", async () => {
  stubFetch({
    "GET /api/admin/members": members(ADA, BO),
    "PATCH /api/admin/members/1": { status: 409, json: { error: "an office needs an administrator" } },
  });
  const { user } = show();
  await user.selectOptions(await screen.findByRole("combobox", { name: "Role of Ada" }), "member");
  await waitFor(() => expect(getState().toast).toBe("an office needs an administrator"));
});

it("Remove asks to confirm, then removes and says so; Cancel removes nobody", async () => {
  let gone = false;
  const net = stubFetch({
    "GET /api/admin/members": () => (gone ? members(ADA) : members(ADA, BO)),
    "DELETE /api/admin/members/2": () => { gone = true; return { status: 200 }; },
  });
  const { user } = show();
  await user.click(await screen.findByRole("button", { name: "Remove Bo" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(sent(net)).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Remove Bo" }));
  await user.click(screen.getByRole("button", { name: "Confirm removal" }));
  await waitFor(() => expect(getState().toast).toBe("Bo was removed"));
  expect(sent(net)).toEqual([["DELETE /api/admin/members/2", undefined]]);
  await waitFor(() => expect(screen.queryByText("Bo")).toBeNull());
});

it("with sign-in on, Members says who signs in with which account and who has not yet", async () => {
  stubFetch({ "GET /api/admin/members": members({ ...ADA, email: "ada@acme.test" }, BO) });
  show({ auth: { providers: ["fake-oidc"], signup: null, link: null } });
  await screen.findByText("Signs in as ada@acme.test");
  screen.getByText("Has not signed in yet");
});

it("without sign-in, Members names no account", async () => {
  stubFetch({ "GET /api/admin/members": members({ ...ADA, email: "ada@acme.test" }, BO) });
  show();
  await screen.findByRole("table", { name: "Members" });
  expect(screen.queryByText(/Signs in as|Has not signed in yet/)).toBeNull();
});

it("Create invite link sends the role, uses and hours chosen and shows the link once, outside the list", async () => {
  let made = false;
  const net = stubFetch({
    ...OPENS,
    "GET /api/admin/invites": () => ({ json: { invites: made ? [{ id: 7, role: "admin", maxUses: 3, uses: 0, expiresAt: now + 7200, createdAt: now, createdBy: "Ada", status: "active" }] : [] } }),
    "POST /api/invites": () => { made = true; return { json: { path: "/?invite=s3cret-token", token: "s3cret-token" } }; },
  });
  const { user } = show();
  await user.click(screen.getByRole("tab", { name: "Invites" }));
  await screen.findByText("No invites yet.");
  await user.selectOptions(screen.getByRole("combobox", { name: "Role" }), "admin");
  // a number field clamps every keystroke (an empty field is 1): set the whole value at once
  fireEvent.change(screen.getByRole("spinbutton", { name: "Maximum uses" }), { target: { value: "3" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Valid for (hours)" }), { target: { value: "2" } });
  await user.click(screen.getByRole("button", { name: "Create invite link" }));
  const link = await screen.findByRole<HTMLInputElement>("textbox", { name: "Invite people" });
  expect(link.value).toBe(location.origin + "/?invite=s3cret-token");
  expect(sent(net)).toEqual([["POST /api/invites", { role: "admin", maxUses: 3, hours: 2 }]]);
  const table = await screen.findByRole("table", { name: "Invites" });
  expect(within(table).getAllByRole("row")[1]!.textContent).toContain("Active");
  expect(table.textContent).not.toContain("s3cret-token");
});

it("Revoke revokes that invite and says so", async () => {
  let revoked = false;
  const net = stubFetch({
    ...OPENS,
    "GET /api/admin/invites": () => ({ json: { invites: [{ id: 4, role: "member", maxUses: 10, uses: 1, expiresAt: now + 3600, createdAt: now - 60, createdBy: "Ada", status: revoked ? "revoked" : "active" }] } }),
    "DELETE /api/admin/invites/4": () => { revoked = true; return { status: 200 }; },
  });
  const { user } = show();
  await user.click(screen.getByRole("tab", { name: "Invites" }));
  await user.click(await screen.findByRole("button", { name: /^Revoke/ }));
  await waitFor(() => expect(getState().toast).toBe("Invite revoked"));
  expect(sent(net)).toEqual([["DELETE /api/admin/invites/4", undefined]]);
  await screen.findByText("Revoked");
  expect(screen.queryByRole("button", { name: /^Revoke/ })).toBeNull();
});

it("Activity tells role changes, invites and a rename by name, the rename with the old and the new name", async () => {
  stubFetch({ ...OPENS, "GET /api/admin/audit": { json: { entries: [
    { id: 4, actor: "Ada", action: "office.rename", target: "", detail: "Old HQ -> Harbour", at: now - 10 },
    { id: 3, actor: "Ada", action: "invite.revoke", target: "", detail: "", at: now - 20 },
    { id: 2, actor: "Ada", action: "invite.create", target: "", detail: "member", at: now - 30 },
    { id: 1, actor: "Ada", action: "member.role", target: "Bo", detail: "admin", at: now - 40 },
  ] } } });
  const { user } = show();
  await user.click(screen.getByRole("tab", { name: "Activity" }));
  const list = await screen.findByRole("list", { name: "Activity" });
  expect(within(list).getAllByRole("listitem").map((li) => li.textContent?.replace(/^.*?\d{1,2}:\d{2}\s*[AP]M /, ""))).toEqual([
    "Ada renamed the office (Old HQ -> Harbour)",
    "Ada revoked an invite",
    "Ada created an invite (member)",
    "Ada changed the role of Bo (admin)",
  ]);
});
