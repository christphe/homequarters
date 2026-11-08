// Which trees scripts/oxlint.ts lints: the folders given (from the current folder), else all of them.
// Run: pnpm exec vitest run oxlint.test.ts  (scripts' test:unit)
import { test } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";
import { ALL_TREES, plan, projectOf } from "./oxlint.ts";
import { KNOWN, untyped } from "./oxlint-tsconfigs.ts";

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

test("the oxlint that runs is the calling project's: the nearest folder with it installed, else scripts'", () => {
  const installed = new Set([path.join(root, "web"), path.join(root, "plugins", "bundled", "hq-chess")]);
  const has = (d: string) => installed.has(d);
  assert.equal(projectOf(path.join(root, "web"), root, has), path.join(root, "web"));
  assert.equal(projectOf(path.join(root, "plugins", "bundled", "hq-chess", "public"), root, has), path.join(root, "plugins", "bundled", "hq-chess"));
  assert.equal(projectOf(root, root, has), path.join(root, "scripts"));
  assert.equal(projectOf(path.join(root, "docs"), root, has), path.join(root, "scripts"));
  assert.equal(projectOf(path.resolve("/elsewhere"), root, has), path.join(root, "scripts"));
});

test("every file Oxlint lints is in its nearest tsconfig.json's program, but the known ones", () => {
  // the type-aware rules type a file with that program; a file left out is linted against error types
  const found = untyped();
  assert.deepEqual(found.filter((f) => !(f.file in KNOWN)), []);
  // a known file that is typed now (or gone) leaves the list
  assert.deepEqual(Object.keys(KNOWN).filter((k) => !found.some((f) => f.file === k)), []);
}, 60_000);
