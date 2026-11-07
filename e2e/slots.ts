// A machine-wide limit on concurrent local e2e runs. Each run (or each shard of an E2E_PARALLELISM run)
// holds a slot: a lock file os.tmpdir()/homequarters-e2e-slots/slot-<k> for k in 0..max-1, created
// exclusively and holding the owner's pid. A run waits while every slot is taken; a slot whose pid is
// gone (a run killed outright) is stale and is taken over. The slot also gives the run its ports, so
// runs side by side never meet: see ports().
//
// The max is E2E_MAX_PARALLEL (default 2), usually set in the repository's .env (see .env.example).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const DEFAULT_MAX = 2;
export const DIR = path.join(os.tmpdir(), "homequarters-e2e-slots");

// Ports of slot k: server 38180+100k (auth +10), LiveKit 47980+100k with RTC TCP +1 and UDP +2. They
// stay clear of the dev stack (8080, 7880-7882), of runs on the old default ports (18080 and up) and
// of the banner (38090).
export const ports = (k) => ({ server: 38180 + 100 * k, auth: 38190 + 100 * k, lk: 47980 + 100 * k });

/** E2E_MAX_PARALLEL as a positive integer; DEFAULT_MAX when unset or empty; throws on anything else. */
export function parseMax(v) {
  if (v == null || String(v).trim() === "") return DEFAULT_MAX;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`E2E_MAX_PARALLEL wants a positive integer, got ${v}`);
  return n;
}

/** The owner recorded in a slot file, or null when the content is not one (a half-written file). */
export function parseOwner(text) {
  try {
    const o = JSON.parse(text);
    return Number.isInteger(o?.pid) && o.pid > 0 ? o : null;
  } catch { return null; }
}

/**
 * Whether a slot file is stale: its owner's pid is gone. A file without a readable owner is stale only
 * once it is older than `graceMs` (its writer may be between create and write).
 */
export function isStale(owner, { alive, ageMs, graceMs = 5000 }) {
  if (!owner) return ageMs > graceMs;
  return !alive(owner.pid);
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

const slotFile = (dir, k) => path.join(dir, `slot-${k}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readOwner(file) {
  let text, ageMs;
  try { text = fs.readFileSync(file, "utf8"); ageMs = Date.now() - fs.statSync(file).mtimeMs; } catch { return { missing: true }; }
  return { owner: parseOwner(text), ageMs };
}

// Removes slot k when it is stale. A takeover lock makes the re-read and the unlink one step, so two
// runs that both saw the stale file cannot remove the fresh one the first of them created.
function takeOver(dir, k) {
  const file = slotFile(dir, k);
  const lock = file + ".takeover";
  try { fs.closeSync(fs.openSync(lock, "wx")); } catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.unlinkSync(lock); } catch {}
    return false;
  }
  try {
    const r = readOwner(file);
    if (r.missing) return true;
    if (!isStale(r.owner, { alive: pidAlive, ageMs: r.ageMs })) return false;
    fs.unlinkSync(file);
    return true;
  } catch { return false; } finally { try { fs.unlinkSync(lock); } catch {} }
}

function tryTake(dir, k, me) {
  const file = slotFile(dir, k);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, JSON.stringify(me));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (!takeOver(dir, k)) return false;
    }
  }
  return false;
}

function release(dir, k, token) {
  const file = slotFile(dir, k);
  try { if (parseOwner(fs.readFileSync(file, "utf8"))?.token === token) fs.unlinkSync(file); } catch {}
}

/**
 * Takes `n` slots of `max`, waiting until that many are free together (taking them one by one could
 * leave two runs each holding half of what they need). `portsFree(k)` vetoes a slot whose ports
 * something else holds. Returns { slots, release }; release() is idempotent and synchronous, so it can
 * run in an exit handler. Throws when n > max: that run would wait forever.
 */
export async function acquire({ n = 1, max, dir = DIR, portsFree = async () => true, log = console.log, pollMs = 1000, reportMs = 30000 } = {}) {
  if (n > max) throw new Error(`E2E_PARALLELISM=${n} needs ${n} e2e slots but E2E_MAX_PARALLEL is ${max}: lower E2E_PARALLELISM or raise E2E_MAX_PARALLEL (.env)`);
  fs.mkdirSync(dir, { recursive: true });
  const me = { pid: process.pid, started: new Date().toISOString(), cwd: process.cwd(), token: crypto.randomUUID() };
  let lastReport = 0;
  for (;;) {
    const held = [];
    const pids = [];
    const blocked = [];
    for (let k = 0; k < max && held.length < n; k++) {
      if (!tryTake(dir, k, me)) { pids.push(readOwner(slotFile(dir, k)).owner?.pid ?? "?"); continue; }
      const why = await portsFree(k);
      if (why === true) held.push(k);
      else { release(dir, k, me.token); blocked.push(`slot ${k}: ${why}`); }
    }
    if (held.length === n) {
      let done = false;
      const releaseAll = () => { if (done) return; done = true; for (const k of held) release(dir, k, me.token); };
      return { slots: held, release: releaseAll };
    }
    for (const k of held) release(dir, k, me.token);
    if (Date.now() - lastReport >= reportMs) {
      lastReport = Date.now();
      const what = [pids.length ? "pids " + pids.join(", ") : "", ...blocked].filter(Boolean).join("; ");
      log(`# waiting for ${n === 1 ? "a free e2e slot" : n + " free e2e slots"} (${pids.length + blocked.length}/${max} in use: ${what})`);
    }
    await sleep(pollMs + Math.floor(Math.random() * 300));
  }
}
