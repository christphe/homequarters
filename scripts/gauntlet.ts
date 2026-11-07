// The gauntlet's automatic gates, run by fdash (tools/fdash; fdash-workspace.json and each project's fdash.json). Usage:
//   node scripts/gauntlet.ts                  # static gates + the whole browser suite (CI viewport)
//   node scripts/gauntlet.ts social movement  # static gates + only these scenarios
//   GAUNTLET_SKIP_E2E=1 node scripts/gauntlet.ts
//   FDASH_JOBS=1 node scripts/gauntlet.ts     # static gates one at a time (default: half the logical CPUs)
//   E2E_PARALLELISM=2 node scripts/gauntlet.ts   # the browser suite as 2 shards at once (see e2e/parallel.mjs)
//   FDASH_FORCE=1 node scripts/gauntlet.ts    # rerun everything, even what already passed on the same inputs
// Gates and scenarios that already passed on the same inputs are reported CACHED and not run again
// (tools/fdash/README.md). Prints one line per gate and exits non-zero if any failed. The same lines go to
// .gauntlet/last-gates.log with the commit, a fingerprint of the working tree and the time, so critics can
// tell whether the gates ran on the code they review.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadWorkspace } from "../tools/fdash/workspace.ts";
import { parseArgs, printResult, resultLine } from "../tools/fdash/cli.ts";
import { run, type Result } from "../tools/fdash/run.ts";
import { fingerprint } from "./gauntlet-fingerprint.ts";

/** The browser suite's task (fdash-workspace.json, e2e/fdash.json); its scenarios are its items. */
export const BROWSER = "e2e:browser";

const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");

export function header(o: { commit: string; tree: string; started: Date; scenarios: string[] }): string {
  return `gates for: commit ${o.commit}, tree ${o.tree}, started ${iso(o.started)}, scenarios: ${o.scenarios.join(" ") || "all"}`;
}

export function recordLines(results: Result[], skipE2e: boolean): string[] {
  return [...results.map(resultLine), ...(skipE2e ? ["SKIPPED e2e"] : [])];
}

export function closing(o: { fails: number; skipE2e: boolean; treeBefore: string; treeAfter: string; interrupted: boolean }): { lines: string[]; fails: number } {
  const lines: string[] = [];
  let fails = o.fails;
  if (o.interrupted) { lines.push("interrupted"); fails = Math.max(fails, 1); }
  else if (o.treeBefore !== o.treeAfter) { lines.push("FAIL working tree changed during gates; rerun on the final tree"); fails++; }
  lines.push(fails > 0 ? `GATES RED: ${fails} failed` : o.skipE2e ? "STATIC GATES GREEN; browser verification SKIPPED" : "GATES GREEN");
  return { lines, fails };
}

async function main(): Promise<number> {
  const root = path.resolve(import.meta.dirname, "..");
  const scenarios = process.argv.slice(2);
  const skipE2e = !!process.env.GAUNTLET_SKIP_E2E;
  let jobs: number;
  try {
    jobs = parseArgs(["run"], process.env, os.availableParallelism()).jobs;
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const config = loadWorkspace(root);
  fs.mkdirSync(path.join(root, ".gauntlet"), { recursive: true });
  const record = path.join(root, ".gauntlet", "last-gates.log");
  const treeBefore = fingerprint(root);
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
  fs.writeFileSync(record, header({ commit, tree: treeBefore, started: new Date(), scenarios }) + "\n");

  const ac = new AbortController();
  // Ctrl+C reaches the gates from the terminal (the browser suite stops its server and LiveKit itself)
  process.on("SIGINT", () => ac.abort());
  const t0 = Date.now();
  let staticEnd = t0;
  const { results, interrupted } = await run({
    root, config, names: ["default"], skip: skipE2e ? [BROWSER] : [], jobs, extraArgs: scenarios,
    force: !!process.env.FDASH_FORCE, signal: ac.signal,
    onResult: (r) => {
      if (!r.name.startsWith(BROWSER + ":")) staticEnd = Date.now();
      printResult(r);
    },
  });
  console.log(`# static gates: ${secs(staticEnd - t0)}`);
  if (skipE2e) console.log("SKIPPED e2e");
  const treeAfter = fingerprint(root);
  const end = closing({ fails: results.filter((r) => !r.ok).length, skipE2e, treeBefore, treeAfter, interrupted });
  fs.appendFileSync(record, [...recordLines(results, skipE2e), ...end.lines, `finished ${iso(new Date())}`].join("\n") + "\n");
  console.log("\n" + end.lines.join("\n"));
  return interrupted ? 130 : end.fails > 0 ? 1 : 0;
}

function secs(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

if (import.meta.main) process.exitCode = await main();
