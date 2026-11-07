// fdash's command line. Usage: node cli.ts run [task ...] [--pkg project]... [--skip task]... [--jobs N] [--force] [-- extra args]
//                                node cli.ts list [--pkg project]...
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_FILE, expand, localName, type Config } from "./config.ts";
import { findRoot, load, select, WORKSPACE_FILE } from "./workspace.ts";
import { run, type Result } from "./run.ts";

export const USAGE = `usage: fdash run [task ...] [--pkg project]... [--skip task]... [--jobs N] [--force] [-- extra args]
       fdash list [--pkg project]...
Runs the tasks of ${WORKSPACE_FILE} and its projects' ${CONFIG_FILE}, or of a single ${CONFIG_FILE} (the task "default" when none is named).
A project's task (test:unit) runs in every project defining it; --pkg restricts it to the projects named. FDASH_JOBS sets --jobs;
FDASH_CACHE_DIR moves the cache (default .fdash/cache at the root); FDASH_LOG_DIR keeps the
commands' logs in that folder instead of a temporary one.`;

export type Args = { cmd: "run" | "list" | "help"; tasks: string[]; skip: string[]; pkgs: string[]; jobs: number; force: boolean; extra: string[] };

function positive(v: string | undefined, what: string): number {
  if (v === undefined || !/^[1-9]\d*$/.test(v)) throw new Error(`${what} must be a positive integer, got ${JSON.stringify(v ?? "")}`);
  return Number(v);
}

export function parseArgs(argv: string[], env: Record<string, string | undefined>, cpus: number): Args {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) throw new Error(USAGE);
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return { cmd: "help", tasks: [], skip: [], pkgs: [], jobs: 1, force: false, extra: [] };
  if (cmd !== "run" && cmd !== "list") throw new Error(`unknown command ${cmd}\n${USAGE}`);
  const out: Args = { cmd, tasks: [], skip: [], pkgs: [], jobs: Math.max(1, Math.floor(cpus / 2)), force: false, extra: [] };
  if (env.FDASH_JOBS !== undefined) out.jobs = positive(env.FDASH_JOBS, "FDASH_JOBS");
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") { out.extra = rest.slice(i + 1); break; }
    if (a === "--jobs") out.jobs = positive(rest[++i], "--jobs");
    else if (a.startsWith("--jobs=")) out.jobs = positive(a.slice(7), "--jobs");
    else if (a === "--skip") { const s = rest[++i]; if (!s) throw new Error("--skip needs a task name"); out.skip.push(s); }
    else if (a === "--pkg" || a.startsWith("--pkg=")) {
      const p = a === "--pkg" ? rest[++i] : a.slice(6);
      if (!p || p.startsWith("-")) throw new Error("--pkg needs a project name");
      out.pkgs.push(p);
    }
    else if (a === "--force") out.force = true;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}\n${USAGE}`);
    else out.tasks.push(a);
  }
  if (cmd === "list" && (out.tasks.length || out.skip.length || out.extra.length || out.force || rest.some((a) => a.startsWith("--jobs")))) throw new Error("list takes no arguments but --pkg");
  if (out.tasks.length === 0) out.tasks = ["default"];
  return out;
}

export function resultLine(r: Result): string {
  if (r.failedAfter) return `FAIL ${r.name} (after ${r.failedAfter} failed)`;
  return r.cached ? `CACHED ${r.name}` : r.ok ? `PASS ${r.name}` : `FAIL ${r.name} (log: ${r.log})`;
}

/** The last `n` lines of a log, each indented by 5 spaces. */
export function tail(text: string, n = 15): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").slice(-n).map((l) => "     " + l).join("\n");
}

/** The tasks, in file order; only those of `pkgs` when some are named. */
export function listLines(config: Config, pkgs: string[] = []): string[] {
  if (pkgs.length) select(config, [], pkgs); // refuses a project that does not exist
  return [...config.values()].filter((t) => pkgs.length === 0 || (t.project !== undefined && pkgs.includes(t.project))).map((t) => t.kind === "command" ? t.name : `${t.name}: ${t.tasks.join(", ")}${t.jobs ? ` (jobs ${t.jobs})` : ""}`);
}

export { findRoot };

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

/** The tasks the names of the command line stand for; a name that is none is refused, with how to run it when
 * it names an item. */
export function resolveNames(config: Config, names: string[], pkgs: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    let found: string[];
    try {
      found = select(config, [n], pkgs);
    } catch (e) {
      const at = n.lastIndexOf(":");
      const owner = n.slice(0, at), item = n.slice(at + 1);
      if (at > 0 && [...config.values()].some((t) => t.kind === "command" && localName(t) === owner && t.items?.has(item))) {
        throw new Error(`${n} is an item: run ${owner} -- ${item}`, { cause: e });
      }
      const msg = (e as Error).message;
      throw new Error(msg === `no task named ${n}` ? `${msg} (fdash list shows them)` : msg, { cause: e });
    }
    for (const f of found) if (!out.includes(f)) out.push(f);
  }
  return out;
}

async function main(): Promise<number> {
  let args: Args, root: string, config: Config, names: string[], skip: string[];
  try {
    args = parseArgs(process.argv.slice(2), process.env, os.availableParallelism());
    if (args.cmd === "help") {
      console.log(USAGE);
      return 0;
    }
    root = findRoot(process.cwd());
    config = load(root);
    if (args.cmd === "list") {
      for (const l of listLines(config, args.pkgs)) console.log(l);
      return 0;
    }
    names = resolveNames(config, args.tasks, args.pkgs);
    // --skip leaves a task out wherever it appears, whatever --pkg restricts
    skip = resolveNames(config, args.skip, []);
    // extra arguments only go to commands with "args": true; given to none, they would be dropped silently
    if (args.extra.length && !expand(config, names, skip).some((c) => c.args)) {
      throw new Error(`${args.tasks.join(", ")} takes no extra arguments (only commands with "args": true do)`);
    }
  } catch (e) {
    console.error("fdash: " + (e as Error).message);
    return 2;
  }
  const ac = new AbortController();
  // Ctrl+C reaches the children from the terminal; fdash only stops starting new tasks
  process.on("SIGINT", () => ac.abort());
  // one folder per run inside FDASH_LOG_DIR: two runs given the same folder must not share report files
  const logDir = process.env.FDASH_LOG_DIR ? (fs.mkdirSync(process.env.FDASH_LOG_DIR, { recursive: true }), fs.mkdtempSync(path.join(process.env.FDASH_LOG_DIR, "run-"))) : undefined;
  const { results, interrupted } = await run({ root, config, logDir, names, skip, jobs: args.jobs, extraArgs: args.extra, force: args.force, signal: ac.signal, onResult: printResult });
  if (interrupted) {
    console.log("fdash: interrupted");
    return 130;
  }
  return results.some((r) => !r.ok) ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
