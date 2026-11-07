// fdash workspaces: fdash-workspace.json at the root lists the projects, each a folder with its own
// fdash.json. A project's tasks run in its folder and by default read every file of it plus the files of the
// projects it depends on. Everything ends up as one flat Config, a project's task under `<project>:<task>`;
// on the command line and in groups a task is named without its project (`test:unit`), which means that task
// in every project defining it.
import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, finishConfig, loadConfig, localName, parseJson, parseTasks, type Command, type Config, type Input, type Task } from "./config.ts";

export const WORKSPACE_FILE = "fdash-workspace.json";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const posix = (...p: string[]) => path.posix.join(...p);

type Project = { name: string; dir: string; files: string[]; dependsOn: string[]; tasks: Config; file: string };

/** The folders a projects entry names: a literal path, or segments of which some are "*" (one level). */
function folders(root: string, pattern: string): { dir: string; literal: boolean }[] {
  const segs = pattern.split("/").filter(Boolean);
  if (!segs.includes("*")) return [{ dir: segs.join("/"), literal: true }];
  let found = [""];
  for (const s of segs) {
    if (s !== "*") { found = found.map((d) => posix(d, s)); continue; }
    found = found.flatMap((d) => {
      try {
        return fs.readdirSync(path.join(root, d), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => posix(d, e.name)).sort();
      } catch {
        return [];
      }
    });
  }
  return found.map((dir) => ({ dir, literal: false }));
}

/** A project's pattern (relative to its folder, "/" for the root, "!" to exclude) written from the root. */
function fromRoot(dir: string, pattern: string): string {
  const neg = pattern.startsWith("!");
  const body = neg ? pattern.slice(1) : pattern;
  const rooted = body.startsWith("/") ? body.slice(1) : posix(dir, body);
  return (neg ? "!" : "") + rooted;
}
const inputFromRoot = (dir: string, i: Input): Input => (typeof i === "string" ? fromRoot(dir, i) : { ...i, cwd: posix(dir, i.cwd) });

function readProject(root: string, dir: string): Project {
  const file = posix(dir, CONFIG_FILE);
  const raw = parseJson(fs.readFileSync(path.join(root, file), "utf8"), file);
  if (!isObject(raw)) throw new Error(`${file}: must be an object`);
  for (const k of Object.keys(raw)) if (!["name", "files", "dependsOn", "tasks"].includes(k)) throw new Error(`${file}: unknown key ${k}`);
  if (raw.name !== undefined && (typeof raw.name !== "string" || !/^[\w.-]+$/.test(raw.name))) throw new Error(`${file}: name must be letters, digits, ".", "_" or "-"`);
  if (raw.files !== undefined && !isStrings(raw.files)) throw new Error(`${file}: files must be a list of patterns`);
  if (raw.dependsOn !== undefined && !isStrings(raw.dependsOn)) throw new Error(`${file}: dependsOn must be a list of project names`);
  if (raw.tasks !== undefined && !isObject(raw.tasks)) throw new Error(`${file}: tasks must be an object`);
  let tasks: Config;
  try {
    tasks = parseTasks((raw.tasks as Record<string, unknown> | undefined) ?? {});
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  return { name: (raw.name as string | undefined) ?? path.posix.basename(dir), dir, files: (raw.files as string[] | undefined) ?? ["**"], dependsOn: (raw.dependsOn as string[] | undefined) ?? [], tasks, file };
}

export function loadWorkspace(root: string): Config {
  const raw = parseJson(fs.readFileSync(path.join(root, WORKSPACE_FILE), "utf8"), WORKSPACE_FILE);
  if (!isObject(raw)) throw new Error(`${WORKSPACE_FILE}: must be an object`);
  for (const k of Object.keys(raw)) if (k !== "projects" && k !== "tasks") throw new Error(`${WORKSPACE_FILE}: unknown key ${k}`);
  if (!isStrings(raw.projects)) throw new Error(`${WORKSPACE_FILE}: projects must be a list of folders`);
  if (raw.tasks !== undefined && !isObject(raw.tasks)) throw new Error(`${WORKSPACE_FILE}: tasks must be an object`);

  const projects: Project[] = [];
  const byName = new Map<string, Project>();
  for (const pattern of raw.projects) {
    for (const { dir, literal } of folders(root, pattern)) {
      if (!fs.existsSync(path.join(root, dir, CONFIG_FILE))) {
        if (literal) throw new Error(`${WORKSPACE_FILE}: the project ${dir} has no ${CONFIG_FILE}`);
        continue;
      }
      const p = readProject(root, dir);
      const twin = byName.get(p.name);
      if (twin) throw new Error(`two projects named ${p.name}: ${twin.dir} and ${p.dir} (set "name" in one ${CONFIG_FILE})`);
      byName.set(p.name, p);
      projects.push(p);
    }
  }

  // the files a project reads from others: its dependsOn's files, transitively
  const deps = new Map<string, string[]>();
  const depFiles = (p: Project, trail: string[]): string[] => {
    const known = deps.get(p.name);
    if (known) return known;
    if (trail.includes(p.name)) throw new Error(`dependsOn forms a cycle: ${[...trail, p.name].join(" -> ")}`);
    const out: string[] = [];
    for (const d of p.dependsOn) {
      const q = byName.get(d);
      if (!q) throw new Error(`${p.file}: dependsOn names ${d}, which is no project`);
      for (const f of [...q.files.map((x) => fromRoot(q.dir, x)), ...depFiles(q, [...trail, p.name])]) if (!out.includes(f)) out.push(f);
    }
    deps.set(p.name, out);
    return out;
  };

  const config: Config = new Map();
  const wsTasks = parseTasks((raw.tasks as Record<string, unknown> | undefined) ?? {});
  for (const [n, t] of wsTasks) config.set(n, t.kind === "command" && !t.cache ? { ...t, inputs: undefined } : t);
  // the projects defining each name, in project order
  const across = new Map<string, string[]>();
  for (const p of projects) {
    const inherited = [posix(p.dir, "**"), ...depFiles(p, [])];
    for (const t of p.tasks.values()) {
      const name = `${p.name}:${t.name}`;
      if (wsTasks.has(t.name) || config.has(name)) throw new Error(`${wsTasks.has(t.name) ? t.name : name}: both a workspace task and a project task (${p.file}), so the name would mean two things`);
      let task: Task;
      if (t.kind === "group") task = { ...t, name, project: p.name };
      else {
        const own = (t.inputs ?? []).map((i) => inputFromRoot(p.dir, i));
        const c: Command = {
          ...t, name, project: p.name, cwd: posix(p.dir, t.cwd), outputs: t.outputs.map((o) => fromRoot(p.dir, o)),
          inputs: t.cache ? [...inherited, ...own] : undefined,
          items: t.items && new Map([...t.items].map(([k, v]) => [k, { inputs: v.inputs.map((i) => inputFromRoot(p.dir, i)) }])),
        };
        task = c;
      }
      config.set(name, task);
      across.set(t.name, [...(across.get(t.name) ?? []), name]);
    }
  }
  // a group's member: a task of the group's own project, else that name in every project defining it, else
  // the workspace's task of that name
  for (const t of config.values()) {
    if (t.kind !== "group") continue;
    t.tasks = t.tasks.flatMap((m) => {
      const own = t.project === undefined ? undefined : config.get(`${t.project}:${m}`);
      if (own && own.project === t.project) return [own.name];
      const found = across.get(m);
      if (found) return found;
      if (wsTasks.has(m)) return [m];
      throw new Error(`${t.name}: no task named ${m}`);
    });
  }
  // order: a project's task starts after the tasks of its own project it names in `after`, and after the same
  // task of the nearest projects it depends on that define it (walking through those that do not)
  const nearest = (p: Project, name: string): string[] => {
    const out: string[] = [];
    for (const d of p.dependsOn) {
      const q = byName.get(d)!;
      for (const n of q.tasks.has(name) ? [`${q.name}:${name}`] : nearest(q, name)) if (!out.includes(n)) out.push(n);
    }
    return out;
  };
  for (const n of wsTasks.keys()) {
    const t = config.get(n)!;
    for (const a of t.after) if (!wsTasks.has(a)) throw new Error(`${n}: after names ${a}, which is no task of ${WORKSPACE_FILE}`);
  }
  for (const p of projects) {
    for (const local of p.tasks.keys()) {
      const t = config.get(`${p.name}:${local}`)!;
      const own = t.after.map((a) => {
        if (config.get(`${p.name}:${a}`)?.project !== p.name) throw new Error(`${t.name}: after names ${a}, which is no task of ${p.name}`);
        return `${p.name}:${a}`;
      });
      t.after = [...own, ...nearest(p, local).filter((n) => !own.includes(n))];
    }
  }
  return finishConfig(config);
}

/** The tasks to run for names given on the command line: a workspace task by its name, a project's task in
 * every project defining it, or only in `pkgs` when some are named (each must define it). */
export function select(config: Config, names: string[], pkgs: string[]): string[] {
  const tasks = [...config.values()];
  const projects = new Set(tasks.flatMap((t) => (t.project === undefined ? [] : [t.project])));
  for (const p of pkgs) if (!projects.has(p)) throw new Error(`no project named ${p}${projects.size ? ` (projects with tasks: ${[...projects].join(", ")})` : ""}`);
  const out: string[] = [];
  const add = (n: string) => { if (!out.includes(n)) out.push(n); };
  for (const n of names) {
    const own = config.get(n);
    if (own && own.project === undefined) {
      if (pkgs.length) throw new Error(`${n} is a workspace task, not a project's: --pkg cannot restrict it`);
      add(n);
      continue;
    }
    if (pkgs.length) {
      for (const p of pkgs) {
        if (config.get(`${p}:${n}`)?.project !== p) throw new Error(`${p} has no task ${n}`);
        add(`${p}:${n}`);
      }
      continue;
    }
    const found = tasks.filter((t) => t.project !== undefined && localName(t) === n);
    if (found.length === 0) {
      if (own) throw new Error(`no task named ${n} (a project's task is named without its project: ${localName(own)} --pkg ${own.project})`);
      throw new Error(`no task named ${n}`);
    }
    for (const t of found) add(t.name);
  }
  return out;
}

/** The workspace's config when there is one, else the single fdash.json of `root`. */
export function load(root: string): Config {
  return fs.existsSync(path.join(root, WORKSPACE_FILE)) ? loadWorkspace(root) : loadConfig(root);
}

/** The root: the nearest folder above `dir` holding fdash-workspace.json, else the nearest holding fdash.json. */
export function findRoot(dir: string): string {
  let single: string | null = null;
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, WORKSPACE_FILE))) return d;
    if (single === null && fs.existsSync(path.join(d, CONFIG_FILE))) single = d;
    if (path.dirname(d) === d) {
      if (single !== null) return single;
      throw new Error(`no ${WORKSPACE_FILE} or ${CONFIG_FILE} in ${dir} or above`);
    }
  }
}
