// node --test e2e/shards.test.ts (the last test reads plugins/e2e: e2e:test:unit has it in its inputs)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ALL, DURATIONS, PROJECTS, UNKNOWN, plan, shard, parseShard, shardsFor } from "./shards.ts";

const cost = (names: string[]) => names.reduce((s, n) => s + (DURATIONS[n] ?? UNKNOWN), 0);

for (const n of [1, 2, 3, 4, 5, 8, 30]) {
  void test(`${n} shards cover the suite exactly once, in suite order`, () => {
    const parts = Array.from({ length: n }, (_, k) => shard(ALL, k + 1, n));
    assert.deepEqual(parts.flat().sort(), [...ALL].sort());
    assert.equal(new Set(parts.flat()).size, ALL.length);
    for (const p of parts) assert.deepEqual(p, ALL.filter((s) => p.includes(s)));
  });
}

void test("one shard is the whole suite in its order", () => assert.deepEqual(shard(ALL, 1, 1), ALL));

void test("4 shards are balanced: none above the longest scenario or 15% over the mean", () => {
  const loads = [1, 2, 3, 4].map((i) => cost(shard(ALL, i, 4)));
  const mean = cost(ALL) / 4;
  // oxlint-disable-next-line typescript/restrict-template-expressions -- the loads print as a comma list on purpose
  for (const l of loads) assert.ok(l <= Math.max(DURATIONS.offices, mean * 1.15), `loads ${loads}`);
});

void test("every scenario of the suite has a measured duration", () => {
  for (const s of ALL) assert.ok(s in DURATIONS, s);
});

void test("unknown scenarios count as UNKNOWN seconds and still land somewhere", () => {
  const all = [...ALL, "brand-new"];
  assert.equal(cost(["brand-new"]), UNKNOWN);
  assert.equal([1, 2, 3].flatMap((i) => shard(all, i, 3)).filter((s) => s === "brand-new").length, 1);
});

void test("shard specs are validated", () => {
  assert.deepEqual(parseShard("2/4"), { i: 2, n: 4 });
  for (const bad of ["0/4", "5/4", "1/0", "x", "1-4", undefined]) assert.throws(() => parseShard(bad));
  assert.throws(() => shard(ALL, 0, 3));
  assert.throws(() => shard(ALL, 4, 3));
});

void test("shardsFor: never more shards than scenarios, at least one", () => {
  assert.equal(shardsFor(2, 1), 1);
  assert.equal(shardsFor(2, 28), 2);
  assert.equal(shardsFor(3, 2), 2);
  assert.equal(shardsFor(1, 0), 1);
  assert.equal(shardsFor(NaN, 5), 1);
});

void test("plan: the 4 CI shards run every scenario and every e2e project once, balanced together", () => {
  const parts = [1, 2, 3, 4].map((i) => plan(i, 4));
  assert.deepEqual(parts.flatMap((p) => p.scenarios).sort(), [...ALL].sort());
  assert.deepEqual(parts.flatMap((p) => p.projects).sort(), [...PROJECTS].sort());
  const loads = parts.map((p) => cost([...p.scenarios, ...p.projects]));
  const mean = cost([...ALL, ...PROJECTS]) / 4;
  // oxlint-disable-next-line typescript/restrict-template-expressions -- the loads print as a comma list on purpose
  for (const l of loads) assert.ok(l <= Math.max(DURATIONS.offices, mean * 1.15), `loads ${loads}`);
  assert.deepEqual(plan(1, 1), { scenarios: ALL, projects: PROJECTS });
  assert.throws(() => plan(1, 2, ["a", "b"], ["b"]), /a project has a scenario's name: b/);
});

void test("PROJECTS lists every e2e project of plugins/e2e, each with a test:e2e and a measured duration", () => {
  const dir = path.resolve(import.meta.dirname, "../plugins/e2e");
  const found = fs.readdirSync(dir).filter((p) => fs.existsSync(path.join(dir, p, "fdash.json")));
  assert.deepEqual([...PROJECTS].sort(), found.sort());
  for (const p of found) {
    const config = JSON.parse(fs.readFileSync(path.join(dir, p, "fdash.json"), "utf8")) as { name?: string; tasks: Record<string, unknown> };
    assert.equal(config.name ?? p, p, `${p}: the project is named after its folder`);
    assert.ok("test:e2e" in config.tasks, `${p} has a test:e2e task`);
    assert.ok(p in DURATIONS, `${p} has a duration`);
  }
});
