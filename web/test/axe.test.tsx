// @vitest-environment jsdom
// The axe helper of the component tests (web/test/axe.ts) finds known defects, so a test asserting no violation cannot
// pass because axe audited nothing; and it runs the browser suite's tags (e2e/axe.ts), so the two tiers check the
// same rules.
import fs from "node:fs";
import path from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { axeViolations, TAGS } from "./axe";

afterEach(cleanup);

it("reports an unnamed button, an li outside a list, an untitled frame and an image without alt", async () => {
  render(
    <div role="dialog" aria-modal="true" aria-label="Defects">
      <button />
      <div><li>stray</li></div>
      <iframe src="https://example.org/" sandbox="" />
      <img src="https://example.org/a.png" />
    </div>,
  );
  const ids = (await axeViolations()).map((v) => v.split(" ")[0]).sort();
  expect(ids).toEqual(["button-name", "frame-title", "image-alt", "listitem"]);
});

it("does not report colour contrast, which only the browser can measure", async () => {
  render(<div role="dialog" aria-modal="true" aria-label="Pale"><p style={{ color: "#eee", background: "#fff" }}>pale text</p></div>);
  expect(await axeViolations()).toEqual([]);
});

it("runs the same tags as the browser suite's audits", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "../../e2e/axe.ts"), "utf8");
  const m = /export const TAGS = (\[[^\]]*\])/.exec(src);
  expect(m && JSON.parse(m[1])).toEqual(TAGS);
});
