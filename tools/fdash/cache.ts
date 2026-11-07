// fdash's cache: the files a command reads (its inputs), the key that names one exact run of it, and the
// records of the runs that passed. Only passes are recorded; a key that is recorded is never run again.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Command, Input } from "./config.ts";
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
  const lists = ["GoFiles", "CgoFiles", "EmbedFiles", ...(input.tests ? ["TestGoFiles", "XTestGoFiles"] : [])];
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

/** Every file of the inputs, sorted, relative to the root with "/" separators. */
export function resolveInputs(root: string, inputs: Input[]): string[] {
  const patterns = inputs.filter((i): i is string => typeof i === "string");
  const files = new Set(globFiles(root, patterns));
  const excluded = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  // a "!" pattern removes from the whole set, the files of Go packages included
  for (const i of inputs) if (typeof i !== "string") for (const f of goFiles(root, i)) if (!excluded.some((x) => path.posix.matchesGlob(f, x))) files.add(f);
  return [...files].sort();
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
export function cacheKey(root: string, c: Command, extra: string[], files: string[], env: Record<string, string | undefined>): string {
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify({
    cwd: c.cwd, run: c.run, env: c.env, failOnOutput: c.failOnOutput, extra,
    envKeys: c.envKeys.map((k) => [k, env[k] ?? null]),
    tools: c.tools.map(toolOutput),
    platform: process.platform, arch: process.arch, node: process.version,
  }));
  for (const f of files) h.update("\0" + f + "\0" + hashFile(path.join(root, f)));
  return h.digest("hex");
}

const recordPath = (dir: string, name: string, key: string) => path.join(dir, `${name.replace(/[^\w.-]/g, "_")}-${key}.json`);

export function passed(dir: string, name: string, key: string): boolean {
  return fs.existsSync(recordPath(dir, name, key));
}

export function recordPass(dir: string, name: string, key: string, ms: number): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(recordPath(dir, name, key), JSON.stringify({ ok: true, at: new Date().toISOString(), ms }) + "\n");
}
