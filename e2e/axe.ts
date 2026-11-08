// The axe-core audits of the browser suites: a11y.ts (the platform's screens, contrast included) and the plugins' e2e
// projects (plugins/e2e/*, a plugin's own windows and views). Dialogs, panels and menus whose structure is all axe needs
// are audited on jsdom by the client's component tests, with the same TAGS (web/test/axe.ts; decision 0037). WCAG 2.1 A and AA rules plus axe best practices; this finds a
// subset of problems, it is not a substitute for testing with a screen reader (see docs/status.md).
import fs from "node:fs";
import { createRequire } from "node:module";
import type { Frame, Page } from "puppeteer-core";
import { check } from "./lib.ts";

/** axe-core, once AXE has been evaluated in a page or a frame. */
type AxeWindow = { axe: typeof import("axe-core") };

const require = createRequire(import.meta.url);
/** axe-core's source, evaluated in a page or a frame to install window.axe. */
export const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
export const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/** Audits the page (or the element `context` selects in it) and checks it has no violation. */
export async function audit(page: Page, label: string, context?: string) {
  await page.evaluate(AXE);
  const res = await page.evaluate(async (tags: string[], ctx: string | null) => {
    const r = await (window as unknown as AxeWindow).axe.run(ctx ?? document, { runOnly: { type: "tag", values: tags } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ") + " " + n.html.slice(0, 120) + " :: " + (n.failureSummary ?? "").split("\n").slice(1, 3).join(" ").slice(0, 200)), count: v.nodes.length }));
  }, TAGS, context ?? null);
  for (const v of res) console.log("  axe", v.impact, v.id, "x" + v.count, "-", v.help, "\n     ", v.nodes.join("\n      "));
  check("axe: no WCAG A/AA or best-practice violations on " + label, res.length === 0, res.map((v) => v.id).join(","));
}

/** Audits the document of a plugin's view (its iframe) and checks it has no violation. */
export async function auditView(frame: Frame, label: string) {
  await frame.evaluate(AXE);
  // axe run inside the frame takes it for a whole page: its page-level rules (one main landmark, one h1),
  // which axe applies to the top document only when it audits a page with its frames, are left out
  const res = await frame.evaluate(async (tags) => (await (window as unknown as AxeWindow).axe.run(document, { runOnly: { type: "tag", values: tags }, rules: { "landmark-one-main": { enabled: false }, "page-has-heading-one": { enabled: false } } })).violations.map((v) => v.id + " x" + v.nodes.length), TAGS);
  check("axe: no WCAG A/AA or best-practice violations inside " + label, res.length === 0, res.join(","));
}
