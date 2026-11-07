// Running tasks: a command's steps in sequence, a group's members `jobs` at once, each command once per run,
// and the cache (inputs, items, outputs) around commands that declare inputs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expand, type Command, type Config } from "./config.ts";
import { cacheKey, passed, recordPass, resolveInputs, resolveOutputs, restoreOutputs, signature, storeOutputs } from "./cache.ts";
import { launch, spawnSpec } from "./spawn.ts";

export { spawnSpec };

/** One line of the report: a command, or one item of a command (`<command>:<item>`). `failedAfter`: the
 * command was not run because this predecessor failed. `warn`: why a command that had passed ran again. */
export type Result = { name: string; ok: boolean; cached: boolean; log: string; ms: number; failedAfter?: string; warn?: string };

export type RunOptions = {
  root: string;
  config: Config;
  names: string[];
  skip?: string[];
  jobs: number;
  extraArgs?: string[];
  onResult?: (r: Result) => void;
  signal?: AbortSignal;
  logDir?: string;
  force?: boolean;
  cacheDir?: string;
};

function runStep(argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv; log: number; failOnOutput: boolean }): Promise<boolean> {
  const [cmd, ...rest] = argv;
  let l: ReturnType<typeof launch>;
  try {
    l = launch(cmd, rest);
  } catch (e) {
    fs.writeSync(o.log, `fdash: ${(e as Error).message}
`);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let printed = false;
    // settled once: a program that cannot start emits "error" and then "close", and the log file is closed
    // as soon as the step is settled, so nothing may be written after that
    let settled = false;
    const write = (s: string | Buffer) => { if (!settled) (typeof s === "string" ? fs.writeSync(o.log, s) : fs.writeSync(o.log, s)); };
    const settle = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    let child;
    try {
      child = spawn(l.file, l.args, { cwd: o.cwd, env: o.env, shell: l.shell, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      write(`fdash: cannot start ${cmd}: ${(e as Error).message}\n`);
      settle(false);
      return;
    }
    child.stdout.on("data", (d: Buffer) => { printed ||= d.length > 0; write(d); });
    child.stderr.on("data", (d: Buffer) => write(d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      write(`fdash: cannot start ${cmd} (${e.code ?? "error"}): ${e.message}\n`);
      settle(false);
    });
    child.on("close", (code: number | null, signal: string | null) => {
      if (code !== 0) write(`fdash: ${cmd} ended with ${signal ?? "exit code " + code}\n`);
      else if (o.failOnOutput && printed) write(`fdash: ${cmd} printed something on stdout, which fails this task\n`);
      settle(code === 0 && !(o.failOnOutput && printed));
    });
  });
}

/** Runs a command's steps in sequence into its log file; the first failing step ends it. */
export async function runCommand(c: Command, o: { root: string; log: string; extraArgs?: string[]; env?: Record<string, string> }): Promise<boolean> {
  const log = fs.openSync(o.log, "a");
  try {
    const env = { ...process.env, ...c.env, ...o.env };
    for (let i = 0; i < c.run.length; i++) {
      const argv = i === c.run.length - 1 && c.args ? [...c.run[i], ...(o.extraArgs ?? [])] : c.run[i];
      fs.writeSync(log, `$ ${argv.join(" ")}\n`);
      if (!(await runStep(argv, { cwd: path.join(o.root, c.cwd), env, log, failOnOutput: c.failOnOutput }))) return false;
    }
    return true;
  } finally {
    fs.closeSync(log);
  }
}

/** Runs `items` with at most `jobs` started and unfinished at once; stops starting new ones once `stop()` is true. */
async function pool<T>(items: T[], jobs: number, work: (item: T) => Promise<boolean>, stop: () => boolean): Promise<boolean> {
  let next = 0, ok = true;
  const lane = async () => {
    while (next < items.length && !stop()) ok = (await work(items[next++])) && ok;
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, lane));
  return ok;
}

/** The items' outcomes a command wrote to FDASH_REPORT, and whether it asked that nothing be recorded. */
function readReport(file: string): { said: Map<string, boolean>; nocache: boolean } {
  const seen = new Map<string, boolean>();
  let nocache = false;
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { said: seen, nocache };
  }
  for (const line of text.split(/\r?\n/)) {
    try {
      const r = JSON.parse(line);
      if (r?.nocache === true) nocache = true;
      if (typeof r?.item === "string" && typeof r?.ok === "boolean") seen.set(r.item, (seen.get(r.item) ?? true) && r.ok);
    } catch {
      // a partial line from a command that was stopped
    }
  }
  return { said: seen, nocache };
}

export async function run(o: RunOptions): Promise<{ results: Result[]; interrupted: boolean }> {
  const skip = new Set(o.skip ?? []);
  const order = expand(o.config, o.names, o.skip ?? []);
  // what this run starts: a predecessor outside it is not waited for, and never started
  const inRun = new Set(order.map((c) => c.name));
  const logDir = o.logDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "fdash."));
  const cacheDir = o.cacheDir ?? process.env.FDASH_CACHE_DIR ?? path.join(o.root, ".fdash", "cache");
  const stop = () => o.signal?.aborted === true;
  const started = new Map<string, Promise<Result[]>>();
  const done = new Map<string, Result[]>();

  const report = (rs: Result[]) => { for (const r of rs) o.onResult?.(r); return rs; };

  /** Whether a pass may be recorded under `before`: not after an interruption (a child stopped by Ctrl+C may
   * exit 0), and only if the inputs still give the same key once the command is done; a file changed while it
   * ran means the content it started from may not be what it read. */
  const unchanged = (before: string, now: () => string) => {
    if (stop()) return false;
    try {
      return now() === before;
    } catch {
      return false;
    }
  };

  async function command(c: Command): Promise<Result[]> {
    const log = path.join(logDir, `${c.name.replace(/[^\w.-]/g, "_")}.log`);
    const extra = c.args ? o.extraArgs ?? [] : [];
    const t0 = Date.now();
    const reportFile = path.join(logDir, `${c.name.replace(/[^\w.-]/g, "_")}.report.jsonl`);
    // a command with items always gets a report file, cached or not
    const reportEnv = c.items ? { FDASH_REPORT: reportFile } : undefined;
    const plain = async () => {
      const ok = await runCommand(c, { root: o.root, log, extraArgs: extra, env: reportEnv });
      return [{ name: c.name, ok, cached: false, log, ms: Date.now() - t0 }];
    };
    if (c.inputs === undefined || !c.cache) return plain();
    let common: string[];
    try {
      common = resolveInputs(o.root, c.inputs);
    } catch (e) {
      fs.appendFileSync(log, `fdash: inputs could not be resolved, running without the cache: ${(e as Error).message}\n`);
      return plain();
    }
    if (!c.items || (extra.length > 0 && !extra.every((a) => c.items!.has(a)))) {
      if (c.items) fs.appendFileSync(log, `fdash: arguments that are not items, running without the cache: ${extra.join(" ")}\n`);
      if (c.items) return plain();
      const key = cacheKey(o.root, c, extra, common, process.env);
      let warn: string | undefined;
      if (!o.force && passed(cacheDir, c.name, key)) {
        // a hit puts the outputs of that pass on disk, over what is there; without them it is a miss
        let restored: string;
        try {
          restored = c.outputs.length ? restoreOutputs(cacheDir, c.name, key, o.root) : "restored";
        } catch (e) {
          fs.appendFileSync(log, `fdash: the outputs could not be restored: ${(e as Error).message}\n`);
          restored = "missing";
        }
        if (restored === "restored") return [{ name: c.name, ok: true, cached: true, log: "", ms: 0 }];
        warn = "outputs not in the cache";
      }
      const before = key + signature(o.root, common);
      const [r] = await plain();
      const now = () => { const files = resolveInputs(o.root, c.inputs!); return cacheKey(o.root, c, extra, files, process.env) + signature(o.root, files); };
      if (r.ok && unchanged(before, now)) {
        try {
          // the outputs first: a record is only ever written once its outputs are kept
          if (c.outputs.length) storeOutputs(cacheDir, c.name, key, o.root, resolveOutputs(o.root, c.outputs));
          recordPass(cacheDir, c.name, key, r.ms);
        } catch (e) {
          fs.appendFileSync(log, `fdash: the outputs could not be stored, nothing recorded: ${(e as Error).message}\n`);
        }
      }
      return [warn ? { ...r, warn } : r];
    }
    // items: each keyed on its own, the command run once with the items that have not passed
    const items = [...c.items.keys()].filter((i) => extra.length === 0 || extra.includes(i));
    const itemFiles = (item: string, shared: string[]) => [...new Set([...shared, ...resolveInputs(o.root, c.items!.get(item)!.inputs)])].sort();
    const itemKey = (item: string, files: string[]) => cacheKey(o.root, c, [item], files, process.env);
    const keys = new Map<string, string>(), befores = new Map<string, string>();
    for (const item of items) {
      const files = itemFiles(item, common);
      keys.set(item, itemKey(item, files));
      befores.set(item, keys.get(item)! + signature(o.root, files));
    }
    const todo = items.filter((i) => o.force || !passed(cacheDir, `${c.name}:${i}`, keys.get(i)!));
    const outcome = new Map<string, boolean>();
    let ms = 0;
    if (todo.length > 0) {
      fs.rmSync(reportFile, { force: true });
      const ok = await runCommand(c, { root: o.root, log, extraArgs: todo, env: { FDASH_REPORT: reportFile } });
      ms = Date.now() - t0;
      const { said, nocache } = readReport(reportFile);
      if (nocache) fs.appendFileSync(log, "fdash: the command asked that nothing be recorded (nocache)\n");
      // inputs that no longer resolve once it ran (a go.mod broken meanwhile): report, record nothing
      let after: string[] | undefined;
      try {
        after = stop() || nocache ? undefined : resolveInputs(o.root, c.inputs);
      } catch (e) {
        fs.appendFileSync(log, `fdash: inputs could not be resolved after the run, nothing recorded: ${(e as Error).message}\n`);
      }
      for (const i of todo) {
        const itemOk = said.get(i) ?? ok;
        outcome.set(i, itemOk);
        const now = () => { const files = itemFiles(i, after!); return itemKey(i, files) + signature(o.root, files); };
        if (itemOk && after && unchanged(befores.get(i)!, now)) recordPass(cacheDir, `${c.name}:${i}`, keys.get(i)!, ms);
      }
    }
    return items.map((i) => outcome.has(i)
      ? { name: `${c.name}:${i}`, ok: outcome.get(i)!, cached: false, log, ms }
      : { name: `${c.name}:${i}`, ok: true, cached: true, log: "", ms: 0 });
  }

  /** A command first waits for its predecessors that are part of this run; one not started yet is run here, in
   * this command's lane, so that a lane never waits for work that no lane is free to start. */
  async function afterPredecessors(c: Command): Promise<Result[]> {
    for (const a of c.after) {
      if (!inRun.has(a)) continue;
      const ok = await task(a);
      if (stop()) return [];
      if (!ok) return [{ name: c.name, ok: false, cached: false, log: "", ms: 0, failedAfter: a }];
    }
    return stop() ? [] : command(c);
  }

  async function task(name: string): Promise<boolean> {
    if (skip.has(name)) return true;
    const t = o.config.get(name)!;
    if (t.kind === "group") return pool(t.tasks, t.jobs ?? o.jobs, task, stop);
    let p = started.get(name);
    if (!p) {
      if (stop()) return false;
      p = afterPredecessors(t).then((rs) => { done.set(name, rs); return report(rs); });
      started.set(name, p);
    }
    return (await p).every((r) => r.ok);
  }

  await pool(o.names, o.jobs, task, stop);
  return { results: order.flatMap((c) => done.get(c.name) ?? []), interrupted: stop() };
}
