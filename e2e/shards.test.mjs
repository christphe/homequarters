// node --test e2e/shards.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { ALL, DURATIONS, UNKNOWN, shard, parseShard } from "./shards.mjs";

const cost = (names) => names.reduce((s, n) => s + (DURATIONS[n] ?? UNKNOWN), 0);

for (const n of [1, 2, 3, 4, 5, 8, 30]) {
  test(`${n} shards cover the suite exactly once, in suite order`, () => {
    const parts = Array.from({ length: n }, (_, k) => shard(ALL, k + 1, n));
    assert.deepEqual(parts.flat().sort(), [...ALL].sort());
    assert.equal(new Set(parts.flat()).size, ALL.length);
    for (const p of parts) assert.deepEqual(p, ALL.filter((s) => p.includes(s)));
  });
}

test("one shard is the whole suite in its order", () => assert.deepEqual(shard(ALL, 1, 1), ALL));

test("4 shards are balanced: none above the longest scenario or 15% over the mean", () => {
  const loads = [1, 2, 3, 4].map((i) => cost(shard(ALL, i, 4)));
  const mean = cost(ALL) / 4;
  for (const l of loads) assert.ok(l <= Math.max(DURATIONS.offices, mean * 1.15), `loads ${loads}`);
});

test("every scenario of the suite has a measured duration", () => {
  for (const s of ALL) assert.ok(s in DURATIONS, s);
});

test("unknown scenarios count as UNKNOWN seconds and still land somewhere", () => {
  const all = [...ALL, "brand-new"];
  assert.equal(cost(["brand-new"]), UNKNOWN);
  assert.equal([1, 2, 3].flatMap((i) => shard(all, i, 3)).filter((s) => s === "brand-new").length, 1);
});

test("shard specs are validated", () => {
  assert.deepEqual(parseShard("2/4"), { i: 2, n: 4 });
  for (const bad of ["0/4", "5/4", "1/0", "x", "1-4", undefined]) assert.throws(() => parseShard(bad));
  assert.throws(() => shard(ALL, 0, 3));
  assert.throws(() => shard(ALL, 4, 3));
});
