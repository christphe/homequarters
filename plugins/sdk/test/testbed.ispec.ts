// Integration tests of the testbed client (plugins/sdk/testbed.ts) against `homequarters testbed` and
// the echo fixture plugin of the server's tests: onMessage stores {v} under "k" and answers {echo: v}.
// Run: node tools/fdash/cli.ts run test:integration --pkg sdk (needs bin/homequarters[.exe] or HQ_BIN).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { pathToFileURL } from "node:url";
import { testbed } from "../testbed.ts";
import type { Testbed } from "../testbed.ts";

const echo = path.resolve(import.meta.dirname, "../../../server/internal/httpapi/testdata/plugins/installed/echo");
type Echo = { echo: string };

const beds: Testbed[] = [];
afterAll(async () => {
  await Promise.all(beds.map((b) => b.close()));
});
const open = async (): Promise<Testbed> => {
  const b = await testbed({ plugins: [echo] });
  beds.push(b);
  return b;
};

test("a member's message reaches the plugin and its answer comes back", async () => {
  const bed = await open();
  const ann = await bed.join("Ann");
  assert.ok(ann.id > 0);
  assert.equal(ann.name, "Ann");
  ann.send("echo", { v: "hi" });
  const d = await ann.waitFor<Echo>("echo", (m: Echo) => m.echo === "hi");
  assert.deepEqual(d, { echo: "hi" });
  assert.deepEqual(ann.received("echo"), [{ echo: "hi" }]);
  // the plugin stored it (written a few milliseconds after the answer)
  assert.equal((await bed.waitKv("echo", (kv) => kv.k === "hi")).k, "hi");
  assert.deepEqual(await bed.errors(), {});
});

test("waitFor consumes: a frame already matched never matches again", async () => {
  const bed = await open();
  const ann = await bed.join("Ann");
  ann.send("echo", { v: "same" });
  await ann.waitFor("echo", (m: Echo) => m.echo === "same");
  await assert.rejects(ann.waitFor("echo", (m: Echo) => m.echo === "same", 300));
  ann.send("echo", { v: "same" });
  await ann.waitFor("echo", (m: Echo) => m.echo === "same");
  assert.equal(ann.received("echo").length, 2);
});

test("waitFor on a frame that never comes rejects within its timeout and names the last frames", async () => {
  const bed = await open();
  const ann = await bed.join("Ann");
  for (const v of ["a", "b", "c", "d", "e", "f"]) {
    ann.send("echo", { v });
    await ann.waitFor("echo", (m: Echo) => m.echo === v);
  }
  const t0 = Date.now();
  await assert.rejects(ann.waitFor("echo", (m: Echo) => m.echo === "never", 400), (e: Error) => {
    assert.match(e.message, /within 400 ms/);
    assert.match(e.message, /last 5 of 6/);
    assert.match(e.message, /\{"echo":"f"\}/);
    assert.doesNotMatch(e.message, /\{"echo":"a"\}/);
    return true;
  });
  const took = Date.now() - t0;
  assert.ok(took >= 380 && took < 2000, `rejected after ${took} ms`);
});

test("quiet resolves when nothing comes and throws when a frame arrives", async () => {
  const bed = await open();
  const ann = await bed.join("Ann");
  await ann.quiet("echo", 200);
  const q = ann.quiet("echo", 3000);
  ann.send("echo", { v: "loud" });
  const t0 = Date.now();
  await assert.rejects(q, /arrived within 3000 ms.*loud/);
  assert.ok(Date.now() - t0 < 2000, "quiet waits out its whole time instead of failing at once");
});

test("two beds at once run on their own port and database", async () => {
  const [one, two] = await Promise.all([open(), open()]);
  assert.notEqual(one.url, two.url);
  const [a, b] = await Promise.all([one.join("Ann"), two.join("Bob")]);
  a.send("echo", { v: "one" });
  b.send("echo", { v: "two" });
  await a.waitFor("echo", (m: Echo) => m.echo === "one");
  await b.waitFor("echo", (m: Echo) => m.echo === "two");
  assert.equal((await one.waitKv("echo", (kv) => kv.k === "one")).k, "one");
  assert.equal((await two.waitKv("echo", (kv) => kv.k === "two")).k, "two");
});

test("restart keeps the database; members come back with reconnect", async () => {
  const bed = await open();
  const ann = await bed.join("Ann");
  ann.send("echo", { v: "kept" });
  await bed.waitKv("echo", (kv) => kv.k === "kept");
  await bed.restart();
  assert.deepEqual(await bed.kv("echo"), { k: "kept" });
  assert.throws(() => ann.send("echo", { v: "x" }), /not connected/);
  await ann.reconnect();
  ann.send("echo", { v: "again" });
  await ann.waitFor("echo", (m: Echo) => m.echo === "again");
  // the session survived: still the administrator
  await bed.setPlugin("echo", true);
});

test("a test process that dies without close() leaves no temporary folder behind", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "hq-testbed-dies-"));
  try {
    // a child test process opens a bed, restarts it once, then exits at once: no close(), no cleanup
    const script = `import { testbed } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../testbed.ts")).href)};
const bed = await testbed({ plugins: [${JSON.stringify(echo)}] });
await bed.restart();
process.exit(0);`;
    const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(child.status, 0, child.stderr);
    // the server sees stdin end and stops, removing its database and the client's folder
    const deadline = Date.now() + 15_000;
    while (readdirSync(tmp).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(readdirSync(tmp), [], "left behind in the temporary folder");
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("seedKv replaces a plugin's data; setPlugin and placeObject need the administrator", async () => {
  const bed = await open();
  await assert.rejects(bed.placeObject("box", { x: 12, y: 7 }), /first member is the administrator/);
  const ann = await bed.join("Ann");
  const bob = await bed.join("Bob");
  await bed.seedKv("echo", { k: "seeded", other: "x" });
  assert.deepEqual(await bed.kv("echo"), { k: "seeded", other: "x" });
  await bed.seedKv("echo", { k: "again" });
  assert.deepEqual(await bed.kv("echo"), { k: "again" });
  // the plugin runs again after the seed
  bob.send("echo", { v: "after" });
  await bob.waitFor("echo", (m: Echo) => m.echo === "after");
  await bed.placeObject("box", { x: 12, y: 7 });
  await bed.placeObject("echo/orb", { x: 14, y: 7 });
  await assert.rejects(bed.placeObject("nosuch", { x: 12, y: 9 }), /no running plugin has it/);
  void ann;
});

test("join at a tile, and reconnect at another once the reconnect grace is over", async () => {
  const bed = await open();
  const ann = await bed.join("Ann", { at: { x: 12, y: 7 } });
  await assert.rejects(bed.join("Bob", { at: { x: -1, y: 7 } }), /400/);
  await ann.leave();
  await ann.reconnect({ at: { x: 13, y: 7 } }); // waits out the server's grace (about 11 s)
  ann.send("echo", { v: "back" });
  await ann.waitFor("echo", (m: Echo) => m.echo === "back");
});

/** Runs `fn` with HQ_BIN and HQ_BIN_REPO_ONLY set as given (undefined: unset), then puts them back. */
async function withBinEnv(env: { HQ_BIN?: string; HQ_BIN_REPO_ONLY?: string }, fn: () => Promise<void>): Promise<void> {
  const keys = ["HQ_BIN", "HQ_BIN_REPO_ONLY"] as const;
  const saved = keys.map((k) => process.env[k]);
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    await fn();
  } finally {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
}

test("no binary: the documented error", async () => {
  const missing = path.join(import.meta.dirname, "no-such-homequarters");
  assert.ok(!existsSync(missing));
  await withBinEnv({ HQ_BIN: missing }, () =>
    assert.rejects(testbed({ plugins: [echo] }), (e: Error) => {
      assert.match(e.message, /^no homequarters binary: run "node tools\/fdash\/cli\.ts run build --pkg server" first \(or set HQ_BIN\)/);
      return true;
    }));
});

// fdash keys the repository's binary, not HQ_BIN: under its tasks another binary is refused, or a pass would be
// recorded for a server the cache never saw
test("under fdash (HQ_BIN_REPO_ONLY) HQ_BIN is refused", async () => {
  await withBinEnv({ HQ_BIN: process.execPath, HQ_BIN_REPO_ONLY: "1" }, () =>
    assert.rejects(testbed({ plugins: [echo] }), /HQ_BIN is not taken by this fdash task/));
});
