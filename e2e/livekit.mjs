// A LiveKit of the run's own for the e2e suite, on the ports of its slot (see slots.mjs): the
// livekit-server binary when it is on PATH (CI), else a Docker container. Never the dev stack's on 7880.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WIN = process.platform === "win32";
// keep in step with deploy/docker-compose.local.yml and the CI workflow
export const LK_IMAGE = "livekit/livekit-server:v1.13.7";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasBinary = () => spawnSync("livekit-server", ["--version"], { stdio: "ignore" }).status === 0;
const hasDocker = () => spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0;

/** "binary", "docker", or null when neither is available. */
export const liveKitMode = () => (hasBinary() ? "binary" : hasDocker() ? "docker" : null);

// LiveKit with the dev key pair on port p, RTC on p+1 (TCP) and one UDP mux port p+2, advertising
// 127.0.0.1. In Docker the host ports equal the container's: ICE advertises the inside port numbers.
const lkConfig = (p) => `{port: ${p}, rtc: {tcp_port: ${p + 1}, udp_port: ${p + 2}, use_external_ip: false}, keys: {devkey: secret}, logging: {level: warn}}`;

/** Starts LiveKit on port p; resolves to a handle with `failed` set when it did not come up. */
export async function startLiveKit({ port: p, mode, name, log }) {
  const lk = { port: p, mode, log };
  if (mode === "binary") {
    const fd = fs.openSync(log, "a");
    lk.proc = spawn("livekit-server", ["--config-body", lkConfig(p), "--bind", "127.0.0.1", "--node-ip", "127.0.0.1"], { stdio: ["ignore", fd, fd], detached: !WIN });
    lk.proc.on("error", () => {});
  } else {
    lk.name = name;
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

/** Stops a LiveKit started by startLiveKit; synchronous and idempotent, so exit handlers can call it. */
export function stopLiveKit(lk) {
  if (!lk || lk.stopped) return;
  lk.stopped = true;
  if (lk.name) {
    const logs = spawnSync("docker", ["logs", lk.name], { encoding: "utf8" });
    try { fs.writeFileSync(lk.log, (logs.stdout ?? "") + (logs.stderr ?? "")); } catch {}
    spawnSync("docker", ["rm", "-f", lk.name], { stdio: "ignore" });
  } else if (lk.proc && lk.proc.exitCode == null) {
    try { WIN ? lk.proc.kill() : process.kill(-lk.proc.pid, "SIGTERM"); } catch {}
  }
}

// Containers of an earlier run whose owner is gone (killed outright, so it could not clean up).
export function sweepOrphans() {
  const r = spawnSync("docker", ["ps", "-a", "--filter", "label=hq-e2e-owner", "--format", '{{.Names}} {{.Label "hq-e2e-owner"}}'], { encoding: "utf8" });
  for (const line of (r.stdout ?? "").split(/\r?\n/).filter(Boolean)) {
    const [name, owner] = line.trim().split(" ");
    let alive = true;
    try { process.kill(Number(owner), 0); } catch (e) { alive = e.code === "EPERM"; }
    if (!alive) { console.log(`# removing ${name}, left by an earlier run`); spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" }); }
  }
}

export const logPath = (dir, i) => path.join(dir, `livekit-${i}.log`);
