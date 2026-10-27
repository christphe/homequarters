// Oxlint with type-aware rules over the web client and the plugins (.oxlintrc.json).
// Run: node scripts/oxlint.mjs  (part of scripts/gauntlet.sh and CI); needs `pnpm install` in web/.
// It runs from the repository root so one config covers web/ and plugins/; the binaries live in
// web/node_modules/.bin, which goes on PATH so oxlint finds oxlint-tsgolint there.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "web", "node_modules", ".bin");
const trees = ["web/src", "web/test", "plugins", "e2e/fixtures/plugins"];
// a tree that moved would otherwise drop out of the lint without a word
const missing = trees.filter((t) => !fs.existsSync(path.join(root, t)));
if (missing.length) {
  console.log("oxlint: missing " + missing.join(", ") + " (update scripts/oxlint.mjs)");
  process.exit(1);
}
// the default format always ends with the file count (left alone, oxlint may pick a silent one)
const args = ["--type-aware", "--deny-warnings", "--format=default", ...trees, ...process.argv.slice(2)];
const r = spawnSync(process.execPath, [path.join(root, "web", "node_modules", "oxlint", "bin", "oxlint"), ...args], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
});
if (r.error) console.log("oxlint did not start: " + r.error.message);
process.exit(r.status ?? 1);
