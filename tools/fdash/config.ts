// fdash's config file, fdash.json: commands (steps to run) and groups (tasks run together, `jobs` at once).
// Validated whole when loaded, so a mistake is reported before anything runs.
import fs from "node:fs";
import path from "node:path";

/** A path pattern relative to the root (a leading "!" excludes), the files of Go packages, a path pattern of
 * files read from the disk, git-ignored ones included (build artefacts a command runs or serves), or the part
 * of the pnpm lockfile a workspace member (its folder) installs. */
export type Input = string | { go: string; cwd: string; tests: boolean } | { disk: string } | { pnpm: string };

export type Command = {
  kind: "command";
  name: string;
  cwd: string;
  run: string[][];
  env: Record<string, string>;
  failOnOutput: boolean;
  args: boolean;
  /** false: never cached, whatever its inputs */
  cache: boolean;
  inputs: Input[] | undefined;
  envKeys: string[];
  tools: string[][];
  items: Map<string, { inputs: Input[] }> | undefined;
  /** In a workspace, the project the command belongs to (its name is then `<project>:<task>`); unset for the
   * workspace's own tasks and in a lone fdash.json. */
  project?: string;
  /** The commands this one starts after, when they are part of the same run. Written, the names of tasks of
   * the same file or project; once the config is finished, the commands they stand for, with those coming
   * from groups and (in a workspace) from the projects it depends on. */
  after: string[];
  /** In a workspace: whether it also starts after the same task of the projects it depends on (default true).
   * false for a task that gains nothing from waiting, such as tests that build what they test themselves. */
  afterDependsOn: boolean;
  /** Path patterns (relative to the root, a leading "!" excludes) of the files the command produces: part of
   * the cache key, stored with a pass and restored on a hit. */
  outputs: string[];
};
/** `after`: the tasks every command of the group starts after (see Command). */
export type Group = { kind: "group"; name: string; tasks: string[]; jobs?: number; project?: string; after: string[] };
export type Task = Command | Group;
/** Tasks by name, in the order of the file. */
export type Config = Map<string, Task>;

export const CONFIG_FILE = "fdash.json";

const COMMAND_KEYS = new Set(["cwd", "run", "env", "failOnOutput", "args", "inputs", "envKeys", "tools", "items", "cache", "after", "afterDependsOn", "outputs"]);
const GROUP_KEYS = new Set(["tasks", "jobs", "after"]);

function parseAfter(name: string, v: unknown): string[] {
  if (v === undefined) return [];
  if (!isStrings(v)) throw new Error(`${name}: after must be a list of task names`);
  return v;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isArgv = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string");
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

function parseInputs(name: string, key: string, v: unknown): Input[] {
  if (!Array.isArray(v)) throw new Error(`${name}: ${key} must be a list`);
  return v.map((x): Input => {
    if (typeof x === "string" && x.replace(/^!/, "") !== "") return x;
    if (isObject(x) && typeof x.go === "string" && typeof x.cwd === "string" && Object.keys(x).every((k) => k === "go" || k === "cwd" || k === "tests") && (x.tests === undefined || typeof x.tests === "boolean")) {
      return { go: x.go, cwd: x.cwd, tests: x.tests === true };
    }
    if (isObject(x) && typeof x.disk === "string" && x.disk !== "" && !x.disk.startsWith("!") && Object.keys(x).length === 1) return { disk: x.disk };
    if (isObject(x) && typeof x.pnpm === "string" && x.pnpm !== "" && Object.keys(x).length === 1) return { pnpm: x.pnpm };
    throw new Error(`${name}: ${key} holds ${JSON.stringify(x)}: a path pattern, { "go": <packages>, "cwd": <module dir>, "tests"?: <bool> }, { "disk": <path pattern> } or { "pnpm": <member dir> }`);
  });
}

function parseCommand(name: string, t: Record<string, unknown>): Command {
  if (!Array.isArray(t.run) || t.run.length === 0 || !t.run.every(isArgv)) throw new Error(`${name}: run must be a non-empty list of steps, each a non-empty list of strings`);
  if (t.cwd !== undefined && typeof t.cwd !== "string") throw new Error(`${name}: cwd must be a string`);
  if (t.env !== undefined && !(isObject(t.env) && Object.values(t.env).every((s) => typeof s === "string"))) throw new Error(`${name}: env must map names to strings`);
  for (const k of ["failOnOutput", "args", "cache", "afterDependsOn"] as const) if (t[k] !== undefined && typeof t[k] !== "boolean") throw new Error(`${name}: ${k} must be true or false`);
  if (t.envKeys !== undefined && !isStrings(t.envKeys)) throw new Error(`${name}: envKeys must be a list of names`);
  if (t.tools !== undefined && !(Array.isArray(t.tools) && t.tools.every(isArgv))) throw new Error(`${name}: tools must be a list of commands, each a non-empty list of strings`);
  if (t.outputs !== undefined && !(isStrings(t.outputs) && t.outputs.every((p) => p.replace(/^!/, "") !== ""))) throw new Error(`${name}: outputs must be a list of path patterns`);
  // items are cached one by one, and which of them produced which file is unknown
  if (t.outputs !== undefined && t.items !== undefined) throw new Error(`${name}: outputs cannot be combined with items`);
  let items: Command["items"];
  if (t.items !== undefined && t.args !== true) throw new Error(`${name}: items needs "args": true (the items to run are given as arguments)`);
  if (t.items !== undefined) {
    if (!isObject(t.items)) throw new Error(`${name}: items must map item names to { "inputs": [...] }`);
    items = new Map();
    for (const [item, spec] of Object.entries(t.items)) {
      if (!isObject(spec) || !Object.keys(spec).every((k) => k === "inputs")) throw new Error(`${name}: items.${item} must be { "inputs": [...] }`);
      items.set(item, { inputs: spec.inputs === undefined ? [] : parseInputs(name, `items.${item}.inputs`, spec.inputs) });
    }
  }
  return {
    kind: "command",
    name,
    cwd: t.cwd ?? ".",
    run: t.run,
    env: (t.env as Record<string, string> | undefined) ?? {},
    failOnOutput: t.failOnOutput === true,
    args: t.args === true,
    cache: t.cache !== false,
    inputs: t.inputs === undefined ? undefined : parseInputs(name, "inputs", t.inputs),
    envKeys: t.envKeys ?? [],
    tools: t.tools ?? [],
    items,
    after: parseAfter(name, t.after),
    afterDependsOn: t.afterDependsOn !== false,
    outputs: t.outputs ?? [],
  };
}

function parseGroup(name: string, t: Record<string, unknown>): Group {
  if (!isStrings(t.tasks)) throw new Error(`${name}: tasks must be a list of task names`);
  if (t.jobs !== undefined && !(typeof t.jobs === "number" && Number.isInteger(t.jobs) && t.jobs >= 1)) throw new Error(`${name}: jobs must be a positive integer, got ${JSON.stringify(t.jobs)}`);
  const after = parseAfter(name, t.after);
  return t.jobs === undefined ? { kind: "group", name, tasks: t.tasks, after } : { kind: "group", name, tasks: t.tasks, jobs: t.jobs, after };
}

/** Parses JSON, naming the file in the error. */
export function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: invalid JSON (${(e as Error).message})`, { cause: e });
  }
}

export function parseConfig(text: string): Config {
  const raw = parseJson(text, CONFIG_FILE);
  if (!isObject(raw) || !isObject(raw.tasks)) throw new Error(`${CONFIG_FILE}: needs a "tasks" object`);
  return finishConfig(parseTasks(raw.tasks));
}

/** The tasks of one "tasks" object, each checked on its own; references between them are not checked yet. */
export function parseTasks(tasks: Record<string, unknown>): Config {
  const config: Config = new Map();
  for (const [name, t] of Object.entries(tasks)) {
    if (!isObject(t)) throw new Error(`${name}: must be an object`);
    const isCommand = "run" in t, isGroup = "tasks" in t;
    if (isCommand && isGroup) throw new Error(`${name}: has both run and tasks; a task is a command or a group`);
    if (!isCommand && !isGroup) throw new Error(`${name}: needs run (a command) or tasks (a group)`);
    const allowed = isCommand ? COMMAND_KEYS : GROUP_KEYS;
    for (const k of Object.keys(t)) if (!allowed.has(k)) throw new Error(`${name}: unknown key ${k}`);
    config.set(name, isCommand ? parseCommand(name, t) : parseGroup(name, t));
  }
  return config;
}

/** A task's name as its project's fdash.json writes it (`test:unit` for `server:test:unit`). */
export const localName = (t: Task): string => (t.project === undefined ? t.name : t.name.slice(t.project.length + 1));

/** Checks that every group member and every `after` exists and that neither groups nor `after` form a cycle,
 * then turns each command's `after` into the commands it starts after. */
export function finishConfig(config: Config): Config {
  for (const t of config.values()) {
    if (t.kind === "group") for (const m of t.tasks) if (!config.has(m)) throw new Error(`${t.name}: no task named ${m}`);
    for (const a of t.after) if (!config.has(a)) throw new Error(`${t.name}: after names ${a}, which is no task`);
  }
  // a cycle between groups would never end
  const state = new Map<string, "open" | "done">();
  const visit = (name: string, trail: string[]) => {
    const t = config.get(name)!;
    if (t.kind !== "group" || state.get(name) === "done") return;
    if (state.get(name) === "open") throw new Error(`groups form a cycle: ${[...trail.slice(trail.indexOf(name)), name].join(" -> ")}`);
    state.set(name, "open");
    for (const m of t.tasks) visit(m, [...trail, name]);
    state.set(name, "done");
  };
  for (const name of config.keys()) visit(name, []);

  // every command a task reaches starts after every command its `after` reaches: a command's own first, then
  // those of the groups it is in
  const tasks = [...config.values()];
  const written = new Map(tasks.map((t) => [t.name, t.after]));
  const before = new Map<string, string[]>();
  for (const t of [...tasks.filter((x) => x.kind === "command"), ...tasks.filter((x) => x.kind === "group")]) {
    const preds = expand(config, written.get(t.name)!, []).map((c) => c.name);
    if (preds.length === 0) continue;
    for (const c of expand(config, [t.name], [])) {
      const list = before.get(c.name) ?? [];
      for (const p of preds) if (!list.includes(p)) list.push(p);
      before.set(c.name, list);
    }
  }
  for (const t of tasks) if (t.kind === "command") t.after = before.get(t.name) ?? [];

  // a command waiting for itself, through others, would never start
  const seen = new Map<string, "open" | "done">();
  const walk = (name: string, trail: string[]) => {
    if (seen.get(name) === "done") return;
    if (seen.get(name) === "open") throw new Error(`after forms a cycle: ${[...trail.slice(trail.indexOf(name)), name].join(" -> ")}`);
    seen.set(name, "open");
    for (const p of (config.get(name) as Command).after) walk(p, [...trail, name]);
    seen.set(name, "done");
  };
  for (const t of tasks) if (t.kind === "command") walk(t.name, []);
  return config;
}

export function loadConfig(root: string): Config {
  return parseConfig(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
}

/** The commands reached from `names` through groups, depth first in member order, each once, `skip` left out. */
export function expand(config: Config, names: string[], skip: string[]): Command[] {
  for (const n of [...names, ...skip]) if (!config.has(n)) throw new Error(`no task named ${n}`);
  const skipped = new Set(skip);
  const out: Command[] = [];
  const seen = new Set<string>();
  const walk = (name: string) => {
    if (skipped.has(name) || seen.has(name)) return;
    seen.add(name);
    const t = config.get(name)!;
    if (t.kind === "command") out.push(t);
    else for (const m of t.tasks) walk(m);
  };
  for (const n of names) walk(n);
  return out;
}
