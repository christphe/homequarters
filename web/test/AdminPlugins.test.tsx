// @vitest-environment jsdom
// Component test of Administration > Plugins (Plugins in web/src/ui/AdminDialog.tsx) through Testing Library: what each
// row of the server's list shows. The server's side (an installed hq- plugin refused, with the rule) is
// TestPluginNameRefusalNoRoutes in server/internal/httpapi/plugins_test.go; turning a plugin on through its switch
// stays in the browser suite (e2e/scenarios/plugins.ts).
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../src/i18n";
import { AdminDialog, Plugins } from "../src/ui/AdminDialog";
import { expectNoAxeViolations } from "./axe";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (o: Record<string, unknown>) => ({ version: "1.0.0", description: "", state: "disabled", error: "", refused: false, ...o });
/** What GET /api/admin/plugins answers in the browser suite's office, cut to one plugin of each kind. */
const LIST = [
  row({ name: "hq-pets", title: "Pets", source: "bundled" }),
  row({ name: "ui-demo", title: "UI demo", source: "installed", state: "running" }),
  row({ name: "hq-impostor", title: "Impostor", source: "installed", state: "broken", refused: true,
    error: 'the hq- prefix is reserved for plugins bundled with Home Quarters: rename the installed plugin "hq-impostor"' }),
];

async function show(list: unknown[] = LIST) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(list), { status: 200, headers: { "Content-Type": "application/json" } })));
  const { container } = render(<Plugins />);
  await screen.findByRole("table", { name: "Plugins" });
  const tr = (name: string) => container.querySelector<HTMLElement>(`tr[data-plugin="${name}"]`)!;
  return { tr };
}

it("every plugin row says where it comes from", async () => {
  const { tr } = await show();
  for (const [name, source] of [["hq-pets", "Bundled"], ["ui-demo", "Installed"], ["hq-impostor", "Installed"]]) {
    expect(tr(name).querySelector(".plugin-source")?.textContent).toBe(source);
  }
});

it("a bundled plugin that is off is listed as off, with its switch", async () => {
  const { tr } = await show();
  expect(tr("hq-pets").textContent).toContain("Off");
  within(tr("hq-pets")).getByRole("button", { name: "Turn on Pets" });
});

it("an installed plugin using hq- is listed as refused, with the rule, and has no switch", async () => {
  const { tr } = await show();
  const r = tr("hq-impostor");
  expect(r.textContent).toContain("Cannot run");
  expect(r.textContent).toContain("reserved for plugins bundled");
  expect(within(r).queryAllByRole("button")).toEqual([]);
});

// Accessibility (axe, web/test/axe.ts): the tab with no plugin, with every kind of row, and the two modals a row
// opens. Contrast stays in the browser: e2e/scenarios/a11y.ts audits the administration dialog (Members, the same
// table, buttons and muted text) and a plugin's own modal; changing a setting through the gear is the `plugins`
// scenario.
describe("axe", () => {
  /** A bundled plugin running, with settings (one with help) and a long description. */
  const PETS = row({ name: "hq-pets", title: "Pets", source: "bundled", state: "running", description: "Pets that follow their owner.",
    externalHosts: ["example.org"], longDescription: "Pick a pet on the join screen.\n\nIt follows you around.",
    settings: [{ key: "max", label: "Pets per person", min: 0, max: 3, value: 1, help: "0 turns pets off." }, { key: "speed", label: "Speed", min: 1, max: 5, value: 2 }] });

  /** The tab where people see it: the administration dialog (its Members tab, opened first, left loading), on Plugins. */
  async function inDialog(list: unknown[]) {
    vi.stubGlobal("fetch", vi.fn((path: string) => path === "/api/admin/plugins"
      ? Promise.resolve(new Response(JSON.stringify(list), { status: 200, headers: { "Content-Type": "application/json" } }))
      : new Promise(() => {})));
    const user = userEvent.setup();
    render(<AdminDialog onClose={() => {}} />);
    await user.click(screen.getByRole("tab", { name: t("admin.tab.plugins") }));
    if (list.length) await screen.findByRole("table", { name: t("admin.tab.plugins") });
    else await screen.findByText(t("admin.plugins.none"));
    return user;
  }

  it("no plugin: no axe violation", async () => {
    await inDialog([]);
    await expectNoAxeViolations();
  });

  it("every kind of row (off, running, refused, with settings, about and hosts): no axe violation", async () => {
    await inDialog([PETS, ...LIST.slice(1)]);
    await expectNoAxeViolations();
  });

  it("a plugin's settings: no axe violation", async () => {
    const user = await inDialog([PETS]);
    await user.click(screen.getByRole("button", { name: t("admin.plugins.settingsOf", { name: "Pets" }) }));
    screen.getByRole("dialog", { name: t("admin.plugins.settingsTitle", { name: "Pets" }) });
    await expectNoAxeViolations();
  });

  it("a plugin's About: no axe violation", async () => {
    const user = await inDialog([PETS]);
    await user.click(screen.getByRole("button", { name: t("admin.plugins.aboutOf", { name: "Pets" }) }));
    screen.getByRole("dialog", { name: "Pets" });
    await expectNoAxeViolations();
  });
});
