// Self-contained acceptance runner: fresh SQLite DB, production-style static serving,
// real Chrome (fake camera/mic) and a real LiveKit server. Usage: node run.ts [--shard i/n] [scenario ...]
// --shard i/n runs only shard i of n (see shards.ts); E2E_PARALLELISM=N runs the whole suite as N shards
// at once, each with its own server, LiveKit and Chrome (see parallel.ts).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { chrome } from "./env.ts";
import { ALL, shard, parseShard, shardsFor } from "./shards.ts";
import { acquire, parseMax, ports } from "./slots.ts";
import { LK_IMAGE, liveKitMode, startLiveKit, stopLiveKit, sweepOrphans, type LiveKit, type LiveKitMode } from "./livekit.ts";
import type { RunContext, Scenario } from "./lib.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
chrome(); // the suite cannot run without it: stop before building anything
// HQ_EXTERNAL_URL=http://127.0.0.1:8080 runs the scenarios against an already running stack (for example
// the Docker Compose one). Scenarios that restart the server or spawn the local binary are skipped there.
const EXTERNAL = process.env.HQ_EXTERNAL_URL ?? "";
// A shard of an E2E_PARALLELISM run: the parent holds its slot and gives it its ports and LiveKit.
const SHARD_CHILD = !!process.env.E2E_SHARD_CHILD;
// ports given by hand (a shard gets its own from its parent): what answers there may not be what this run built
const USER_PORTS = !SHARD_CHILD && !!(process.env.HQ_TEST_PORT || process.env.HQ_TEST_LK_PORT);

const args = process.argv.slice(2);
const shardAt = args.findIndex((a) => a === "--shard" || a.startsWith("--shard="));
const shardSpec = shardAt < 0 ? null : args[shardAt].includes("=") ? args[shardAt].slice(8) : args[shardAt + 1];
const names = shardAt < 0 ? args : args.filter((_, k) => k !== shardAt && (args[shardAt].includes("=") || k !== shardAt + 1));
const listed = names.length ? names : EXTERNAL ? ["proximity", "consent", "rooms"] : ALL;
let wanted = listed;
if (shardSpec) { const { i, n } = parseShard(shardSpec); wanted = shard(listed, i, n); console.log(`# shard ${i}/${n}: ${wanted.join(", ") || "(empty)"}`); }
const PARALLEL = shardsFor(Number(process.env.E2E_PARALLELISM ?? "1") || 1, listed.length);
const parallelRun = PARALLEL > 1 && !shardSpec && !EXTERNAL;

// Windows: go build names the binary as given, while spawning "bin/homequarters" runs a stale homequarters.exe;
// pnpm is a .cmd that only a shell finds; and a signal from Node is a hard kill (see stopServer).
const WIN = process.platform === "win32";
const BIN = path.join(root, "bin", WIN ? "homequarters.exe" : "homequarters");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const portOpen = (p: number) => new Promise<boolean>((res) => { const s = net.connect(p, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });

// Until the run has something to stop, a signal just exits (the exit handlers release the slot).
let onSignal: (() => unknown) | null = () => process.exit(130);
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, () => onSignal?.());

// A local run takes an e2e slot (one per shard) before it builds or starts anything, waiting while
// E2E_MAX_PARALLEL runs hold them all (slots.ts). The slot gives its ports and its own LiveKit, never the
// dev stack's on 7880; HQ_TEST_PORT and HQ_TEST_LK_PORT still override (then no LiveKit is started).
// On a CI runner (CI set, as GitHub Actions does) each job is one run of its own (the suite is split
// beforehand with --shard): no slot to take, the default ports, and its LiveKit on 7880 as before.
const oneRunner = !!process.env.CI;
let slots: number[] = [];
let lkMode: LiveKitMode | null = null;
const ownLiveKit = !EXTERNAL && !SHARD_CHILD && (parallelRun || !process.env.HQ_TEST_LK_PORT);
if (oneRunner && ownLiveKit) {
  lkMode = liveKitMode();
  if (!lkMode) { console.log("# the e2e suite starts its own LiveKit: put livekit-server on PATH"); process.exit(1); }
}
if (!EXTERNAL && !SHARD_CHILD && !oneRunner) {
  let max: number;
  try { max = parseMax(process.env.E2E_MAX_PARALLEL); } catch (e) { console.log("# " + (e as Error).message); process.exit(1); }
  const need = parallelRun ? PARALLEL : 1;
  if (need > max) { console.log(`# E2E_PARALLELISM=${need} needs ${need} e2e slots but E2E_MAX_PARALLEL is ${max}: lower E2E_PARALLELISM or raise E2E_MAX_PARALLEL (.env)`); process.exit(1); }
  if (ownLiveKit) {
    lkMode = liveKitMode();
    if (!lkMode) { console.log("# the e2e suite starts its own LiveKit: put livekit-server on PATH or start Docker (or set HQ_TEST_LK_PORT to a LiveKit already running)"); process.exit(1); }
    if (lkMode === "docker") sweepOrphans();
  }
  const ownServerPorts = parallelRun || !process.env.HQ_TEST_PORT;
  const portsFree = async (k: number) => {
    const p = ports(k);
    for (const q of [...(ownServerPorts ? [p.server, p.auth] : []), ...(ownLiveKit ? [p.lk, p.lk + 1] : [])]) if (await portOpen(q)) return `port ${q} in use`;
    return true;
  };
  const held = await acquire({ n: need, max, portsFree });
  process.on("exit", held.release);
  slots = held.slots;
  console.log(`# e2e slot${slots.length > 1 ? "s" : ""} ${slots.join(", ")} of ${max} (E2E_MAX_PARALLEL)`);
}

const PORT = process.env.HQ_TEST_PORT ?? String(slots.length ? ports(slots[0]).server : 18080);
process.env.HQ_TEST_PORT = PORT; // the auth scenario starts its second server on PORT + 10
process.env.HQ_APP = process.env.HQ_API = EXTERNAL || `http://127.0.0.1:${PORT}`;
const LK_PORT = Number(process.env.HQ_TEST_LK_PORT ?? (slots.length && ownLiveKit ? ports(slots[0]).lk : 7880));
process.env.HQ_LK_HTTP ??= `http://127.0.0.1:${LK_PORT}`;
process.env.HQ_TEST_LK_URL = `ws://127.0.0.1:${LK_PORT}`;

// E2E_PREBUILT=1 (fdash's test:e2e): the build tasks of server and web made bin/ and web/dist from the same
// sources this run is keyed on, so nothing is built here and the results are recorded as usual.
const PREBUILT = !!process.env.E2E_PREBUILT;
if (PREBUILT && !process.env.SKIP_BUILD && !EXTERNAL) {
  const absent = [BIN, path.join(root, "web", "dist", "index.html")].filter((f) => !fs.existsSync(f));
  if (absent.length) { console.log(`# E2E_PREBUILT: ${absent.map((f) => path.relative(root, f)).join(", ")} missing: run "node tools/fdash/cli.ts run build" first`); process.exit(1); }
}
if (!process.env.SKIP_BUILD && !PREBUILT && !EXTERNAL) {
  console.log("# building web + server");
  execFileSync("pnpm", ["build"], { cwd: path.join(root, "web"), stdio: "inherit", shell: WIN });
  execFileSync("go", ["build", "-o", BIN, "."], { cwd: path.join(root, "server", "cmd", "homequarters"), stdio: "inherit", env: { ...process.env, GOWORK: "off" } });
}

// The whole local suite in E2E_PARALLELISM shards at once; the build above is the only shared step.
if (parallelRun) {
  onSignal = null; // runParallel stops its shards and LiveKit itself
  const { runParallel } = await import("./parallel.ts");
  const ok = await runParallel({ n: PARALLEL, scenarios: listed, slots, mode: lkMode });
  // the shards report their scenarios; a run whose build was skipped by its caller records nothing (see below)
  if (process.env.FDASH_REPORT && process.env.SKIP_BUILD) fs.appendFileSync(process.env.FDASH_REPORT, JSON.stringify({ nocache: true }) + "\n");
  console.log(ok ? "\nALL SCENARIOS PASSED" : "\nSOME CHECKS FAILED");
  process.exit(ok ? 0 : 1);
}

let lk: LiveKit | null = null;
if (ownLiveKit) {
  console.log(`# starting LiveKit on ${LK_PORT} (${lkMode === "binary" ? "livekit-server" : "Docker, " + LK_IMAGE})`);
  process.on("exit", () => stopLiveKit(lk));
  lk = await startLiveKit({ port: LK_PORT, mode: lkMode, name: `hq-e2e-lk-${process.pid}-${Date.now().toString(36)}`, log: path.join(os.tmpdir(), `homequarters-e2e-livekit-${process.pid}.log`) });
  if (lk.failed) { console.log("# " + lk.failed); process.exit(1); }
} else if (!EXTERNAL && !(await portOpen(LK_PORT))) { console.log("# no LiveKit on " + LK_PORT + " (HQ_TEST_LK_PORT): start one there first"); process.exit(1); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "homequarters-e2e-"));
// the bundled plugins (plugins/bundled) plus the suite's own installed ones (e2e/fixtures/plugins/installed), all disabled
// until a scenario enables one
const pluginsDir = path.join(dir, "plugins");
fs.cpSync(path.join(root, "plugins/bundled"), path.join(pluginsDir, "bundled"), { recursive: true });
fs.cpSync(path.join(root, "e2e/fixtures/plugins/installed"), path.join(pluginsDir, "installed"), { recursive: true });
// Checks that only need time to pass (an expiring token) run after the other scenarios instead of sleeping in theirs.
const deferred: { name: string; due: number; fn: () => Promise<unknown>; scenario: string | null }[] = [];
// the scenario running, so that a deferred check counts for the scenario that registered it
let current: string | null = null;
// adminCookie and adminId are set once the administrator has joined, before any scenario runs
const ctx = { dir, bin: BIN, server: null, defer(name: string, due: number, fn: () => Promise<unknown>) { deferred.push({ name, due, fn, scenario: current }); }, async startServer() {
  const child = spawn(BIN, [], {
    env: { ...process.env, HQ_ENV: "dev", HQ_ADDR: `127.0.0.1:${PORT}`, HQ_DB: path.join(dir, "e2e.db"), HQ_STATIC_DIR: path.join(root, "web/dist"), HQ_PLUGINS_DIR: pluginsDir,
      HQ_ALLOWED_ORIGINS: `127.0.0.1:${PORT}`, LIVEKIT_URL: process.env.HQ_TEST_LK_URL, LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret",
      HQ_JOIN_RATE: "5000", HQ_MEDIA_TOKEN_TTL_SECONDS: process.env.HQ_MEDIA_TOKEN_TTL_SECONDS ?? "20", HQ_MEDIA_RECONCILE_SECONDS: process.env.HQ_MEDIA_RECONCILE_SECONDS ?? "3",
      ...(WIN ? { HQ_STOP_ON_STDIN_CLOSE: "1" } : {}) },
    stdio: [WIN ? "pipe" : "ignore", fs.openSync(path.join(dir, "server.log"), "a"), fs.openSync(path.join(dir, "server.log"), "a")],
  });
  ctx.server = child;
  for (let i = 0; i < 50 && !(await portOpen(Number(PORT))); i++) await sleep(100);
}, async stopServer() {
  if (!ctx.server) return;
  const c = ctx.server; ctx.server = null;
  const done = new Promise((r) => c.once("exit", r));
  // a graceful stop saves positions and whiteboards; on Windows closing stdin asks for it (a signal would kill)
  if (WIN) c.stdin!.end(); else c.kill("SIGTERM");
  const timer = setTimeout(() => c.kill("SIGKILL"), 15000);
  await done;
  clearTimeout(timer);
} } as RunContext;
// On Ctrl+C (Ctrl+Break on Windows) or a signal the run stops its server and LiveKit and exits, which
// releases its slot. A shard started by parallel.ts also stops when its stdin closes (on Windows a
// signal from Node is a hard kill). Exiting also closes the Chrome puppeteer launched.
let stopping = false;
onSignal = async () => {
  if (stopping) return;
  stopping = true;
  console.log(SHARD_CHILD ? "# shard stopped" : "\n# interrupted: stopping the server and LiveKit");
  await Promise.race([ctx.stopServer(), sleep(5000)]);
  process.exit(130);
};
if (SHARD_CHILD && WIN) { process.stdin.on("end", onSignal); process.stdin.on("close", onSignal); process.stdin.resume(); }
if (!EXTERNAL) await ctx.startServer();
console.log("# server logs:", path.join(dir, "server.log"));

let ok = true;
// each scenario's result, written to FDASH_REPORT when fdash runs the suite (it caches scenarios one by one)
const outcome = new Map<string, boolean>();
try {
  // Bootstrap the office admin (the first member of an office becomes admin).
  const r = await fetch(process.env.HQ_API + "/api/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Admin", avatar: { sk: 2, hs: 2, hc: 0, sh: 6, pa: 0 } }) });
  const cookie = r.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  ctx.adminCookie = cookie;
  ctx.adminId = ((await r.json()) as { id: number }).id;
  for (const name of wanted) {
    console.log(`\n== ${name} ==`);
    current = name;
    const mod = (await import(`./scenarios/${name}.ts`)) as Scenario;
    const t0 = Date.now();
    const passed = await mod.run(ctx);
    // what e2e/shards.ts's DURATIONS are read from (a CI shard prints its output whole, at the end)
    console.log(`# ${name} took ${Math.round((Date.now() - t0) / 1000)} s`);
    outcome.set(name, passed);
    ok = ok && passed;
  }
} catch (e) {
  console.error("runner error:", e);
  ok = false;
} finally {
  await ctx.stopServer();
  // deferred checks run even when a scenario aborted the loop; they need only the SFU (stopped right after)
  const { resetChecks, summary, check } = await import("./lib.ts");
  for (const d of deferred.sort((x, y) => x.due - y.due)) {
    console.log(`\n== ${d.name} (deferred) ==`);
    await sleep(Math.max(0, d.due - Date.now()));
    resetChecks();
    await d.fn().catch((e: unknown) => check("deferred check ran", false, String(e)));
    const passed = summary();
    if (!passed && d.scenario !== null && outcome.has(d.scenario)) outcome.set(d.scenario, false);
    ok = passed && ok;
  }
  stopLiveKit(lk);
}
if (process.env.FDASH_REPORT) {
  for (const [item, passed] of outcome) fs.appendFileSync(process.env.FDASH_REPORT, JSON.stringify({ item, ok: passed }) + "\n");
  // without a build (SKIP_BUILD) the scenarios ran on whatever bin/ and web/dist held: nothing proves they match
  // the sources fdash keyed them on, so nothing is recorded; neither for a stack someone else runs (HQ_EXTERNAL_URL)
  // (a shard of an E2E_PARALLELISM run has SKIP_BUILD because its parent built: that build is current)
  if ((process.env.SKIP_BUILD && !SHARD_CHILD) || EXTERNAL || USER_PORTS) fs.appendFileSync(process.env.FDASH_REPORT, JSON.stringify({ nocache: true }) + "\n");
}
console.log(ok ? "\nALL SCENARIOS PASSED" : "\nSOME CHECKS FAILED");
process.exit(ok ? 0 : 1);
