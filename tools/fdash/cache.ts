// fdash's cache: the files a command reads (its inputs), the key that names one exact run of it, and the
// records of the runs that passed. Only passes are recorded; a key that is recorded is never run again.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Command, Input } from "./config.ts";
import { pnpmPart } from "./pnpm.ts";
import { launch } from "./spawn.ts";

const BIG = 256 * 1024 * 1024;
const toPosix = (p: string) => p.split(path.sep).join("/");

function git(root: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd: root, maxBuffer: BIG, stdio: ["ignore", "pipe", "pipe"] });
}

/** Files matched by path patterns: tracked or untracked and not ignored, relative to the root. */
function globFiles(root: string, patterns: string[]): string[] {
  const include = patterns.filter((p) => !p.startsWith("!"));
  if (include.length === 0) return [];
  const specs = [...include.map((p) => `:(glob)${p}`), ...patterns.filter((p) => p.startsWith("!")).map((p) => `:(glob,exclude)${p.slice(1)}`)];
  return git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...specs]).toString("utf8").split("\0").filter(Boolean);
}

/** The files of the main module's packages reached by `go list -deps` from a pattern, plus go.mod and go.sum. */
function goFiles(root: string, input: { go: string; cwd: string; tests: boolean }): string[] {
  // every file the package builds from: Go, cgo, assembly, C and C++, SWIG, objects, embedded files
  const lists = ["GoFiles", "CgoFiles", "CFiles", "CXXFiles", "MFiles", "HFiles", "FFiles", "SFiles", "SwigFiles", "SwigCXXFiles", "SysoFiles", "EmbedFiles", ...(input.tests ? ["TestGoFiles", "XTestGoFiles"] : [])];
  const format = "{{if and (not .Standard) .Module}}{{if .Module.Main}}{{.Module.GoMod}}\t{{.Dir}}" + lists.map((l) => `{{range .${l}}}\t{{.}}{{end}}`).join("") + "{{end}}{{end}}";
  const args = ["list", "-deps", ...(input.tests ? ["-test"] : []), "-f", format, input.go];
  const out = execFileSync("go", args, { cwd: path.join(root, input.cwd), maxBuffer: BIG, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [goMod, dir, ...names] = line.split("\t");
    files.add(goMod);
    files.add(path.join(path.dirname(goMod), "go.sum"));
    dirs.add(dir);
    // with -test, the generated test main lists files in Go's build cache (absolute): not ours
    for (const n of names) if (!path.isAbsolute(n)) files.add(path.join(dir, n));
  }
  const rel = [...files].map((f) => toPosix(path.relative(root, f))).filter((f) => !f.startsWith("../") && !path.isAbsolute(f));
  // tests read their testdata folders
  if (input.tests) rel.push(...globFiles(root, [...dirs].map((d) => toPosix(path.relative(root, d)) + "/testdata/**")));
  return rel;
}

/** What the inputs resolve to. `files`: hashed whole into the key. `parts`: a file of which only a part counts
 * (a member's share of the pnpm lockfile): the key holds the part's name and digest, not the file. `warnings`:
 * why something was hashed more broadly than asked, for the command's log. */
export type Resolved = { files: string[]; parts: { file: string; name: string; digest: string }[]; warnings: string[] };

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Every file of the inputs, sorted, relative to the root with "/" separators, and the parts of files. */
export function resolveInputs(root: string, inputs: Input[]): Resolved {
  const patterns = inputs.filter((i): i is string => typeof i === "string");
  const files = new Set(globFiles(root, patterns));
  const excluded = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  const parts = new Map<string, Resolved["parts"][number]>();
  const warnings: string[] = [];
  const add = (f: string) => { if (!excluded.some((x) => path.posix.matchesGlob(f, x))) files.add(f); };
  // a "!" pattern removes from the whole set, the files of Go packages and of the disk included; a disk
  // pattern that matches nothing (an artefact not built yet) adds nothing
  for (const i of inputs) {
    if (typeof i === "string") continue;
    if ("pnpm" in i) {
      const p = pnpmPart(root, i.pnpm);
      for (const f of p.patches) add(f);
      if (p.digest === undefined) {
        // a lockfile fdash cannot read: all of it counts
        files.add(p.lockfile);
        if (!warnings.includes(p.warning!)) warnings.push(p.warning!);
      } else parts.set(p.name, { file: p.lockfile, name: p.name, digest: p.digest });
      continue;
    }
    for (const f of "disk" in i ? resolveOutputs(root, [i.disk]) : goFiles(root, i)) add(f);
  }
  return { files: [...files].sort(), parts: [...parts.values()].sort(byName), warnings };
}

/** Two resolutions as one (a command's inputs and an item's). */
export function mergeResolved(a: Resolved, b: Resolved): Resolved {
  return {
    files: [...new Set([...a.files, ...b.files])].sort(),
    parts: [...new Map([...a.parts, ...b.parts].map((p) => [p.name, p])).values()].sort(byName),
    warnings: [...new Set([...a.warnings, ...b.warnings])],
  };
}

function hashFile(file: string): string {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "missing";
  }
}

const toolOutputs = new Map<string, string>();
/** What a tool prints (its version), asked once per process. */
export function toolOutput(argv: string[]): string {
  const id = JSON.stringify(argv);
  let out = toolOutputs.get(id);
  if (out === undefined) {
    try {
      const [cmd, ...args] = argv;
      const l = launch(cmd, args);
      out = execFileSync(l.file, l.args, { shell: l.shell, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
    } catch (e) {
      out = "error: " + (e as Error).message.split("\n")[0];
    }
    toolOutputs.set(id, out);
  }
  return out;
}

/** The key of one run of a command: its definition, what it is given, its environment and its input files. */
export function cacheKey(root: string, c: Command, extra: string[], inputs: Resolved, env: Record<string, string | undefined>): string {
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify({
    cwd: c.cwd, run: c.run, env: c.env, failOnOutput: c.failOnOutput, extra,
    envKeys: c.envKeys.map((k) => [k, env[k] ?? null]),
    tools: c.tools.map(toolOutput),
    platform: process.platform, arch: process.arch, node: process.version,
    // only when declared, so that a command without outputs keeps the key it had before outputs existed
    ...(c.outputs.length ? { outputs: c.outputs } : {}),
  }));
  for (const f of inputs.files) h.update("\0" + f + "\0" + hashFile(path.join(root, f)));
  // after every file, and named "pnpm:<member>": a part never reads as a file entry
  for (const p of inputs.parts) h.update("\0" + p.name + "\0" + p.digest);
  return h.digest("hex");
}

/** When and how big each input was: a file changed and changed back during a run keeps its content (and the
 * key) but not its time, which this catches. The files parts are read from count whole: a `pnpm install`
 * during the run changes the lockfile, even where the part the key holds stays the same. */
export function signature(root: string, inputs: Resolved): string {
  return [...new Set([...inputs.files, ...inputs.parts.map((p) => p.file)])].sort().map((f) => {
    try {
      const s = fs.statSync(path.join(root, f));
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "missing";
    }
  }).join("|");
}

const recordPath = (dir: string, name: string, key: string) => path.join(dir, `${name.replace(/[^\w.-]/g, "_")}-${key}.json`);

/** Whether this exact run already passed. A record found is touched (its time set to now), so a cache can
 * keep only the records a run used: those older than the run's start were not. */
export function passed(dir: string, name: string, key: string): boolean {
  const file = recordPath(dir, name, key);
  if (!fs.existsSync(file)) return false;
  const now = new Date();
  try {
    fs.utimesSync(file, now, now);
  } catch {
    // a read-only cache still answers
  }
  return true;
}

export function recordPass(dir: string, name: string, key: string, ms: number): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(recordPath(dir, name, key), JSON.stringify({ ok: true, at: new Date().toISOString(), ms }) + "\n");
}

// glob matching that treats a name starting with "." like any other (a build may write .files): the dot that
// starts a segment is swapped for a character no path holds, in the path and in the pattern alike
const undot = (s: string) => s.replace(/(^|\/)\./g, "$1\u0001");
const matches = (file: string, pattern: string) => path.posix.matchesGlob(undot(file), undot(pattern));

/** The files the output patterns match on disk, sorted, relative to the root with "/" separators. Read from
 * the disk, not from git: what a command produces is usually ignored by git. */
export function resolveOutputs(root: string, patterns: string[]): string[] {
  const include = patterns.filter((p) => !p.startsWith("!"));
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  const found = new Set<string>();
  const walk = (rel: string, pattern: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      if (fs.existsSync(path.join(root, rel)) && matches(rel, pattern)) found.add(rel); // a file named whole
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r, pattern);
      else if (e.isFile() && matches(r, pattern)) found.add(r);
    }
  };
  // each pattern is looked for under its part without wildcards
  for (const p of include) {
    const segs = p.split("/");
    const fixed = segs.findIndex((s) => /[*?[\]{}]/.test(s));
    walk((fixed === -1 ? segs : segs.slice(0, fixed)).join("/"), p);
  }
  return [...found].filter((f) => !exclude.some((x) => matches(f, x))).sort();
}

// the outputs of a pass: plain copies under <record>.out/ (paths relative to the root kept), and the list of
// them in <record>.out.json, written last: a store cut short, or a cache pruned of some of its files, lacks
// a file the list names and counts as missing
const outputsPath = (dir: string, name: string, key: string) => recordPath(dir, name, key).replace(/\.json$/, ".out");

/** Sets a file's time to now, as `passed` does for records: a cache pruned of what a run did not use keeps it. */
function touch(file: string): void {
  const now = new Date();
  try {
    fs.utimesSync(file, now, now);
  } catch {
    // a read-only cache still answers
  }
}

/** Keeps a copy of `files` (relative to the root) with the record of `key`, and each file's mode in the list:
 * a cache moved by means that drop modes (CI artifacts are all 0644) still restores an executable. */
export function storeOutputs(dir: string, name: string, key: string, root: string, files: string[]): void {
  const target = outputsPath(dir, name, key);
  fs.rmSync(target + ".json", { force: true });
  fs.rmSync(target, { recursive: true, force: true });
  const modes: Record<string, number> = {};
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(target, f)), { recursive: true });
    fs.copyFileSync(path.join(root, f), path.join(target, f));
    modes[f] = fs.statSync(path.join(root, f)).mode & 0o777;
    touch(path.join(target, f));
  }
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(target + ".json", JSON.stringify({ files, modes }) + "\n");
}

/** Copies the outputs kept with the record of `key` back under the root, over what is there, each with the
 * mode it was stored with, and removes the files the output `patterns` match on disk that the pass did not
 * produce (a page dropped on this branch, a binary of another platform); "missing" when the cache does not
 * hold all of them (then nothing is copied or removed). */
export function restoreOutputs(dir: string, name: string, key: string, root: string, patterns: string[]): "restored" | "missing" {
  const target = outputsPath(dir, name, key);
  let files: unknown, modes: unknown;
  try {
    ({ files, modes } = JSON.parse(fs.readFileSync(target + ".json", "utf8")) as { files?: unknown; modes?: unknown });
  } catch {
    return "missing";
  }
  // a path leaving the root is never written, whatever the list says
  const safe = (f: unknown) => typeof f === "string" && f !== "" && !path.isAbsolute(f) && !f.split(/[\\/]/).includes("..");
  if (!Array.isArray(files) || !files.every((f) => safe(f) && fs.existsSync(path.join(target, f as string)))) return "missing";
  const stored = new Set(files as string[]);
  for (const f of resolveOutputs(root, patterns)) if (!stored.has(f)) fs.rmSync(path.join(root, f), { force: true });
  for (const f of files as string[]) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(target, f), path.join(root, f));
    // a list written before modes were kept has none: the copy keeps the stored copy's mode
    const mode = typeof modes === "object" && modes !== null ? (modes as Record<string, unknown>)[f] : undefined;
    if (typeof mode === "number") fs.chmodSync(path.join(root, f), mode & 0o777);
    touch(path.join(target, f));
  }
  touch(target + ".json");
  return "restored";
}
