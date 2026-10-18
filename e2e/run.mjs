// Self-contained acceptance runner: fresh SQLite DB, production-style static serving,
// real Chrome (fake camera/mic) and a real LiveKit server. Usage: node run.mjs [scenario ...]
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// HQ_EXTERNAL_URL=http://127.0.0.1:8080 runs the scenarios against an already running stack (for example
// the Docker Compose one). Scenarios that restart the server or spawn the local binary are skipped there.
const EXTERNAL = process.env.HQ_EXTERNAL_URL ?? "";
const PORT = process.env.HQ_TEST_PORT ?? "18080";
process.env.HQ_APP = process.env.HQ_API = EXTERNAL || `http://127.0.0.1:${PORT}`;
// HQ_TEST_LK_PORT points the run at another LiveKit than the dev stack's (its RTC ports must be its own too).
const LK_PORT = Number(process.env.HQ_TEST_LK_PORT ?? "7880");
process.env.HQ_LK_HTTP ??= `http://127.0.0.1:${LK_PORT}`;
process.env.HQ_TEST_LK_URL = `ws://127.0.0.1:${LK_PORT}`;

const all = ["proximity", "consent", "rooms", "access", "editor", "social", "admin", "plugins", "a11y", "security", "resilience", "features", "spotlight", "movement", "presence", "offices", "idle", "update", "auth"];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : EXTERNAL ? ["proximity", "consent", "rooms"] : all;

// Windows: go build names the binary as given, while spawning "bin/homequarters" runs a stale homequarters.exe;
// pnpm is a .cmd that only a shell finds; and a signal from Node is a hard kill (see stopServer).
const WIN = process.platform === "win32";
const BIN = path.join(root, "bin", WIN ? "homequarters.exe" : "homequarters");

const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (p) => new Promise((res) => { const s = net.connect(p, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });

if (!process.env.SKIP_BUILD && !EXTERNAL) {
  console.log("# building web + server");
  execFileSync("pnpm", ["build"], { cwd: path.join(root, "web"), stdio: "inherit", shell: WIN });
  execFileSync("go", ["build", "-o", BIN, "./cmd/homequarters"], { cwd: path.join(root, "server"), stdio: "inherit" });
}

// livekit-server --dev always listens on 7880, so another port needs a LiveKit started beforehand.
if (!EXTERNAL && !(await portOpen(LK_PORT)) && LK_PORT !== 7880) { console.log("# no LiveKit on " + LK_PORT + ": start one there first"); process.exit(1); }
if (!EXTERNAL && !(await portOpen(LK_PORT))) {
  console.log("# starting livekit-server --dev");
  const lk = spawn("livekit-server", ["--dev", "--bind", "127.0.0.1"], { stdio: "ignore" });
  lk.on("error", () => console.log("# livekit-server not found: start one on " + LK_PORT + ", e.g. docker compose -p homequarters-dev -f deploy/docker-compose.local.yml up -d livekit"));
  children.push(lk);
  for (let i = 0; i < 50 && !(await portOpen(LK_PORT)); i++) await sleep(200);
  if (!(await portOpen(LK_PORT))) { console.log("# no LiveKit on " + LK_PORT); for (const c of children) c.kill("SIGTERM"); process.exit(1); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "homequarters-e2e-"));
// the bundled plugins (plugins/bundled) plus the suite's own installed ones (e2e/fixtures/plugins/installed), all disabled
// until a scenario enables one
const pluginsDir = path.join(dir, "plugins");
fs.cpSync(path.join(root, "plugins/bundled"), path.join(pluginsDir, "bundled"), { recursive: true });
fs.cpSync(path.join(root, "e2e/fixtures/plugins/installed"), path.join(pluginsDir, "installed"), { recursive: true });
// Checks that only need time to pass (an expiring token) run after the other scenarios instead of sleeping in theirs.
const deferred = [];
const ctx = { dir, bin: BIN, server: null, defer(name, due, fn) { deferred.push({ name, due, fn }); }, async startServer() {
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
  if (WIN) c.stdin.end(); else c.kill("SIGTERM");
  const timer = setTimeout(() => c.kill("SIGKILL"), 15000);
  await done;
  clearTimeout(timer);
} };
if (!EXTERNAL) await ctx.startServer();
console.log("# server logs:", path.join(dir, "server.log"));

let ok = true;
try {
  // Bootstrap the office admin (the first member of an office becomes admin).
  const r = await fetch(process.env.HQ_API + "/api/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Admin", avatar: { sk: 2, hs: 2, hc: 0, sh: 6, pa: 0 } }) });
  const cookie = r.headers.get("set-cookie").split(";")[0].split("=")[1];
  ctx.adminCookie = cookie;
  ctx.adminId = (await r.json()).id;
  for (const name of wanted) {
    console.log(`\n== ${name} ==`);
    const mod = await import(`./scenarios/${name}.mjs`);
    const passed = await mod.run(ctx);
    ok = ok && passed;
  }
} catch (e) {
  console.error("runner error:", e);
  ok = false;
} finally {
  await ctx.stopServer();
  // deferred checks run even when a scenario aborted the loop; they need only the SFU (stopped right after)
  const { resetChecks, summary, check } = await import("./lib.mjs");
  for (const d of deferred.sort((x, y) => x.due - y.due)) {
    console.log(`\n== ${d.name} (deferred) ==`);
    await sleep(Math.max(0, d.due - Date.now()));
    resetChecks();
    await d.fn().catch((e) => check("deferred check ran", false, String(e)));
    ok = summary() && ok;
  }
  for (const c of children) c.kill("SIGTERM");
}
console.log(ok ? "\nALL SCENARIOS PASSED" : "\nSOME CHECKS FAILED");
process.exit(ok ? 0 : 1);
