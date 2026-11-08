// Runner for the browser scenarios of a plugin's e2e project (plugins/e2e/<plugin>-e2e): real Chrome against
// `homequarters testbed` (the real server, no LiveKit; server/internal/testbed) serving the built client.
//
//   node e2e/plugin-run.ts --plugin DIR [--plugin DIR]... SCENARIO.ts... [NAME...]
//
// Each --plugin folder is loaded and enabled; each SCENARIO.ts exports run(ctx) (lib.ts's Scenario). Paths are
// relative to the current folder. NAMEs (a scenario's file name without .ts) pick some of the scenarios: fdash
// appends the items still to run that way when the project declares items. Needs bin/homequarters[.exe] (or
// HQ_BIN) and web/dist: "node tools/fdash/cli.ts run build --pkg server --pkg web"; this runner builds nothing.
//
// Like run.ts it takes an e2e slot (slots.ts) and serves on the slot's server port, joins the office's first
// member (its administrator) and gives every scenario a RunContext; startServer, stopServer and defer throw:
// they need run.ts's server and LiveKit. On a CI runner (CI set) it takes no slot and any free port. Writes
// each scenario's outcome to FDASH_REPORT when fdash gives one, and ends with ALL SCENARIOS PASSED or SOME
// CHECKS FAILED. Its temporary folder (homequarters-plugin-e2e-*: database, server log) is removed after a pass
// and kept after a failure. The environment reaches the testbed unchanged: it refuses HQ_ENV=production.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chrome } from "./env.ts";
import { acquire, parseMax, ports } from "./slots.ts";
import type { RunContext, Scenario } from "./lib.ts";

export type PluginRunArgs = { plugins: string[]; scenarios: string[]; names: string[] };

export const USAGE = "usage: node e2e/plugin-run.ts --plugin DIR [--plugin DIR]... SCENARIO.ts... [NAME...]";

/** The command line: --plugin folders, scenario files (ending in .ts) and names picking some of them. Throws on a mistake. */
export function parseArgs(argv: string[]): PluginRunArgs {
  const out: PluginRunArgs = { plugins: [], scenarios: [], names: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plugin" || a.startsWith("--plugin=")) {
      const v = a === "--plugin" ? argv[++i] : a.slice("--plugin=".length);
      if (!v || v.startsWith("-")) throw new Error("--plugin needs a folder");
      out.plugins.push(v);
    } else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else if (a.endsWith(".ts")) out.scenarios.push(a);
    else out.names.push(a);
  }
  if (!out.plugins.length) throw new Error("give at least one --plugin folder");
  if (!out.scenarios.length) throw new Error("give at least one scenario file (SCENARIO.ts)");
  return out;
}

/** A scenario's name: its file name without .ts (the fdash item it reports). */
export const scenarioName = (file: string) => path.basename(file, ".ts");

/** The scenario files to run: all of them, or those whose name is in `names` (each name must be one). */
export function pick(scenarios: string[], names: string[]): string[] {
  if (!names.length) return scenarios;
  const known = scenarios.map(scenarioName);
  const unknown = names.filter((n) => !known.includes(n));
  if (unknown.length) throw new Error(`no scenario named ${unknown.join(", ")} (scenarios: ${known.join(", ")})`);
  return scenarios.filter((s) => names.includes(scenarioName(s)));
}

const unavailable = (what: string) => () => { throw new Error(`${what} is not available without LiveKit (plugin-run.ts runs the testbed): use run.ts`); };

async function main(): Promise<number> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  chrome(); // nothing runs without it: stop before starting anything
  let args: PluginRunArgs, files: string[];
  try {
    args = parseArgs(process.argv.slice(2));
    files = pick(args.scenarios, args.names).map((f) => path.resolve(f));
  } catch (e) {
    console.log(`# ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const plugins = args.plugins.map((p) => path.resolve(p));
  const missing = [...plugins.filter((p) => !fs.existsSync(path.join(p, "plugin.json"))).map((p) => `${p} (no plugin.json)`), ...files.filter((f) => !fs.existsSync(f))];
  if (missing.length) { console.log(`# not found: ${missing.join(", ")}`); return 2; }

  const WIN = process.platform === "win32";
  // under fdash (HQ_BIN_REPO_ONLY, set by the tasks) only the repository's binary, the one the cache keys
  if (process.env.HQ_BIN && process.env.HQ_BIN_REPO_ONLY === "1") { console.log('# HQ_BIN is not taken by this fdash task: its cache keys bin/homequarters, built by "node tools/fdash/cli.ts run build --pkg server"; unset HQ_BIN'); return 2; }
  const bin = process.env.HQ_BIN ? path.resolve(process.env.HQ_BIN) : path.join(root, "bin", WIN ? "homequarters.exe" : "homequarters");
  const absent = [bin, path.join(root, "web", "dist", "index.html")].filter((f) => !fs.existsSync(f));
  if (absent.length) { console.log(`# ${absent.join(", ")} missing: run "node tools/fdash/cli.ts run build --pkg server --pkg web" first`); return 1; }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const portOpen = (p: number) => new Promise<boolean>((res) => { const s = net.connect(p, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });

  // A local run holds an e2e slot, as run.ts does, so browser runs side by side stay under E2E_MAX_PARALLEL;
  // the slot gives the server port (HQ_TEST_PORT overrides it). No LiveKit: only that port is checked.
  let port = 0;
  if (process.env.HQ_TEST_PORT) port = Number(process.env.HQ_TEST_PORT);
  if (!process.env.CI) {
    let max: number;
    try { max = parseMax(process.env.E2E_MAX_PARALLEL); } catch (e) { console.log("# " + (e as Error).message); return 1; }
    const own = !process.env.HQ_TEST_PORT;
    const held = await acquire({ max, portsFree: async (k) => own && (await portOpen(ports(k).server)) ? `port ${ports(k).server} in use` : true });
    process.on("exit", held.release);
    if (own) port = ports(held.slots[0]).server;
    console.log(`# e2e slot ${held.slots[0]} of ${max} (E2E_MAX_PARALLEL)`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "homequarters-plugin-e2e-"));
  const logFile = path.join(dir, "server.log");
  const log = fs.openSync(logFile, "a");
  const bedArgs = ["testbed", "--addr", `127.0.0.1:${port}`, "--static", path.join(root, "web", "dist"), "--db", path.join(dir, "testbed.db")];
  for (const p of plugins) bedArgs.push("--plugin", p);
  // stdin stays open: the testbed stops when it closes, so it never outlives this process, however it ends.
  // The environment goes through as it is: the testbed itself refuses HQ_ENV=production.
  const child: ChildProcess = spawn(bin, bedArgs, { stdio: ["pipe", "pipe", log], windowsHide: true });
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  let stopping: Promise<void> | null = null;
  const stop = () => stopping ??= (async () => {
    child.stdin?.end();
    const timer = setTimeout(() => child.kill(), 15000);
    await exited;
    clearTimeout(timer);
  })();
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, () => { console.log("\n# interrupted: stopping the testbed"); void Promise.race([stop(), sleep(5000)]).then(() => process.exit(130)); });

  let url: string;
  try {
    const lines = readline.createInterface({ input: child.stdout! });
    const first = await Promise.race([
      new Promise<string>((r) => lines.once("line", r)),
      exited.then((code) => Promise.reject(new Error(`homequarters testbed exited (${code}) before it was ready`))),
      new Promise<never>((_, reject) => child.once("error", reject)),
      sleep(30000).then(() => Promise.reject(new Error("homequarters testbed not ready after 30 s"))),
    ]);
    lines.close();
    child.stdout!.resume(); // nothing more is printed there, but never let a full pipe block it
    url = (JSON.parse(first) as { url: string }).url;
  } catch (e) {
    console.log(`# ${(e as Error).message}\n# ${bin} ${bedArgs.join(" ")}\n# server log: ${logFile}\n${fs.readFileSync(logFile, "utf8").split("\n").slice(-20).join("\n")}`);
    child.kill();
    return 1;
  }
  // lib.ts reads them when it loads: set before any import of it (the scenarios' included)
  process.env.HQ_APP = process.env.HQ_API = url;
  console.log(`# testbed ${url} with ${plugins.map((p) => path.relative(root, p)).join(", ")}; no LiveKit`);
  console.log("# server logs:", logFile);

  let ok = true;
  const outcome = new Map<string, boolean>();
  const ctx: RunContext = { dir, bin, server: child, adminCookie: "", adminId: 0, defer: unavailable("defer"), startServer: unavailable("startServer"), stopServer: unavailable("stopServer") };
  try {
    // the first member of an office is its administrator
    const r = await fetch(url + "/api/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Admin", avatar: { sk: 2, hs: 2, hc: 0, sh: 6, pa: 0 } }) });
    if (!r.ok) throw new Error(`joining the administrator: ${r.status} ${await r.text()}`);
    ctx.adminCookie = r.headers.get("set-cookie")!.split(";")[0].split("=")[1];
    ctx.adminId = ((await r.json()) as { id: number }).id;
    for (const file of files) {
      const name = scenarioName(file);
      console.log(`\n== ${name} ==`);
      const mod = (await import(pathToFileURL(file).href)) as Scenario;
      const passed = await mod.run(ctx);
      outcome.set(name, passed);
      ok = ok && passed;
    }
  } catch (e) {
    console.error("runner error:", e);
    ok = false;
  } finally {
    await stop();
  }
  if (process.env.FDASH_REPORT) for (const [item, passed] of outcome) fs.appendFileSync(process.env.FDASH_REPORT, JSON.stringify({ item, ok: passed }) + "\n");
  // the run's folder (database, server log, what scenarios wrote) is kept only to look at a failure
  fs.closeSync(log);
  if (ok) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  else console.log(`# kept for inspection: ${dir}`);
  console.log(ok ? "\nALL SCENARIOS PASSED" : "\nSOME CHECKS FAILED");
  return ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
