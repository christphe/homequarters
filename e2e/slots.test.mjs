// node --test e2e/slots.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_MAX, acquire, isStale, parseMax, parseOwner, ports } from "./slots.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hq-slots-test-"));
// a pid that existed and is gone: a child that has exited
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
const quiet = () => {};

test("slot ports: 100 apart, clear of the dev stack, the old defaults and the banner", () => {
  assert.deepEqual(ports(0), { server: 38180, auth: 38190, lk: 47980 });
  assert.deepEqual(ports(3), { server: 38480, auth: 38490, lk: 48280 });
  const used = new Set();
  for (let k = 0; k < 8; k++) {
    const p = ports(k);
    for (const q of [p.server, p.auth, p.lk, p.lk + 1, p.lk + 2]) {
      assert.ok(!used.has(q), `port ${q} reused`);
      assert.ok(![8080, 7880, 7881, 7882, 18080, 18090, 38090, 5173].includes(q), `port ${q} is taken by something else`);
      used.add(q);
    }
  }
});

test("E2E_MAX_PARALLEL: default when unset, positive integers only", () => {
  assert.equal(parseMax(undefined), DEFAULT_MAX);
  assert.equal(parseMax(""), DEFAULT_MAX);
  assert.equal(parseMax("3"), 3);
  for (const bad of ["0", "-1", "1.5", "two"]) assert.throws(() => parseMax(bad), /E2E_MAX_PARALLEL/);
});

test("stale: a gone pid is stale, a live one is not; an unreadable file only after the grace", () => {
  const alive = (pid) => pid === 42;
  assert.equal(isStale({ pid: 42 }, { alive, ageMs: 1e9 }), false);
  assert.equal(isStale({ pid: 7 }, { alive, ageMs: 0 }), true);
  assert.equal(isStale(parseOwner("{\"pid\""), { alive, ageMs: 100 }), false);
  assert.equal(isStale(parseOwner(""), { alive, ageMs: 60000 }), true);
  assert.equal(parseOwner("{\"pid\":0}"), null);
  assert.deepEqual(parseOwner("{\"pid\":5,\"token\":\"t\"}"), { pid: 5, token: "t" });
});

test("takes free slots, releases only its own, refuses more slots than the max", async () => {
  const dir = tmp();
  const a = await acquire({ n: 2, max: 3, dir, log: quiet });
  assert.deepEqual(a.slots, [0, 1]);
  const b = await acquire({ n: 1, max: 3, dir, log: quiet });
  assert.deepEqual(b.slots, [2]);
  a.release();
  a.release();
  assert.deepEqual(fs.readdirSync(dir).sort(), ["slot-2"]);
  b.release();
  assert.deepEqual(fs.readdirSync(dir), []);
  await assert.rejects(acquire({ n: 3, max: 2, dir, log: quiet }), /E2E_MAX_PARALLEL is 2/);
});

test("waits while every slot is taken, reports who holds them, and starts once one frees", async () => {
  const dir = tmp();
  const first = await acquire({ n: 1, max: 1, dir, log: quiet });
  const lines = [];
  let got = null;
  const waiting = acquire({ n: 1, max: 1, dir, log: (l) => lines.push(l), pollMs: 20, reportMs: 0 }).then((h) => (got = h));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(got, null);
  assert.match(lines[0], new RegExp(`^# waiting for a free e2e slot \\(1/1 in use: pids ${process.pid}\\)$`));
  first.release();
  await waiting;
  assert.deepEqual(got.slots, [0]);
  got.release();
});

test("a slot left by a dead pid is taken over at once", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "slot-0"), JSON.stringify({ pid: deadPid(), token: "old" }));
  const lines = [];
  const h = await acquire({ n: 1, max: 1, dir, log: (l) => lines.push(l), pollMs: 20 });
  assert.deepEqual(h.slots, [0]);
  assert.deepEqual(lines, []);
  assert.equal(parseOwner(fs.readFileSync(path.join(dir, "slot-0"), "utf8")).pid, process.pid);
  h.release();
});

test("a slot whose ports are busy is skipped and named in the waiting line", async () => {
  const dir = tmp();
  const h = await acquire({ n: 1, max: 2, dir, log: quiet, portsFree: async (k) => (k === 0 ? "port 38180 in use" : true) });
  assert.deepEqual(h.slots, [1]);
  assert.deepEqual(fs.readdirSync(dir), ["slot-1"]);
  const lines = [];
  let got = null;
  const waiting = acquire({ n: 1, max: 2, dir, log: (l) => lines.push(l), pollMs: 20, reportMs: 0, portsFree: async (k) => (k === 0 ? "port 38180 in use" : true) }).then((x) => (got = x));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(got, null);
  assert.match(lines[0], /\(2\/2 in use: pids \d+; slot 0: port 38180 in use\)/);
  h.release();
  await waiting;
  got.release();
});

test("several slots are taken together or not at all", async () => {
  const dir = tmp();
  const one = await acquire({ n: 1, max: 2, dir, log: quiet });
  let got = null;
  const waiting = acquire({ n: 2, max: 2, dir, log: quiet, pollMs: 20 }).then((x) => (got = x));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(got, null);
  // the waiter does not sit on the free slot while it waits for the second
  assert.deepEqual(fs.readdirSync(dir), ["slot-0"]);
  one.release();
  await waiting;
  assert.deepEqual(got.slots, [0, 1]);
  got.release();
});
