// E2E_PARALLELISM=N node run.mjs: the suite in N shards at once on one machine. Each shard is a child
// `node run.mjs --shard i/N` with its own Go server (own port, own fresh database), its own LiveKit and
// its own Chrome; only the build (done by run.mjs before calling this) is shared.
//
// run.mjs takes one e2e slot per shard before calling this (see slots.mjs); shard i runs on the ports of
// its slot. LiveKit is the livekit-server binary when it is on PATH, else a Docker container per shard
// (livekit.mjs). Everything started here is stopped at the end, when a shard fails, and on Ctrl+C (or
// Ctrl+Break on Windows).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shard } from "./shards.mjs";
import { ports } from "./slots.mjs";
import { LK_IMAGE, startLiveKit, stopLiveKit, logPath } from "./livekit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`; };

// Asks a shard to stop: it stops its server and exits. On POSIX the shard leads its own process group
// (server, Chrome, auth's server), which gets the signal whole; on Windows a closed stdin tells it.
function stopShard(s) {
  if (s.code != null) return;
  try { WIN ? s.proc.stdin.end() : process.kill(-s.proc.pid, "SIGTERM"); } catch {}
}

// slots: the e2e slot of each shard (run.mjs took them and checked their ports); mode: "binary" or "docker".
export async function runParallel({ n, scenarios, slots, mode }) {
  const t0 = Date.now();
  const run = `${process.pid}-${Date.now().toString(36)}`;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "homequarters-e2e-shards-"));

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
    console.log(`# ${n} shards on e2e slots ${slots.join(", ")}, LiveKit ${mode === "binary" ? "binary" : "in Docker (" + LK_IMAGE + ")"}, logs in ${logDir}`);
    lks.push(...await Promise.all(slots.map((k, at) => startLiveKit({ port: ports(k).lk, mode, name: `hq-e2e-lk-${run}-${at + 1}`, log: logPath(logDir, at + 1) })
      .then((lk) => Object.assign(lk, { i: at + 1 })))));
    const bad = lks.filter((lk) => lk.failed);
    if (bad.length) { for (const lk of bad) console.log(`# shard ${lk.i}: ${lk.failed}`); return false; }

    for (let i = 1; i <= n; i++) {
      const p = ports(slots[i - 1]);
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
