// E2E_PARALLELISM=N node run.mjs: the suite in N shards at once on one machine. Each shard is a child
// `node run.mjs --shard i/N` with its own Go server (own port, own fresh database), its own LiveKit and
// its own Chrome; only the build (done by run.mjs before calling this) is shared.
//
// Ports of shard i: server 38080+100*i (auth +10), LiveKit 47880+100*i with RTC TCP +1 and UDP +2, so
// the dev stack (8080, 7880-7882), runs on the default or nearby ports (18080 and up) and the banner
// (38090) stay clear.
// LiveKit is the livekit-server binary when it is on PATH, else a Docker container per shard. Everything
// started here is stopped at the end, when a shard fails, and on Ctrl+C (or Ctrl+Break on Windows).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { shard } from "./shards.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === "win32";
// keep in step with deploy/docker-compose.local.yml and the CI workflow
const LK_IMAGE = "livekit/livekit-server:v1.13.7";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (p) => new Promise((res) => { const s = net.connect(p, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });
const secs = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`; };
const hasBinary = () => spawnSync("livekit-server", ["--version"], { stdio: "ignore" }).status === 0;
const hasDocker = () => spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0;

export const ports = (i) => ({ server: 38080 + 100 * i, auth: 38090 + 100 * i, lk: 47880 + 100 * i });

// LiveKit with the dev key pair on port p, RTC on p+1 (TCP) and one UDP mux port p+2, advertising
// 127.0.0.1. In Docker the host ports equal the container's: ICE advertises the inside port numbers.
const lkConfig = (p) => `{port: ${p}, rtc: {tcp_port: ${p + 1}, udp_port: ${p + 2}, use_external_ip: false}, keys: {devkey: secret}, logging: {level: warn}}`;

async function startLiveKit(i, mode, run, logDir) {
  const p = ports(i).lk;
  const log = path.join(logDir, `livekit-${i}.log`);
  const lk = { i, port: p, mode, log };
  if (mode === "binary") {
    const fd = fs.openSync(log, "a");
    lk.proc = spawn("livekit-server", ["--config-body", lkConfig(p), "--bind", "127.0.0.1", "--node-ip", "127.0.0.1"], { stdio: ["ignore", fd, fd], detached: !WIN });
    lk.proc.on("error", () => {});
  } else {
    lk.name = `hq-e2e-lk-${run}-${i}`;
    const r = spawnSync("docker", ["run", "-d", "--rm", "--name", lk.name, "--label", `hq-e2e-owner=${process.pid}`,
      "-p", `127.0.0.1:${p}:${p}/tcp`, "-p", `127.0.0.1:${p + 1}:${p + 1}/tcp`, "-p", `127.0.0.1:${p + 2}:${p + 2}/udp`,
      LK_IMAGE, "--config-body", lkConfig(p), "--bind", "0.0.0.0", "--node-ip", "127.0.0.1"], { encoding: "utf8" });
    if (r.status !== 0) { lk.failed = (r.stderr || r.stdout || "docker run failed").trim(); return lk; }
  }
  // the HTTP endpoint answers once LiveKit is up (Docker Desktop opens the host port before that)
  for (let t = 0; t < 150; t++) {
    try { if ((await fetch(`http://127.0.0.1:${p}/`)).ok) return lk; } catch {}
    if (lk.proc?.exitCode != null) break;
    await sleep(200);
  }
  lk.failed = `LiveKit on ${p} did not answer (log: ${log})`;
  return lk;
}

function stopLiveKit(lk) {
  if (lk.stopped) return;
  lk.stopped = true;
  if (lk.name) {
    const logs = spawnSync("docker", ["logs", lk.name], { encoding: "utf8" });
    try { fs.writeFileSync(lk.log, (logs.stdout ?? "") + (logs.stderr ?? "")); } catch {}
    spawnSync("docker", ["rm", "-f", lk.name], { stdio: "ignore" });
  } else if (lk.proc && lk.proc.exitCode == null) {
    try { WIN ? lk.proc.kill() : process.kill(-lk.proc.pid, "SIGTERM"); } catch {}
  }
}

// Asks a shard to stop: it stops its server and exits. On POSIX the shard leads its own process group
// (server, Chrome, auth's server), which gets the signal whole; on Windows a closed stdin tells it.
function stopShard(s) {
  if (s.code != null) return;
  try { WIN ? s.proc.stdin.end() : process.kill(-s.proc.pid, "SIGTERM"); } catch {}
}

// Containers of an earlier run whose orchestrator is gone (killed outright, so it could not clean up).
function sweepOrphans() {
  const r = spawnSync("docker", ["ps", "-a", "--filter", "label=hq-e2e-owner", "--format", '{{.Names}} {{.Label "hq-e2e-owner"}}'], { encoding: "utf8" });
  for (const line of (r.stdout ?? "").split(/\r?\n/).filter(Boolean)) {
    const [name, owner] = line.trim().split(" ");
    let alive = true;
    try { process.kill(Number(owner), 0); } catch (e) { alive = e.code === "EPERM"; }
    if (!alive) { console.log(`# removing ${name}, left by an earlier run`); spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" }); }
  }
}

export async function runParallel({ n, scenarios, root }) {
  const t0 = Date.now();
  const run = `${process.pid}-${Date.now().toString(36)}`;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "homequarters-e2e-shards-"));
  const mode = hasBinary() ? "binary" : hasDocker() ? "docker" : null;
  if (!mode) { console.log("# E2E_PARALLELISM needs livekit-server on PATH or Docker"); return false; }

  const lks = [];
  const shards = [];
  const cleanup = () => { for (const lk of lks) stopLiveKit(lk); };
  let interrupted = false;
  const interrupt = async () => {
    if (interrupted) return;
    interrupted = true;
    console.log("\n# interrupted: stopping the shards and their LiveKit");
    for (const s of shards) stopShard(s);
    await Promise.race([Promise.all(shards.map((s) => s.done)), sleep(20000)]);
    for (const s of shards) if (s.code == null) try { s.proc.kill("SIGKILL"); } catch {}
    cleanup();
    process.exit(130);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  process.on("SIGBREAK", interrupt); // Ctrl+Break on Windows
  process.on("exit", cleanup);

  try {
    if (mode === "docker") sweepOrphans();
    for (let i = 1; i <= n; i++) {
      const p = ports(i);
      for (const q of [p.server, p.auth, p.lk, p.lk + 1]) if (await portOpen(q)) { console.log(`# port ${q} (shard ${i}) is in use: free it or lower E2E_PARALLELISM`); return false; }
    }
    console.log(`# ${n} shards, LiveKit ${mode === "binary" ? "binary" : "in Docker (" + LK_IMAGE + ")"}, logs in ${logDir}`);
    lks.push(...await Promise.all(Array.from({ length: n }, (_, k) => startLiveKit(k + 1, mode, run, logDir))));
    const bad = lks.filter((lk) => lk.failed);
    if (bad.length) { for (const lk of bad) console.log(`# shard ${lk.i}: ${lk.failed}`); return false; }

    for (let i = 1; i <= n; i++) {
      const p = ports(i);
      const s = { i, names: shard(scenarios, i, n), out: [], code: null, t0: Date.now(), log: path.join(logDir, `shard-${i}.log`) };
      s.proc = spawn(process.execPath, [path.join(here, "run.mjs"), "--shard", `${i}/${n}`], {
        cwd: here, detached: !WIN, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, SKIP_BUILD: "1", E2E_PARALLELISM: "1", E2E_SHARD_CHILD: "1",
          HQ_TEST_PORT: String(p.server), HQ_TEST_LK_PORT: String(p.lk), HQ_LK_HTTP: `http://127.0.0.1:${p.lk}` },
      });
      const file = fs.createWriteStream(s.log);
      const take = (b) => { s.out.push(b); file.write(b); };
      s.proc.stdout.on("data", take);
      s.proc.stderr.on("data", take);
      s.done = new Promise((r) => s.proc.on("close", (code, sig) => {
        s.code = code ?? (sig ? 1 : 0); s.ms = Date.now() - s.t0; file.end();
        if (!interrupted) console.log(`# shard ${i}/${n} finished: ${s.code === 0 ? "PASS" : "FAIL"} in ${secs(s.ms)}`);
        r();
      }));
      shards.push(s);
    }
    await Promise.all(shards.map((s) => s.done));
  } finally {
    cleanup();
  }

  let ok = true;
  const lines = [];
  for (const s of shards) {
    const text = Buffer.concat(s.out).toString("utf8");
    console.log(`\n======== shard ${s.i}/${n}: ${s.names.join(", ")} ========`);
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
    let pass = 0, total = 0;
    for (const m of text.matchAll(/^(\d+)\/(\d+) checks passed$/gm)) { pass += Number(m[1]); total += Number(m[2]); }
    ok = ok && s.code === 0;
    lines.push(`shard ${s.i}/${n} ${s.code === 0 ? "PASS" : "FAIL"} ${pass}/${total} checks ${secs(s.ms)} (${s.names.join(", ")})`);
  }
  console.log(`\n# shards (wall ${secs(Date.now() - t0)}, logs in ${logDir})`);
  for (const l of lines) console.log(l);
  return ok;
}
