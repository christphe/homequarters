// The repository-wide linters, one subcommand each (the workspace's fdash tasks lint:actions, lint:secrets,
// lint:shell and lint:docker run them; decision 0040):
//   actions  actionlint (with shellcheck on the run: scripts) and zizmor on .github/
//   secrets  gitleaks on the working tree (.gitleaks.toml), not the history
//   shell    shellcheck on every tracked *.sh
//   docker   hadolint on deploy/Dockerfile
// The Go tools are `go tool`s in tools/go/<tool>/go.mod; shellcheck, zizmor and hadolint are pinned downloads
// (scripts/tools.ts). Run: node scripts/lint-repo.ts <actions|secrets|shell|docker>
import { spawnSync } from "node:child_process";
import path from "node:path";
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
function goTool(name: string, args: string[], extraPath: string[] = []): number {
  const built = spawnSync("go", ["tool", "-n", name], { cwd: path.join(root, "tools", "go", name), encoding: "utf8" });
  const exe = built.stdout.trim();
  if (built.status !== 0 || !exe) {
    console.log(`go tool ${name}: ${built.stderr || "no binary"}`);
    return 1;
  }
  return run(exe, args, { path: extraPath });
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
      // "." from the root: the allow-list's paths are root-relative
      return goTool("gitleaks", ["dir", ".", "--config", ".gitleaks.toml", "--no-banner", "--redact", "--exit-code", "1"]);
    case "shell":
      return run(await ensure("shellcheck"), ["--format=gcc", ...gitFiles(["*.sh"])]);
    case "docker":
      return run(await ensure("hadolint"), ["--no-color", "deploy/Dockerfile"]);
    default:
      console.log("usage: node scripts/lint-repo.ts <actions|secrets|shell|docker>");
      return 2;
  }
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
