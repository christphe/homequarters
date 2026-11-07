// Running tasks: a command's steps in sequence, a group's members `jobs` at once, each command once per run,
// and the cache (inputs, items) around commands that declare inputs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expand, type Command, type Config } from "./config.ts";
import { cacheKey, passed, recordPass, resolveInputs } from "./cache.ts";
import { launch, spawnSpec } from "./spawn.ts";

export { spawnSpec };

/** One line of the report: a command, or one item of a command (`<command>:<item>`). */
export type Result = { name: string; ok: boolean; cached: boolean; log: string; ms: number };

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
  const l = launch(cmd, rest);
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

function readReport(file: string): Map<string, boolean> {
  const seen = new Map<string, boolean>();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return seen;
  }
  for (const line of text.split(/\r?\n/)) {
    try {
      const r = JSON.parse(line);
      if (typeof r?.item === "string" && typeof r?.ok === "boolean") seen.set(r.item, (seen.get(r.item) ?? true) && r.ok);
    } catch {
      // a partial line from a command that was stopped
    }
  }
  return seen;
}

export async function run(o: RunOptions): Promise<{ results: Result[]; interrupted: boolean }> {
  const skip = new Set(o.skip ?? []);
  const order = expand(o.config, o.names, o.skip ?? []);
  const logDir = o.logDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "fdash."));
  const cacheDir = o.cacheDir ?? process.env.FDASH_CACHE_DIR ?? path.join(o.root, ".fdash", "cache");
  const stop = () => o.signal?.aborted === true;
  const started = new Map<string, Promise<Result[]>>();
  const done = new Map<string, Result[]>();

  const report = (rs: Result[]) => { for (const r of rs) o.onResult?.(r); return rs; };

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
      if (!o.force && passed(cacheDir, c.name, key)) return [{ name: c.name, ok: true, cached: true, log: "", ms: 0 }];
      const [r] = await plain();
      if (r.ok) recordPass(cacheDir, c.name, key, r.ms);
      return [r];
    }
    // items: each keyed on its own, the command run once with the items that have not passed
    const items = [...c.items.keys()].filter((i) => extra.length === 0 || extra.includes(i));
    const keys = new Map<string, string>();
    for (const item of items) {
      const files = [...new Set([...common, ...resolveInputs(o.root, c.items.get(item)!.inputs)])].sort();
      keys.set(item, cacheKey(o.root, c, [item], files, process.env));
    }
    const todo = items.filter((i) => o.force || !passed(cacheDir, `${c.name}:${i}`, keys.get(i)!));
    const outcome = new Map<string, boolean>();
    let ms = 0;
    if (todo.length > 0) {
      fs.rmSync(reportFile, { force: true });
      const ok = await runCommand(c, { root: o.root, log, extraArgs: todo, env: { FDASH_REPORT: reportFile } });
      ms = Date.now() - t0;
      const said = readReport(reportFile);
      for (const i of todo) {
        const itemOk = said.get(i) ?? ok;
        outcome.set(i, itemOk);
        if (itemOk) recordPass(cacheDir, `${c.name}:${i}`, keys.get(i)!, ms);
      }
    }
    return items.map((i) => outcome.has(i)
      ? { name: `${c.name}:${i}`, ok: outcome.get(i)!, cached: false, log, ms }
      : { name: `${c.name}:${i}`, ok: true, cached: true, log: "", ms: 0 });
  }

  async function task(name: string): Promise<boolean> {
    if (skip.has(name)) return true;
    const t = o.config.get(name)!;
    if (t.kind === "group") return pool(t.tasks, t.jobs ?? o.jobs, task, stop);
    let p = started.get(name);
    if (!p) {
      if (stop()) return false;
      p = command(t).then((rs) => { done.set(name, rs); return report(rs); });
      started.set(name, p);
    }
    return (await p).every((r) => r.ok);
  }

  await pool(o.names, o.jobs, task, stop);
  return { results: order.flatMap((c) => done.get(c.name) ?? []), interrupted: stop() };
}
