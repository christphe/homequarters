// Oxlint's type-aware rules type a file with the program of its nearest tsconfig.json. A file that program does
// not include is linted without types: every value is an error type, so the rules that need types (promises,
// no-unsafe-*, strict-boolean-expressions...) say nothing true about it. This lists the files Oxlint lints that
// their nearest tsconfig.json leaves out; scripts/oxlint.test.ts fails on any but KNOWN (whose rules that need
// types are turned off in .oxlintrc.json's first override).
// Run: node scripts/oxlint-tsconfigs.ts   (from anywhere; needs `pnpm install` at the root)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ALL_TREES } from "./oxlint.ts";

const root = path.resolve(import.meta.dirname, "..");

/** Linted files no tsconfig.json program can hold, and why. */
export const KNOWN: Record<string, string> = {
  "web/src/plugins/sdk.js": "plain JavaScript inlined into plugin iframes; checked by web/tsconfig.sdk.json",
  "web/src/plugins/viewSdk.js": "plain JavaScript inlined into plugin iframes; checked by web/tsconfig.sdk.json",
  "plugins/bundled/hq-cards/test/fixtures/free/main.js": "a JavaScript fixture plugin",
  "plugins/bundled/hq-cards/test/fixtures/partgame/main.js": "a JavaScript fixture plugin",
  "plugins/bundled/hq-cards/test/fixtures/widegame/main.js": "a JavaScript fixture plugin",
  "e2e/fixtures/plugins/installed/hq-impostor/main.ts": "a fixture plugin that pretends to be bundled; it has no tsconfig of its own",
  "plugins/bundled/hq-card-lastcard/vitest.config.ts": "beside the plugin's server program (tsconfig.json), type-checked by tsconfig.test.json",
  "plugins/bundled/hq-card-pouilleux/vitest.config.ts": "beside the plugin's server program (tsconfig.json), type-checked by tsconfig.test.json",
  "plugins/bundled/hq-cards/vitest.config.ts": "beside the plugin's server program (tsconfig.json), type-checked by tsconfig.test.json",
  "plugins/bundled/hq-chess/vitest.config.ts": "beside the plugin's server program (tsconfig.json), type-checked by tsconfig.test.json",
  "plugins/bundled/hq-pets/vitest.config.ts": "beside the plugin's server program (tsconfig.json), type-checked by tsconfig.test.json",
};
const LINTED = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

/** Files git tracks (or would add) under the trees, as root-relative paths with "/". */
function trackedFiles(trees: string[]): string[] {
  const r = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "--", ...trees], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error("git ls-files failed: " + r.stderr);
  return r.stdout.split("\n").filter((f) => LINTED.test(f) && !f.endsWith(".d.ts") && !/(^|\/)(node_modules|dist)\//.test(f) && !f.startsWith("plugins/installed/"));
}

/** The nearest tsconfig.json from a file's folder up to the root, or null. */
export function nearestTsconfig(file: string, exists: (p: string) => boolean): string | null {
  for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
    const c = dir === "." ? "tsconfig.json" : dir + "/tsconfig.json";
    if (exists(c)) return c;
    if (dir === ".") return null;
  }
}

/** The files a tsconfig's program holds (tsc --listFilesOnly), root-relative. */
function programFiles(tsconfig: string): Set<string> {
  const cwd = path.join(root, path.dirname(tsconfig));
  // the TypeScript of the project the tsconfig belongs to (each declares its own), else the scripts project's
  let dir = cwd;
  while (!fs.existsSync(path.join(dir, "node_modules", ".bin")) && dir !== root) dir = path.dirname(dir);
  if (dir === root) dir = path.join(root, "scripts");
  const tsc = path.join(dir, "node_modules", "typescript", "bin", "tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", path.join(root, tsconfig), "--listFilesOnly"], { cwd, encoding: "utf8" });
  return new Set(r.stdout.split(/\r?\n/).filter(Boolean).map((f) => path.relative(root, path.resolve(cwd, f)).split(path.sep).join("/")));
}

export function untyped(): { file: string; tsconfig: string | null }[] {
  const out: { file: string; tsconfig: string | null }[] = [];
  const programs = new Map<string, Set<string>>();
  for (const file of trackedFiles(ALL_TREES)) {
    const cfg = nearestTsconfig(file, (p) => fs.existsSync(path.join(root, p)));
    if (!cfg) {
      out.push({ file, tsconfig: null });
      continue;
    }
    let files = programs.get(cfg);
    if (!files) programs.set(cfg, (files = programFiles(cfg)));
    if (!files.has(file)) out.push({ file, tsconfig: cfg });
  }
  return out;
}

if (import.meta.main) {
  const bad = untyped().filter((b) => !(b.file in KNOWN));
  for (const b of bad) console.log(`${b.file}: ${b.tsconfig ? "not in " + b.tsconfig : "no tsconfig.json above it"}`);
  console.log(bad.length ? `${bad.length} linted file(s) without types` : "every linted file is in its nearest tsconfig.json");
  process.exitCode = bad.length ? 1 : 0;
}
