// @vitest-environment jsdom
// Component test of the administration dialog (web/src/ui/AdminDialog.tsx): axe finds no violation in its Members,
// Invites and Activity tabs, each loading, empty and filled, with the states a click opens (a removal to confirm, a
// new invite link). The server's answers are stubbed. Contrast stays in the browser: e2e/scenarios/a11y.ts audits the
// dialog on its Members tab, whose table, tabs, buttons and muted text use the same styles as the other tabs. The
// admin actions through the real dialog against the server are the `admin` scenario. The Plugins tab is
// AdminPlugins.test.tsx.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, vi } from "vitest";
import { t } from "../src/i18n";
import { setState } from "../src/store";
import { AdminDialog } from "../src/ui/AdminDialog";
import { expectNoAxeViolations } from "./axe";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setState({ auth: { providers: [], signup: null, link: null } });
});

const now = 1_794_000_000;
const MEMBERS = {
  you: 1,
  members: [
    { id: 1, name: "Ada", role: "admin", joinedAt: now - 86400, email: "ada@example.org" },
    { id: 2, name: "Bo", role: "member", joinedAt: now - 3600 },
  ],
};
const INVITES = {
  invites: [
    { id: 1, role: "member", maxUses: 10, uses: 2, expiresAt: now + 86400, createdAt: now - 60, createdBy: "Ada", status: "active" },
    { id: 2, role: "admin", maxUses: 1, uses: 0, expiresAt: now + 3600, createdAt: now - 120, createdBy: "Ada", status: "revoked" },
    { id: 3, role: "member", maxUses: 1, uses: 1, expiresAt: now - 3600, createdAt: now - 7200, createdBy: "Ada", status: "exhausted" },
  ],
};
const AUDIT = {
  entries: [
    { id: 3, actor: "Ada", action: "member.role", target: "Bo", detail: "admin", at: now - 30 },
    { id: 2, actor: "Ada", action: "invite.create", target: "", detail: "member", at: now - 60 },
    { id: 1, actor: "Ada", action: "something.new", target: "", detail: "", at: now - 90 }, // no text for it: shown raw
  ],
};

/** The server's answers by path; `pending` paths never answer (the tab stays on "Loading"). */
function server(answers: Record<string, unknown>, pending: string[] = []) {
  vi.stubGlobal("fetch", vi.fn((path: string) => {
    if (pending.includes(path)) return new Promise(() => {});
    const body = answers[path];
    return Promise.resolve(body === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  }));
}

/** The dialog, on one of its tabs (Members is the one it opens on). */
async function open(tab: "members" | "invites" | "activity") {
  const user = userEvent.setup();
  render(<AdminDialog onClose={() => {}} />);
  if (tab !== "members") await user.click(screen.getByRole("tab", { name: t(`admin.tab.${tab}`) }));
  return user;
}

describe("administration dialog", () => {
  it("Members, loading: no axe violation", async () => {
    server({}, ["/api/admin/members"]);
    await open("members");
    await screen.findByRole("status");
    await expectNoAxeViolations();
  });

  it("Members, listed with sign-in accounts, a removal to confirm: no axe violation", async () => {
    setState({ auth: { providers: ["google"], signup: null, link: null } });
    server({ "/api/admin/members": MEMBERS });
    const user = await open("members");
    await user.click(await screen.findByRole("button", { name: t("admin.removeOf", { name: "Bo" }) }));
    screen.getByRole("button", { name: t("admin.confirmRemove") });
    await expectNoAxeViolations();
  });

  it("Invites, loading: no axe violation", async () => {
    server({}, ["/api/admin/invites"]);
    await open("invites");
    await screen.findByRole("status");
    await expectNoAxeViolations();
  });

  it("Invites, none yet: no axe violation", async () => {
    server({ "/api/admin/invites": { invites: [] } });
    await open("invites");
    await screen.findByText(t("admin.noInvites"));
    await expectNoAxeViolations();
  });

  it("Invites, listed (active, revoked, used up) with a new link: no axe violation", async () => {
    server({ "/api/admin/invites": INVITES, "/api/invites": { path: "/?invite=abc" } });
    const user = await open("invites");
    await screen.findByRole("table", { name: t("admin.tab.invites") });
    await user.click(screen.getByRole("button", { name: t("invite.create") }));
    await screen.findByDisplayValue(location.origin + "/?invite=abc"); // its name is axe's to check
    await expectNoAxeViolations();
  });

  it("Activity, loading: no axe violation", async () => {
    server({}, ["/api/admin/audit"]);
    await open("activity");
    await screen.findByRole("status");
    await expectNoAxeViolations();
  });

  it("Activity, empty: no axe violation", async () => {
    server({ "/api/admin/audit": { entries: [] } });
    await open("activity");
    await screen.findByText(t("admin.noActivity"));
    await expectNoAxeViolations();
  });

  it("Activity, listed: no axe violation", async () => {
    server({ "/api/admin/audit": AUDIT });
    await open("activity");
    await screen.findByRole("list", { name: t("admin.tab.activity") });
    await expectNoAxeViolations();
  });
});
