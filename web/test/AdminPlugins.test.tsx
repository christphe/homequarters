// @vitest-environment jsdom
// Component test of Administration > Plugins (Plugins in web/src/ui/AdminDialog.tsx) through Testing Library: what each
// row of the server's list shows. The server's side (an installed hq- plugin refused, with the rule) is
// TestPluginNameRefusalNoRoutes in server/internal/httpapi/plugins_test.go; turning a plugin on through its switch
// stays in the browser suite (e2e/scenarios/plugins.ts).
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Plugins } from "../src/ui/AdminDialog";

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

async function show() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(LIST), { status: 200, headers: { "Content-Type": "application/json" } })));
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
