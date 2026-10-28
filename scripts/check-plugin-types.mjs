// Type-checks every plugin against plugins/sdk/*.d.ts: each tsconfig.json under plugins/ and
// e2e/fixtures/plugins/, found here rather than listed, so a new plugin (or a new folder of one) is
// checked without editing the gates. Git-ignored folders (a developer's plugins/installed/) are skipped.
// Run: node scripts/check-plugin-types.mjs  (part of scripts/gauntlet.sh and CI)
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const web = path.join(root, "web");
const configs = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", "plugins/**/tsconfig.json", "e2e/fixtures/plugins/**/tsconfig.json"],
  { cwd: root, encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean)
  .sort();

if (!configs.length) {
  console.log("no plugin tsconfig.json found");
  process.exit(1);
}
const win = process.platform === "win32";
let bad = 0;
for (const config of configs) {
  // pnpm is a .cmd shim on Windows, run through the shell: quote the path, which may hold spaces
  const project = path.join(root, config);
  const r = spawnSync("pnpm", ["exec", "tsc", "-p", win ? `"${project}"` : project], { cwd: web, encoding: "utf8", shell: win });
  const ok = r.status === 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${config}`);
  if (!ok) {
    process.stdout.write(r.error ? `tsc did not start: ${r.error.message}\n` : (r.stdout ?? "") + (r.stderr ?? ""));
    bad++;
  }
}
console.log(bad ? `${bad} of ${configs.length} plugin config(s) failed` : `${configs.length} plugin configs type-check`);
process.exit(bad ? 1 : 0);
