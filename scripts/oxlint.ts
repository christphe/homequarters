// Oxlint with type-aware rules (.oxlintrc.json) over the folders given, or, without any, over every tree it
// covers: the web client, the plugins and the tooling (the browser suite, the scripts, fdash, the site
// generator and the desktop app's two plain JavaScript files).
// Run: node scripts/oxlint.ts [folder ...] [oxlint option ...]  Folders are relative to the current folder:
// each project's `lint` task runs it on its own folder (`node ../scripts/oxlint.ts src test` from web/).
// Needs `pnpm install` in web/. It runs from the repository root so one config covers every tree; the
// binaries live in web/node_modules/.bin, which goes on PATH so oxlint finds oxlint-tsgolint there.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "web", "node_modules", ".bin");
export const ALL_TREES = ["web/src", "web/test", "plugins", "e2e", "scripts", "tools/fdash", "site", "desktop/ui", "desktop/src-tauri/src"];

/** The trees to lint (relative to the root, "/" separated) and the options passed on to oxlint. */
export function plan(argv: string[], cwd: string, rootDir: string): { trees: string[]; options: string[] } {
  const given = argv.filter((a) => !a.startsWith("-"));
  const options = argv.filter((a) => a.startsWith("-"));
  const trees = given.length ? given.map((g) => path.relative(rootDir, path.resolve(cwd, g)).split(path.sep).join("/") || ".") : ALL_TREES;
  const outside = trees.filter((t) => t === ".." || t.startsWith("../") || path.isAbsolute(t));
  if (outside.length) throw new Error("oxlint: outside the repository: " + outside.join(", "));
  return { trees, options };
}

function main(): number {
  let p: ReturnType<typeof plan>;
  try {
    p = plan(process.argv.slice(2), process.cwd(), root);
  } catch (e) {
    console.log((e as Error).message);
    return 2;
  }
  // a tree that moved would otherwise drop out of the lint without a word
  const missing = p.trees.filter((t) => !fs.existsSync(path.join(root, t)));
  if (missing.length) {
    console.log("oxlint: missing " + missing.join(", ") + " (update the lint task or scripts/oxlint.ts)");
    return 1;
  }
  // the default format always ends with the file count (left alone, oxlint may pick a silent one)
  const args = ["--type-aware", "--deny-warnings", "--format=default", ...p.trees, ...p.options];
  const r = spawnSync(process.execPath, [path.join(root, "web", "node_modules", "oxlint", "bin", "oxlint"), ...args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
  });
  if (r.error) console.log("oxlint did not start: " + r.error.message);
  return r.status ?? 1;
}

if (import.meta.main) process.exitCode = main();
