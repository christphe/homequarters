// Pinned binaries that neither `go tool` nor the pnpm workspace can install (shellcheck and hadolint are
// Haskell programs, zizmor is Rust): each version is written here with the SHA-256 of every platform's
// release file, downloaded on first use into .tools/ (git-ignored), checked, unpacked, then run.
// The Go linters (golangci-lint, govulncheck, actionlint, gitleaks) are `go tool`s in tools/go/*/go.mod.
// Run: node scripts/tools.ts run <tool> [arg ...]          the tool, with its arguments
//      node scripts/tools.ts with <tool>[,<tool>] -- <command ...>   a command with those tools on PATH
// Decision 0040 (strict linters) says why each tool is here and how to bump one (new version, new hashes).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

type Platform = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "win32-x64";
type Asset = { url: string; sha256: string; /** the executable inside the archive, or absent for a bare binary */ member?: string };
export type Tool = { version: string; assets: Partial<Record<Platform, Asset>> };

const SC = "https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0";
const HL = "https://github.com/hadolint/hadolint/releases/download/v2.15.1/hadolint";
const ZZ = "https://github.com/zizmorcore/zizmor/releases/download/v1.31.1/zizmor";

export const TOOLS: Record<string, Tool> = {
  // GPL-3.0; run as a separate program, never linked or shipped
  shellcheck: {
    version: "0.11.0",
    assets: {
      "linux-x64": { url: `${SC}.linux.x86_64.tar.gz`, sha256: "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6", member: "shellcheck-v0.11.0/shellcheck" },
      "linux-arm64": { url: `${SC}.linux.aarch64.tar.gz`, sha256: "68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc", member: "shellcheck-v0.11.0/shellcheck" },
      "darwin-x64": { url: `${SC}.darwin.x86_64.tar.gz`, sha256: "c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51", member: "shellcheck-v0.11.0/shellcheck" },
      "darwin-arm64": { url: `${SC}.darwin.aarch64.tar.gz`, sha256: "339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f", member: "shellcheck-v0.11.0/shellcheck" },
      "win32-x64": { url: `${SC}.zip`, sha256: "8a4e35ab0b331c85d73567b12f2a444df187f483e5079ceffa6bda1faa2e740e", member: "shellcheck.exe" },
    },
  },
  // GPL-3.0; run as a separate program, never linked or shipped
  hadolint: {
    version: "2.15.1",
    assets: {
      "linux-x64": { url: `${HL}-linux-x86_64`, sha256: "c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507" },
      "linux-arm64": { url: `${HL}-linux-arm64`, sha256: "f6198ef8090f404dbb771abfee086eb8c48ac177f30da7fd3510aca35b344b5d" },
      "darwin-x64": { url: `${HL}-macos-x86_64`, sha256: "ffe9bb18b23d5ed1eae50237aecdbb523d016e96da0bd4e7aa432040acfc3fde" },
      "darwin-arm64": { url: `${HL}-macos-arm64`, sha256: "5c09f3213f8e40406abe048233d985eebef336d4a6a20021be47fadb6cf480a2" },
      "win32-x64": { url: `${HL}-windows-x86_64.exe`, sha256: "01d927294962b5387f9ead4f18679158452be4f17c765ad0bdffe5264b9c7b0a" },
    },
  },
  // MIT
  zizmor: {
    version: "1.31.1",
    assets: {
      "linux-x64": { url: `${ZZ}-x86_64-unknown-linux-gnu.tar.gz`, sha256: "d185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99", member: "zizmor" },
      "linux-arm64": { url: `${ZZ}-aarch64-unknown-linux-gnu.tar.gz`, sha256: "37eebbd5762a44f262d94875431b14a6d2402991e90a685113ea97b8b41be833", member: "zizmor" },
      "darwin-x64": { url: `${ZZ}-x86_64-apple-darwin.tar.gz`, sha256: "72ae63bb85b67229c06242f04195cb43927e9fab5f43803c6434dc701a517d61", member: "zizmor" },
      "darwin-arm64": { url: `${ZZ}-aarch64-apple-darwin.tar.gz`, sha256: "ad5aa633cd56215b11e6c51d51f90c7e6b22904a75047d1215abbd422f61d698", member: "zizmor" },
      "win32-x64": { url: `${ZZ}-x86_64-pc-windows-msvc.zip`, sha256: "4de30371c8a3b483aecbcf0dec1fd6a2b6aae65051ca226b4f6527baac6a8c7a", member: "zizmor.exe" },
    },
  },
};

export function platform(): Platform {
  const p = `${process.platform}-${process.arch}`;
  if (p === "linux-x64" || p === "linux-arm64" || p === "darwin-x64" || p === "darwin-arm64" || p === "win32-x64") return p;
  throw new Error(`tools: no pinned binaries for ${p}`);
}

/** The folder a tool's version is unpacked in, and the executable's path in it. */
export function location(name: string, tool: Tool, plat: Platform, base = path.join(root, ".tools")): { dir: string; exe: string } {
  const dir = path.join(base, `${name}-${tool.version}-${plat}`);
  const exe = plat === "win32-x64" ? `${name}.exe` : name;
  return { dir, exe: path.join(dir, exe) };
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** The tool's executable, downloaded, checked and unpacked first if it is not there yet. */
export async function ensure(name: string): Promise<string> {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`tools: unknown tool ${name} (known: ${Object.keys(TOOLS).join(", ")})`);
  const plat = platform();
  const asset = tool.assets[plat];
  if (!asset) throw new Error(`tools: no ${name} for ${plat}`);
  const { dir, exe } = location(name, tool, plat);
  if (fs.existsSync(exe)) return exe;
  // unpack into a fresh folder next to the final one, then rename: two runs at once never see half a tool
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const tmp = fs.mkdtempSync(dir + ".tmp-");
  try {
    const res = await fetch(asset.url, { redirect: "follow" });
    if (!res.ok) throw new Error(`tools: ${asset.url}: HTTP ${res.status}`);
    const file = path.join(tmp, path.basename(new URL(asset.url).pathname));
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const got = sha256(file);
    if (got !== asset.sha256) throw new Error(`tools: ${asset.url}: SHA-256 ${got}, expected ${asset.sha256}`);
    const out = path.join(tmp, path.basename(exe));
    if (asset.member) {
      // bsdtar reads .zip and .tar.gz alike; Windows ships it as System32\tar.exe (Git's GNU tar reads no zip)
      const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
      const r = spawnSync(tar, ["-xf", file, "-C", tmp, asset.member], { stdio: "inherit" });
      if (r.status !== 0) throw new Error(`tools: could not unpack ${file}`);
      fs.renameSync(path.join(tmp, asset.member), out);
    } else {
      fs.renameSync(file, out);
    }
    fs.chmodSync(out, 0o755);
    for (const f of fs.readdirSync(tmp)) if (f !== path.basename(out)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
    try {
      fs.renameSync(tmp, dir);
    } catch (e) {
      // another run got there first
      if (!fs.existsSync(exe)) throw e;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return exe;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "run" && rest[0]) {
    const exe = await ensure(rest[0]);
    const r = spawnSync(exe, rest.slice(1), { stdio: "inherit" });
    if (r.error) console.log(`${rest[0]} did not start: ${r.error.message}`);
    return r.status ?? 1;
  }
  const sep = rest.indexOf("--");
  if (cmd === "with" && rest[0] && sep === 1 && rest[2]) {
    const dirs = [];
    for (const name of rest[0].split(",")) dirs.push(path.dirname(await ensure(name)));
    const r = spawnSync(rest[2], rest.slice(3), {
      stdio: "inherit",
      env: { ...process.env, PATH: [...dirs, process.env.PATH].join(path.delimiter) },
      shell: false,
    });
    if (r.error) console.log(`${rest[2]} did not start: ${r.error.message}`);
    return r.status ?? 1;
  }
  console.log("usage: node scripts/tools.ts run <tool> [arg ...] | with <tool>[,<tool>] -- <command ...>");
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
