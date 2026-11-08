// The repository-wide linters, one subcommand each (the workspace's fdash tasks lint:actions, lint:secrets,
// lint:shell, lint:docker and lint:go-modules run them; decisions 0040, 0041):
//   actions  actionlint (with shellcheck on the run: scripts) and zizmor on .github/
//   secrets  gitleaks on the files git would commit (tracked and untracked, not ignored: the inputs fdash caches
//            it on), copied to a temporary folder; not the history
//   shell    shellcheck on every tracked *.sh
//   docker   hadolint on deploy/Dockerfile
//   go-modules  the server's Go modules: each declares the libraries it imports, one version of each dependency
//            across them (decision 0041); --fix raises the versions
// The Go tools are `go tool`s in tools/go/<tool>/go.mod; shellcheck, zizmor and hadolint are pinned downloads
// (scripts/tools.ts). Run: node scripts/lint-repo.ts <actions|secrets|shell|docker|go-modules [--fix]>
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localRequires } from "../tools/fdash/gomod.ts";
import { ensure } from "./tools.ts";

const root = path.resolve(import.meta.dirname, "..");

function run(cmd: string, args: string[], opts: { cwd?: string; path?: string[] } = {}): number {
  const env = opts.path ? { ...process.env, PATH: [...opts.path, process.env.PATH].join(path.delimiter) } : process.env;
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? root, env, stdio: "inherit" });
  if (r.error) console.log(`${cmd} did not start: ${r.error.message}`);
  return r.status ?? 1;
}

/** Tracked (or to-be-added) files matching git pathspecs, root-relative. */
export function gitFiles(specs: string[]): string[] {
  const r = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "--", ...specs], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error("git ls-files failed: " + r.stderr);
  return r.stdout.split("\n").filter(Boolean);
}

/** A Go tool pinned in tools/go/<name>/go.mod, built there (`go tool -n` prints the cached binary), run from the root. */
function goTool(name: string, args: string[], extraPath: string[] = [], cwd = root): number {
  const built = spawnSync("go", ["tool", "-n", name], { cwd: path.join(root, "tools", "go", name), encoding: "utf8" });
  if (built.error) {
    console.log(`go tool ${name}: go did not start (${built.error.message}); is Go on PATH?`);
    return 1;
  }
  const exe = built.stdout.trim();
  if (built.status !== 0 || !exe) {
    console.log(`go tool ${name}: ${built.stderr || "no binary"}`);
    return 1;
  }
  return run(exe, args, { path: extraPath, cwd });
}

/** gitleaks on a copy of the files git would commit, so an ignored local file (a log, a build) never turns the
 * gate red here while CI passes, and the pass is keyed on exactly what was scanned. Findings name the file,
 * line and rule (-v); --redact hides the value. */
function secrets(): number {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hq-gitleaks-"));
  try {
    for (const f of gitFiles(["."])) {
      const from = path.join(root, f);
      if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue; // deleted but still in the index
      fs.mkdirSync(path.join(tmp, path.dirname(f)), { recursive: true });
      fs.copyFileSync(from, path.join(tmp, f));
    }
    // "." from the copy: the allow-list's paths are root-relative
    return goTool("gitleaks", ["dir", ".", "--config", path.join(root, ".gitleaks.toml"), "--no-banner", "--redact", "-v", "--exit-code", "1"], [], tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The server's Go modules (decision 0041): each folder holding a go.mod, its module path and its go.mod text. */
function serverModules(): { dir: string; path: string; text: string }[] {
  return gitFiles(["server/**/go.mod"]).filter((f) => fs.existsSync(path.join(root, f))).map((f) => {
    const text = fs.readFileSync(path.join(root, f), "utf8");
    return { dir: path.posix.dirname(f), path: /^module\s+(\S+)/m.exec(text)?.[1] ?? "", text };
  });
}

/** Each module declares the libraries it imports (tests included), and replaces every library it reaches through
 * them: Go reads only the main module's replace directives. The message says what to run, since Go's own (`is
 * not in std`, `missing dot in first path element`) does not. Local requires are at v0.0.0. */
function localRequireProblems(modules: { dir: string; path: string; text: string }[]): string[] {
  const byPath = new Map(modules.map((m) => [m.path, m]));
  const local = new Map(modules.map((m) => [m.path, new Set(localRequires(m.text).map((r) => r.module))]));
  const problems: string[] = [];
  const fix = (m: { dir: string }, lib: { dir: string; path: string }) =>
    `(cd ${m.dir} && go mod edit -require=${lib.path}@v0.0.0 -replace=${lib.path}=${path.posix.relative(m.dir, lib.dir)} && go mod tidy)`;
  for (const m of modules) {
    const listed = spawnSync("go", ["list", "-e", "-f", "{{range .Imports}}{{.}}\n{{end}}{{range .TestImports}}{{.}}\n{{end}}{{range .XTestImports}}{{.}}\n{{end}}", "./..."],
      { cwd: path.join(root, m.dir), env: { ...process.env, GOWORK: "off", GOFLAGS: "" }, encoding: "utf8" });
    if (listed.status !== 0) {
      problems.push(`${m.dir}: go list failed: ${listed.stderr.trim()}`);
      continue;
    }
    const mine = local.get(m.path)!;
    const owners = new Set(listed.stdout.split(/\r?\n/).flatMap((imp) => {
      const owner = modules.find((o) => imp === o.path || imp.startsWith(o.path + "/"));
      return owner && owner !== m ? [owner] : [];
    }));
    for (const o of owners) if (!mine.has(o.path)) problems.push(`${m.dir}: imports ${o.path} without requiring and replacing it: ${fix(m, o)}`);
    // what the libraries it requires require, transitively
    const reached = new Set<string>();
    const walk = (p: string) => { for (const d of local.get(p) ?? []) if (!reached.has(d)) { reached.add(d); walk(d); } };
    walk(m.path);
    for (const p of reached) {
      const lib = byPath.get(p);
      if (lib && !mine.has(p)) problems.push(`${m.dir}: reaches ${p} through a library it requires, but does not replace it: ${fix(m, lib)}`);
    }
    for (const r of m.text.matchAll(/^\s*(?:require\s+)?(\S+)\s+(v\S+)/gm)) {
      if (byPath.has(r[1]) && r[2] !== "v0.0.0") problems.push(`${m.dir}: requires ${r[1]} at ${r[2]}: a library of this repository is required at v0.0.0 (go mod edit -require=${r[1]}@v0.0.0)`);
    }
  }
  return problems;
}

/** The server's Go modules hold together (decision 0041). First, each declares the libraries it uses (above).
 * Then one version of each third-party module across them: `go work sync`, in a copy of server/ in a temporary
 * folder with a go.work that uses every module, raises each one's requirements to the versions the modules
 * select together. A go.mod it changed held an older version than another module's: the check fails with the
 * change (--fix writes it into the tree). The tree is never written otherwise, and no go.work is left anywhere:
 * with one, Go would accept imports a go.mod does not declare. */
function goModules(fix: boolean): number {
  const modules = serverModules();
  const problems = localRequireProblems(modules);
  for (const p of problems) console.log(p);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hq-gowork-"));
  const raised: string[] = [];
  try {
    const copy = path.join(tmp, "tree");
    for (const f of gitFiles(["server/**"])) {
      const from = path.join(root, f);
      if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
      fs.mkdirSync(path.join(copy, path.dirname(f)), { recursive: true });
      fs.copyFileSync(from, path.join(copy, f));
    }
    const env = { ...process.env, GOWORK: path.join(tmp, "go.work"), GOFLAGS: "" };
    // quiet: Go may say it switches toolchain, which is no finding
    const go = (args: string[], cwd: string) => {
      const r = spawnSync("go", args, { cwd, env, encoding: "utf8" });
      if (r.status !== 0) console.log(`go ${args.join(" ")}: ${r.stderr.trim()}`);
      return r.status === 0;
    };
    if (!go(["work", "init", ...modules.map((m) => path.join(copy, m.dir))], tmp)) return 1;
    // the go.work asks for the newest go line of its modules (init writes the running Go's, which may be older)
    const newest = modules.flatMap((m) => /^go (\S+)/m.exec(m.text)?.[1] ?? []).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1);
    if (newest && !go(["work", "edit", "-go=" + newest], tmp)) return 1;
    if (!go(["work", "sync"], tmp)) return 1;
    for (const m of modules) {
      for (const name of ["go.mod", "go.sum"]) {
        const synced = path.join(copy, m.dir, name);
        const now = fs.existsSync(synced) ? fs.readFileSync(synced, "utf8") : null;
        const was = fs.existsSync(path.join(root, m.dir, name)) ? fs.readFileSync(path.join(root, m.dir, name), "utf8") : null;
        if (now === was) continue;
        if (name === "go.mod") {
          const old = new Set((was ?? "").split("\n"));
          console.log(`${m.dir}/go.mod: ${now!.split("\n").filter((l) => !old.has(l)).map((l) => l.trim()).join("; ")} (other modules select these versions)`);
          raised.push(m.dir);
        }
        if (fix && now !== null) fs.writeFileSync(path.join(root, m.dir, name), now);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (raised.length) console.log(fix ? "go.mod files raised: commit them" : "one version per module: run `node scripts/lint-repo.ts go-modules --fix` to raise them, then commit");
  const failed = problems.length > 0 || raised.length > 0;
  if (!failed) console.log(`${modules.length} Go modules: each declares the libraries it uses, one version of each dependency`);
  return failed ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  switch (argv[0]) {
    case "actions": {
      // actionlint finds .github/workflows from its folder up, and runs shellcheck on each run: script
      const shellcheck = path.dirname(await ensure("shellcheck"));
      const a = goTool("actionlint", [], [shellcheck]);
      // offline: the online audits (known-vulnerable actions, impostor commits) would make the result change
      // with GitHub's data instead of with the files, which fdash's cache cannot see
      const z = run(await ensure("zizmor"), ["--offline", "--no-progress", ".github"]);
      return a || z;
    }
    case "secrets":
      return secrets();
    case "shell":
      return run(await ensure("shellcheck"), ["--format=gcc", ...gitFiles(["*.sh"])]);
    case "docker":
      return run(await ensure("hadolint"), ["--no-color", "deploy/Dockerfile"]);
    case "go-modules":
      if (argv.length > 2 || (argv[1] !== undefined && argv[1] !== "--fix")) break;
      return goModules(argv[1] === "--fix");
    default:
      console.log("usage: node scripts/lint-repo.ts <actions|secrets|shell|docker|go-modules [--fix]>");
      return 2;
  }
  console.log("usage: node scripts/lint-repo.ts <actions|secrets|shell|docker|go-modules [--fix]>");
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e: unknown) => {
      console.log(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    },
  );
}
