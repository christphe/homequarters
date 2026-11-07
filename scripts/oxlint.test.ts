// Which trees scripts/oxlint.ts lints: the folders given (from the current folder), else all of them.
// Run: node --test scripts/oxlint.test.ts  (scripts' test:unit)
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ALL_TREES, plan } from "./oxlint.ts";

const root = path.resolve("/repo");

test("without a folder, every tree; options go to oxlint", () => {
  assert.deepEqual(plan([], root, root), { trees: ALL_TREES, options: [] });
  assert.deepEqual(plan(["--fix"], path.join(root, "web"), root), { trees: ALL_TREES, options: ["--fix"] });
});

test("folders are read from the current folder and given from the root", () => {
  assert.deepEqual(plan(["src", "test"], path.join(root, "web"), root).trees, ["web/src", "web/test"]);
  assert.deepEqual(plan(["."], path.join(root, "plugins", "bundled", "hq-chess"), root).trees, ["plugins/bundled/hq-chess"]);
  assert.deepEqual(plan(["ui", "src-tauri/src"], path.join(root, "desktop"), root).trees, ["desktop/ui", "desktop/src-tauri/src"]);
});

test("a folder outside the repository is refused", () => {
  assert.throws(() => plan([".."], root, root), /outside the repository/);
});
