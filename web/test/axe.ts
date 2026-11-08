// axe-core in component tests (files on jsdom: `// @vitest-environment jsdom`). The same rule set as the browser
// suite's audits (TAGS in e2e/axe.ts: WCAG 2.1 A and AA plus axe best practices), run on what a test rendered.
// What jsdom cannot evaluate stays in the browser (e2e/scenarios/a11y.ts): colour contrast needs the page's real
// colours, fonts and layout, which jsdom does not compute. Page-level rules (one main landmark, one h1, the
// document's language and title) do not run here: axe applies them only when it audits a whole document, which the
// browser does on full screens.
import axe from "axe-core";
import { expect } from "vitest";

/** The tags of e2e/axe.ts. */
export const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/** Rules turned off in jsdom, each with why. */
const OFF: Record<string, { enabled: false }> = {
  // jsdom computes no layout and applies no stylesheet: contrast is audited in the browser
  "color-contrast": { enabled: false },
};

/** The violations axe finds in `root` (the rendered container, by default the whole body), one line each. */
export async function axeViolations(root: Element = document.body): Promise<string[]> {
  // iframes: false, axe checks the <iframe> element itself (its title) but does not audit inside it: in jsdom it
  // cannot reach a frame's window ("Respondable target must be a frame in the current window"); what a frame shows is
  // audited in the browser (auditView in e2e/axe.ts)
  const r = await axe.run(root, { runOnly: { type: "tag", values: TAGS }, rules: OFF, iframes: false });
  return r.violations.map((v) => `${v.id} x${v.nodes.length} (${v.help}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

/** Fails the test with axe's findings when `root` has any violation. */
export async function expectNoAxeViolations(root: Element = document.body) {
  expect(await axeViolations(root)).toEqual([]);
}
