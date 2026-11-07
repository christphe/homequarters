// fdash's config file, fdash.json: commands (steps to run) and groups (tasks run together, `jobs` at once).
// Validated whole when loaded, so a mistake is reported before anything runs.
import fs from "node:fs";
import path from "node:path";

/** A path pattern relative to the root (a leading "!" excludes), or the files of Go packages. */
export type Input = string | { go: string; cwd: string; tests: boolean };

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
};
export type Group = { kind: "group"; name: string; tasks: string[]; jobs?: number };
export type Task = Command | Group;
/** Tasks by name, in the order of the file. */
export type Config = Map<string, Task>;

export const CONFIG_FILE = "fdash.json";

const COMMAND_KEYS = new Set(["cwd", "run", "env", "failOnOutput", "args", "inputs", "envKeys", "tools", "items", "cache"]);
const GROUP_KEYS = new Set(["tasks", "jobs"]);

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
    throw new Error(`${name}: ${key} holds ${JSON.stringify(x)}: a path pattern or { "go": <packages>, "cwd": <module dir>, "tests"?: <bool> }`);
  });
}

function parseCommand(name: string, t: Record<string, unknown>): Command {
  if (!Array.isArray(t.run) || t.run.length === 0 || !t.run.every(isArgv)) throw new Error(`${name}: run must be a non-empty list of steps, each a non-empty list of strings`);
  if (t.cwd !== undefined && typeof t.cwd !== "string") throw new Error(`${name}: cwd must be a string`);
  if (t.env !== undefined && !(isObject(t.env) && Object.values(t.env).every((s) => typeof s === "string"))) throw new Error(`${name}: env must map names to strings`);
  for (const k of ["failOnOutput", "args", "cache"] as const) if (t[k] !== undefined && typeof t[k] !== "boolean") throw new Error(`${name}: ${k} must be true or false`);
  if (t.envKeys !== undefined && !isStrings(t.envKeys)) throw new Error(`${name}: envKeys must be a list of names`);
  if (t.tools !== undefined && !(Array.isArray(t.tools) && t.tools.every(isArgv))) throw new Error(`${name}: tools must be a list of commands, each a non-empty list of strings`);
  let items: Command["items"];
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
    cwd: (t.cwd as string | undefined) ?? ".",
    run: t.run as string[][],
    env: (t.env as Record<string, string> | undefined) ?? {},
    failOnOutput: t.failOnOutput === true,
    args: t.args === true,
    cache: t.cache !== false,
    inputs: t.inputs === undefined ? undefined : parseInputs(name, "inputs", t.inputs),
    envKeys: (t.envKeys as string[] | undefined) ?? [],
    tools: (t.tools as string[][] | undefined) ?? [],
    items,
  };
}

function parseGroup(name: string, t: Record<string, unknown>): Group {
  if (!isStrings(t.tasks)) throw new Error(`${name}: tasks must be a list of task names`);
  if (t.jobs !== undefined && !(typeof t.jobs === "number" && Number.isInteger(t.jobs) && t.jobs >= 1)) throw new Error(`${name}: jobs must be a positive integer, got ${JSON.stringify(t.jobs)}`);
  return t.jobs === undefined ? { kind: "group", name, tasks: t.tasks } : { kind: "group", name, tasks: t.tasks, jobs: t.jobs as number };
}

/** Parses JSON, naming the file in the error. */
export function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: invalid JSON (${(e as Error).message})`);
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

/** Checks that every group member exists and that groups form no cycle. */
export function finishConfig(config: Config): Config {
  for (const t of config.values()) {
    if (t.kind === "group") for (const m of t.tasks) if (!config.has(m)) throw new Error(`${t.name}: no task named ${m}`);
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
