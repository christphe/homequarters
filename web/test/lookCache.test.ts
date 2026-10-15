// Avatar look cache: freed on a look change or a disconnect, shared between people. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { LookCache } from "../src/game/lookCache.ts";

const make = () => {
  const built: string[] = [], destroyed: string[] = [];
  const cache = new LookCache<{ key: string }>((v) => destroyed.push(v.key));
  const acquire = (holder: number, key: string) => cache.acquire(holder, key, () => (built.push(key), { key }));
  return { cache, acquire, built, destroyed };
};

test("a look is built once and shared by everybody wearing it", () => {
  const { acquire, built } = make();
  const a = acquire(1, "red");
  assert.equal(acquire(2, "red"), a);
  assert.equal(acquire(1, "red"), a, "asking again for the same look takes no new reference");
  assert.deepEqual(built, ["red"]);
});

test("changing look frees the old one unless someone else still wears it", () => {
  const { cache, acquire, destroyed } = make();
  acquire(1, "red");
  acquire(2, "red");
  acquire(1, "blue");
  assert.deepEqual(destroyed, []);
  acquire(2, "green");
  assert.deepEqual(destroyed, ["red"]);
  assert.equal(cache.size, 2);
});

test("leaving frees the look; releasing twice or an unknown holder is harmless", () => {
  const { cache, acquire, destroyed } = make();
  acquire(1, "red");
  cache.release(1);
  cache.release(1);
  cache.release(99);
  assert.deepEqual(destroyed, ["red"]);
  assert.equal(cache.size, 0);
});

test("someone cycling through 1000 looks leaves one look in memory", () => {
  const { cache, acquire, destroyed } = make();
  for (let i = 0; i < 1000; i++) acquire(7, "look" + i);
  assert.equal(cache.size, 1);
  assert.equal(destroyed.length, 999);
});
