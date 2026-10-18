// The plugin layer's path searches (walkTo) run a few per frame, whatever a plugin sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SearchQueue } from "../src/game/searchQueue.ts";

test("a batch of 512 walks costs at most the budget per frame, latest goal per sprite", () => {
  const q = new SearchQueue<string>(4);
  const ran: string[] = [];
  for (let i = 0; i < 512; i++) q.request("s" + (i % 300), "goal" + i, (g) => ran.push(g));
  assert.equal(q.size, 300, "one pending search per sprite: a new goal replaces the old one");
  q.run();
  assert.equal(ran.length, 4);
  for (let f = 0; f < 200; f++) q.run();
  assert.equal(ran.length, 300);
  assert.ok(ran.includes("goal511") && !ran.includes("goal0"), "the latest goal of a sprite wins");
  assert.equal(q.size, 0);
});

test("a cancelled search never runs", () => {
  const q = new SearchQueue<number>(2);
  let n = 0;
  q.request("a", 1, () => n++);
  q.cancel("a");
  q.run();
  assert.equal(n, 0);
});
