// fdash's command line. Usage: node cli.ts run [task ...] [--skip task]... [--jobs N] [--force] [-- extra args]
//                                node cli.ts list
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_FILE, loadConfig, type Config } from "./config.ts";
import { run, type Result } from "./run.ts";

export const USAGE = `usage: fdash run [task ...] [--skip task]... [--jobs N] [--force] [-- extra args]
       fdash list
Runs the tasks of ${CONFIG_FILE} (the task "default" when none is named). FDASH_JOBS sets --jobs;
FDASH_CACHE_DIR moves the cache (default .fdash/cache next to ${CONFIG_FILE}).`;

export type Args = { cmd: "run" | "list"; tasks: string[]; skip: string[]; jobs: number; force: boolean; extra: string[] };

function positive(v: string | undefined, what: string): number {
  if (v === undefined || !/^[1-9]\d*$/.test(v)) throw new Error(`${what} must be a positive integer, got ${JSON.stringify(v ?? "")}`);
  return Number(v);
}

export function parseArgs(argv: string[], env: Record<string, string | undefined>, cpus: number): Args {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) throw new Error(USAGE);
  if (cmd !== "run" && cmd !== "list") throw new Error(`unknown command ${cmd}\n${USAGE}`);
  const out: Args = { cmd, tasks: [], skip: [], jobs: Math.max(1, Math.floor(cpus / 2)), force: false, extra: [] };
  if (env.FDASH_JOBS !== undefined) out.jobs = positive(env.FDASH_JOBS, "FDASH_JOBS");
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") { out.extra = rest.slice(i + 1); break; }
    if (a === "--jobs") out.jobs = positive(rest[++i], "--jobs");
    else if (a.startsWith("--jobs=")) out.jobs = positive(a.slice(7), "--jobs");
    else if (a === "--skip") { const s = rest[++i]; if (!s) throw new Error("--skip needs a task name"); out.skip.push(s); }
    else if (a === "--force") out.force = true;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}\n${USAGE}`);
    else out.tasks.push(a);
  }
  if (out.tasks.length === 0) out.tasks = ["default"];
  return out;
}

export function resultLine(r: Result): string {
  return r.cached ? `CACHED ${r.name}` : r.ok ? `PASS ${r.name}` : `FAIL ${r.name} (log: ${r.log})`;
}

/** The last `n` lines of a log, each indented by 5 spaces. */
export function tail(text: string, n = 15): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").slice(-n).map((l) => "     " + l).join("\n");
}

export function listLines(config: Config): string[] {
  return [...config.values()].map((t) => t.kind === "command" ? t.name : `${t.name}: ${t.tasks.join(", ")}${t.jobs ? ` (jobs ${t.jobs})` : ""}`);
}

/** The nearest folder, from `dir` up, that holds fdash.json. */
export function findRoot(dir: string): string {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, CONFIG_FILE))) return d;
    if (path.dirname(d) === d) throw new Error(`no ${CONFIG_FILE} in ${dir} or above`);
  }
}

export function printResult(r: Result): void {
  console.log(resultLine(r));
  if (!r.ok && r.log) {
    try {
      console.log(tail(fs.readFileSync(r.log, "utf8")));
    } catch {
      // no log written
    }
  }
}

async function main(): Promise<number> {
  let args: Args, root: string, config: Config;
  try {
    args = parseArgs(process.argv.slice(2), process.env, os.availableParallelism());
    root = findRoot(process.cwd());
    config = loadConfig(root);
    if (args.cmd === "list") {
      for (const l of listLines(config)) console.log(l);
      return 0;
    }
    for (const n of [...args.tasks, ...args.skip]) if (!config.has(n)) throw new Error(`no task named ${n} in ${CONFIG_FILE}`);
  } catch (e) {
    console.error("fdash: " + (e as Error).message);
    return 2;
  }
  const ac = new AbortController();
  // Ctrl+C reaches the children from the terminal; fdash only stops starting new tasks
  process.on("SIGINT", () => ac.abort());
  const { results, interrupted } = await run({ root, config, names: args.tasks, skip: args.skip, jobs: args.jobs, extraArgs: args.extra, force: args.force, signal: ac.signal, onResult: printResult });
  if (interrupted) {
    console.log("fdash: interrupted");
    return 130;
  }
  return results.filter((r) => !r.ok).length;
}

if (import.meta.main) process.exitCode = await main();
