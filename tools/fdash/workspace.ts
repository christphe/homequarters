// fdash workspaces: fdash-workspace.json at the root lists the projects, each a folder with its own
// fdash.json. A project's tasks are named <project>:<task>, run in its folder, and by default read every file
// of it plus the files of the projects it depends on. Everything ends up as one flat Config.
import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, finishConfig, loadConfig, parseJson, parseTasks, type Command, type Config, type Input, type Task } from "./config.ts";

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
  for (const p of projects) {
    const qualify = (m: string) => (m.includes(":") ? m : `${p.name}:${m}`);
    const inherited = [posix(p.dir, "**"), ...depFiles(p, [])];
    for (const t of p.tasks.values()) {
      const name = `${p.name}:${t.name}`;
      let task: Task;
      if (t.kind === "group") task = { ...t, name, tasks: t.tasks.map(qualify) };
      else {
        const own = (t.inputs ?? []).map((i) => inputFromRoot(p.dir, i));
        const c: Command = {
          ...t, name, cwd: posix(p.dir, t.cwd),
          inputs: t.cache ? [...inherited, ...own] : undefined,
          items: t.items && new Map([...t.items].map(([k, v]) => [k, { inputs: v.inputs.map((i) => inputFromRoot(p.dir, i)) }])),
        };
        task = c;
      }
      config.set(name, task);
    }
  }
  // *:<task>: that task in every project that has it, in project order
  for (const t of config.values()) {
    if (t.kind !== "group") continue;
    t.tasks = t.tasks.flatMap((m) => {
      if (!m.startsWith("*:")) return [m];
      const found = projects.map((p) => `${p.name}:${m.slice(2)}`).filter((n) => config.has(n));
      if (!found.length) throw new Error(`${t.name}: ${m} matches no task`);
      return found;
    });
  }
  return finishConfig(config);
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
