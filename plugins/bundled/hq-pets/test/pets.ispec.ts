// Integration tests of hq-pets, the sample plugin authors copy: members must not be able to stop it.
// They run the real server through the testbed (plugins/sdk/testbed.ts) and drive members over its API.
// Run: node tools/fdash/cli.ts run test:integration --pkg hq-pets (needs bin/homequarters[.exe] or HQ_BIN).
import assert from "node:assert/strict";
import path from "node:path";
import { afterAll, test } from "vitest";
import { testbed } from "../../../sdk/testbed.ts";
import type { Member, Testbed } from "../../../sdk/testbed.ts";

const PETS = "hq-pets";
const pluginDir = path.resolve(import.meta.dirname, "..");
const callerDir = path.resolve(import.meta.dirname, "fixtures/caller");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Pet = [kind: number, colour: string, id: string, name: string];
type Guest = { from: string; id: string; name: string; sheet?: string; cell?: number[]; metadata?: { kind?: number; alt?: boolean } };
type Entry = { id: number; pets: Pet[]; guests: Guest[]; mode: string };
/** What the caller fixture relays of a hook call: its result. */
type HookResult = { ok?: boolean; error?: string; removed?: boolean };
type Frame = { t?: string; set?: Entry[]; del?: number[]; go?: { id: number; g: unknown[] }[]; limit?: number };

const beds: Testbed[] = [];
afterAll(async () => {
  await Promise.all(beds.map((b) => b.close()));
});
const open = async (plugins = [pluginDir]): Promise<Testbed> => {
  const b = await testbed({ plugins, timeoutMs: 10_000 });
  beds.push(b);
  return b;
};

/** Polls until `fn` returns something truthy (a bounded wait, no fixed sleep); rejects naming `what`. */
async function until<T>(what: string, fn: () => T | undefined | false, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline) throw new Error(`not within ${ms} ms: ${what}`);
    await sleep(20);
  }
}

const frames = (m: Member): Frame[] => m.received(PETS) as Frame[];
/** The last thing the broadcasts told `m` about member `id`'s pets. */
const entryOf = (m: Member, id: number): Entry | undefined => {
  let last: Entry | undefined;
  for (const f of frames(m)) for (const e of f.set ?? []) if (e.id === id) last = e;
  return last;
};
const petsOf = (m: Member, id: number): Pet[] => entryOf(m, id)?.pets ?? [];
/** The limit in the last "you" message `m` got. */
const limitOf = (m: Member): number | undefined => frames(m).findLast((f) => f.t === "you")?.limit;
const bytes = (d: unknown): number => Buffer.byteLength(JSON.stringify(d));

/** Probes that the plugin handled what `m` sent before: a sync sent now is answered after it (one plugin
 * handles its messages in order), so a refused message has had its chance to show something. */
async function settled(m: Member): Promise<void> {
  const before = frames(m).length;
  m.send(PETS, { t: "sync" });
  await until("the answer to a sync sent after", () => frames(m).slice(before).some((f) => f.t === "pets"));
}

/** A member's changes are throttled to 5 a second: stay under it. */
async function say(m: Member, ...msgs: unknown[]): Promise<void> {
  for (const d of msgs) {
    m.send(PETS, d);
    await sleep(210);
  }
}

test("it survives a full office arriving", async () => {
  const bed = await open();
  const three = `[[0,"","a1"],[3,"ff8800","b2"],[8,"","c3"]]`;
  const first = await Promise.all(Array.from({ length: 40 }, (_, i) => bed.join(`m${i + 1}`)));
  // members are numbered in the order they join (a fresh database): the 40 still to come get the next ids,
  // and their pets are stored before they arrive
  const top = Math.max(...first.map((m) => m.id));
  const seed: Record<string, string> = {};
  for (let id = Math.min(...first.map((m) => m.id)); id <= top + 40; id++) seed[`p:${id}`] = three;
  const watcher = first[0];
  const seen = frames(watcher).length; // what came before the restart does not count
  // the plugin starts again with 40 members online and their pets in the database: all of them arrive at once
  await bed.seedKv(PETS, seed);
  // and 40 more arrive while it runs
  const later = await Promise.all(Array.from({ length: 40 }, (_, i) => bed.join(`n${i + 1}`)));
  for (const m of later) assert.ok(m.id > top && m.id <= top + 40, `member ${m.id} got an id outside the seeded ones (${top + 1}-${top + 40})`);
  const crowd = [...first, ...later];
  // the broadcasts alone announce everybody's pets to a member already there: no page asked (no sync)
  const announced = (id: number): number => {
    let n = -1;
    for (const f of frames(watcher).slice(seen)) for (const e of f.set ?? []) if (e.id === id) n = e.pets.length;
    return n;
  };
  await until("the pets of all 80 members, from the broadcasts", () => crowd.every((m) => announced(m.id) === 3));
  for (const m of crowd) assert.equal(announced(m.id), 3, `member ${m.id}`);
  // a page that starts asks for everybody's pets, which come in pieces
  const last = later[later.length - 1];
  last.send(PETS, { t: "sync" });
  await until("the pets of all 80 members, from a sync", () => crowd.every((m) => petsOf(last, m.id).length === 3));
  for (const m of [last, watcher]) {
    for (const f of frames(m)) assert.ok(bytes(f) <= 4096, `a ${bytes(f)}-byte message: the office's pets must be cut into pieces`);
  }
  assert.deepEqual(await bed.errors(), {});
});

test("it adds pets, colours and removes them", async () => {
  const bed = await open();
  const bob = await bed.join("Bob");
  await say(bob, { t: "add", k: 0 }, { t: "add", k: 0 }, { t: "add", k: 8 }, { t: "add", k: 4 }, { t: "add", k: 9 });
  await until("three pets", () => petsOf(bob, bob.id).length === 3);
  await settled(bob); // the refused fourth and the invalid kind have nothing to show
  const got = petsOf(bob, bob.id);
  assert.deepEqual(
    got.map((p) => p[0]),
    [0, 0, 8],
    "two cats and a seedling, the fourth refused at the default limit of 3",
  );
  const first = got[0][2];
  await say(bob, { t: "colour", i: 1, c: "3fa7d6" }, { t: "colour", i: 2, c: "red" }, { t: "remove", i: 0 });
  await until("the removal", () => petsOf(bob, bob.id).length === 2);
  const after = petsOf(bob, bob.id);
  assert.equal(after[0][1], "3fa7d6", "the second cat is blue");
  assert.equal(after[1][1], "", "a colour that is not hex is refused");
  assert.notEqual(after[0][2], first, "the first cat is gone");
  assert.equal(limitOf(bob), 3, "a member is told the limit");
  assert.deepEqual(await bed.errors(), {});
});

test("it names pets: trimmed, one line, at most 24 characters", async () => {
  const bed = await open();
  const bob = await bed.join("Bob");
  await say(
    bob,
    { t: "add", k: 3 },
    { t: "add", k: 0 },
    { t: "name", i: 0, n: "  Foxy  " },
    { t: "name", i: 1, n: "Line\nbreak and a name far longer than twenty-four" },
    { t: "name", i: 5, n: "x" },
    { t: "name", i: 0, n: 7 },
  );
  await until("both names", () => petsOf(bob, bob.id)[1]?.[3] === "Linebreak and a name far");
  assert.deepEqual(
    petsOf(bob, bob.id).map((p) => p[3]),
    ["Foxy", "Linebreak and a name far"],
    "a name for a missing pet or one that is not text changes nothing",
  );
  await say(
    bob,
    { t: "mode", m: "wander" },
    { t: "wander", g: [[100, 200, 30], "9:abc"] },
    { t: "wander", g: [[1, 2, 500], null] },
    { t: "wander", g: ["nope", null] },
    { t: "mode", m: "follow" }, // the probe: broadcasts come in order, so once it shows nothing more is on its way
  );
  await until("the mode back to follow", () => entryOf(bob, bob.id)?.mode === "follow");
  const goals = frames(bob).flatMap((f) => (f.go ?? []).filter((g) => g.id === bob.id).map((g) => g.g));
  assert.deepEqual(goals, [[[100, 200, 30], "9:abc"]], "a wander goal with its speed, and another pet to go along with, are relayed; a bad speed or pet id is not");
  assert.deepEqual(await bed.errors(), {});
});

test("the limit follows the office's setting", async () => {
  const bed = await open();
  const ann = await bed.join("Ann");
  const bob = await bed.join("Bob");
  await until("the default limit", () => limitOf(bob) === 3);
  await say(bob, { t: "add", k: 1 }, { t: "add", k: 2 }, { t: "add", k: 3 }, { t: "limit", n: 8 }, { t: "add", k: 4 });
  await until("three pets", () => petsOf(bob, bob.id).length === 3);
  await settled(bob); // the refused fourth has nothing to show
  assert.equal(limitOf(bob), 3, "3 by default, and a page cannot change it");
  assert.equal(petsOf(bob, bob.id).length, 3);
  await bed.setSetting(PETS, "limit", 1); // what Administration > Plugins does
  await until("members told the new limit", () => limitOf(bob) === 1);
  await until("a lower limit shows only the first pet", () => petsOf(bob, bob.id).length === 1);
  await bed.setSetting(PETS, "limit", 4);
  await until("raised again, his three pets come back", () => limitOf(ann) === 4 && petsOf(bob, bob.id).length === 3);
  assert.deepEqual(await bed.errors(), {});
});

// Names in any script, the most pets, a crowd leaving and long wander goals all at once: no message
// may go over the 4 KB a plugin message carries (counted in UTF-8 bytes), or the plugin would crash.
test("messages stay under the limit in any script", async () => {
  const bed = await open();
  const ann = await bed.join("m1");
  const crowd = [ann, ...(await Promise.all(Array.from({ length: 59 }, (_, i) => bed.join(`m${i + 2}`))))];
  const name = "猫".repeat(24);
  const eight = Array.from({ length: 8 }, (_, k) => `[${k},"ff8800","p${k}","${name}"]`).join(",");
  await bed.setSetting(PETS, "limit", 8);
  const seed: Record<string, string> = {};
  for (const m of crowd) seed[`p:${m.id}`] = `[${eight}]`;
  await bed.seedKv(PETS, seed);
  const leavers = crowd.slice(0, 30);
  const stayers = crowd.slice(30);
  const watcher = stayers[stayers.length - 1];
  await until("the pets announced", () => stayers.every((m) => petsOf(watcher, m.id).length === 8));
  await Promise.all(leavers.map((m) => m.leave())); // half the office leaves at once
  for (const m of stayers) {
    m.send(PETS, { t: "mode", m: "wander" });
    m.send(PETS, { t: "wander", g: [[12345.678901234, -9876.54321987, 33.333333333], [1.000000001, 2.0000003, 10.5], null, "7:p1", [0, 0, 80], [5, 5, 40], [6, 6, 40], [7, 7, 40]] });
  }
  await until("the leavers announced as gone", () => leavers.every((m) => frames(watcher).some((f) => f.del?.includes(m.id))), 25_000); // the server keeps a socket's member about 11 s (reconnect grace)
  await until("the goals of all the stayers", () => stayers.every((m) => frames(watcher).some((f) => f.go?.some((g) => g.id === m.id))));
  for (const m of stayers) {
    const pets = petsOf(watcher, m.id);
    assert.equal(pets.length, 8, `member ${m.id}`);
    assert.equal(pets[0][3], name, `member ${m.id}`);
  }
  for (const m of stayers) for (const f of frames(m)) assert.ok(bytes(f) <= 4096, `a ${bytes(f)}-byte message`);
  assert.deepEqual(await bed.errors(), {});
});

test("names are never cut inside a character", async () => {
  const bed = await open();
  const bob = await bed.join("Bob");
  await say(bob, { t: "add", k: 0 }, { t: "name", i: 0, n: "🐈".repeat(30) });
  await until("the name", () => petsOf(bob, bob.id)[0]?.[3]);
  const got = petsOf(bob, bob.id);
  assert.equal(got.length, 1);
  assert.equal(got[0][3], "🐈".repeat(24), "24 whole characters");
});

test("it ignores malformed messages", async () => {
  const bed = await open();
  const ann = await bed.join("Ann");
  const msgs: unknown[] = [null, "x", [], { t: 5 }, { t: {} }, { t: "nope" }, true, {}, [1, 2], { t: null },
    { t: "add" }, { t: "remove", i: "0" }, { t: "colour", i: 0 }, { t: "wander", g: "x" }, { t: "wander", g: [[1]] }, { t: "limit" }];
  for (let i = 0; i < 12; i++) msgs.push(5);
  for (const [i, d] of msgs.entries()) {
    ann.send(PETS, d);
    if (i % 10 === 9) await sleep(1100); // the socket lets 10 a second through, with a burst of 20
  }
  // the probe: the plugin still answers after all of the above, and nothing was logged as an error
  await say(ann, { t: "add", k: 0 });
  await until("the probe's pet", () => petsOf(ann, ann.id).length === 1);
  assert.deepEqual(await bed.errors(), {});
});

test("it survives control spam", async () => {
  const bed = await open();
  const ann = await bed.join("Ann");
  const bob = await bed.join("Bob");
  const spam = [{ t: "add", k: 2 }, { t: "add", k: 99 }, { t: "colour", i: 0, c: "00ff00" }, { t: "colour", i: 7, c: "00ff00" }, { t: "remove", i: 0 },
    { t: "mode", m: "wander" }, { t: "wander", g: [[10, 20], [30, 40]] }, { t: "wander", g: [["a", 1]] }, { t: "wander", g: [[1e300, 1]] }, { t: "mode", m: "follow" }, { t: "limit", n: 5 }];
  for (let i = 0; i < 30; i++) { // 10 a second each, as fast as the socket allows
    ann.send(PETS, spam[i % spam.length]);
    bob.send(PETS, spam[(i + 3) % spam.length]);
    await sleep(100);
  }
  // and Bob keeps leaving and coming back: invisible and back is a leave and a join for the plugin at once
  // (a socket closed and reopened within the server's reconnect grace, about 10 s, would be neither)
  const seen = frames(ann).length;
  for (let i = 0; i < 15; i++) {
    bob.setStatus("invisible");
    await sleep(150);
    bob.setStatus("available");
    await sleep(150);
  }
  const after = frames(ann).slice(seen);
  const left = after.filter((f) => f.del?.includes(bob.id)).length;
  assert.ok(left >= 10,`Ann was told ${left} times that Bob left: the churn did not reach the plugin`);
  const lastLeft = after.findLastIndex((f) => f.del?.includes(bob.id));
  await until("Bob back after the churn", () => frames(ann).slice(seen + lastLeft + 1).some((f) => f.set?.some((e) => e.id === bob.id)));
  // the probe: still running, and it still broadcasts
  await say(ann, { t: "mode", m: "follow" }, { t: "mode", m: "wander" });
  await until("a broadcast after the spam", () => entryOf(ann, ann.id)?.mode === "wander");
  assert.deepEqual(await bed.errors(), {});
});

// Another plugin puts its own pets with members through the setPet hook: only with the member whose
// message it handles, at most 4, from its shared/ folder, apart from the member's own pets and limit.
test("guest pets come through the hooks", async () => {
  const bed = await open([pluginDir, callerDir]);
  const bob = await bed.join("Bob");
  const alone = await bob.waitFor<{ r: { ok: boolean } }>("caller", (d: { hook?: unknown }) => d.hook === "alone");
  assert.equal(alone.r.ok, false, "a call made on its own (no member's action) gives nobody a pet");
  let n = 0;
  const call = async (hook: string, args: unknown): Promise<HookResult> => {
    const id = ++n;
    bob.send("caller", { n: id, hook, args });
    return (await bob.waitFor<{ r: HookResult }>("caller", (d: { n?: unknown }) => d.n === id)).r;
  };
  assert.equal((await call("setPet", { id: "x", sheet: "../main.ts", cell: [24, 24] })).ok, false, "only a PNG of the caller's shared/ folder");
  for (const args of [
    { id: "x", metadata: { kind: 25 }, sheet: "shared/critter.png", cell: [24, 24] }, // a sheet or metadata, not both
    { id: "x", metadata: { kind: 25 }, cell: [24, 24] }, // a drawn sheet carries its own size
    { id: "x", metadata: "m".repeat(300) }, // at most 256 bytes
  ]) {
    assert.equal((await call("setPet", args)).ok, false, `refused: ${JSON.stringify(args).slice(0, 60)}`);
  }
  for (let i = 0; i < 4; i++) {
    const r = await call("setPet", { id: `p${i}`, sheet: "shared/critter.png", cell: [24, 24], name: `C${i}` });
    assert.equal(r.ok, true, `guest ${i}: ${JSON.stringify(r)}`);
  }
  const full = await call("setPet", { id: "p9", sheet: "shared/critter.png", cell: [24, 24] });
  assert.deepEqual([full.ok, full.error], [false, "full"], "at most 4 guests");
  const again = await call("setPet", { id: "p0", metadata: { kind: 25, alt: true }, name: "Again" });
  assert.equal(again.ok, true, "the same id replaces its pet, here with one the caller draws itself (metadata)");
  assert.equal((await call("removePet", { id: "p1" })).removed, true);
  await until("three guests", () => entryOf(bob, bob.id)?.guests.length === 3);
  const entry = entryOf(bob, bob.id)!;
  assert.equal(entry.pets.length, 0, "guests are not the member's own pets");
  assert.equal(entry.guests[0].from, "caller");
  const drawn = entry.guests[2];
  assert.deepEqual(
    [drawn.metadata?.kind, drawn.metadata?.alt, drawn.sheet, drawn.cell],
    [25, true, undefined, undefined],
    "a guest drawn by its plugin goes to the pages with its metadata, without a sheet",
  );
  // the plugin stops: its guests go and their places are given back; running again, it puts them again
  await bed.setPlugin("caller", false);
  await until("guests gone with their plugin", () => entryOf(bob, bob.id)?.guests.length === 0);
  await bed.setPlugin("caller", true);
  for (let i = 0; i < 4; i++) {
    const r = await call("setPet", { id: `q${i}`, sheet: "shared/critter.png", cell: [24, 24] });
    assert.equal(r.ok, true, `the places of a stopped plugin's guests are free again (guest ${i}): ${JSON.stringify(r)}`);
  }
  assert.deepEqual(await bed.errors(), {});
});
