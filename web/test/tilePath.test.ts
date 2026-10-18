// Path finding for plugin sprites over the map's tiles. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearLine, findPath } from "../src/game/tilePath.ts";

// 10 x 6 tiles; a wall at column 4 from row 0 to row 4 leaves a gap at row 5
const W = 10, H = 6, T = 16;
const wall = (tx: number, ty: number) => tx === 4 && ty <= 4;
const walkable = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < W && ty < H && !wall(tx, ty);

test("goes around a wall instead of through it", () => {
  const p = findPath(1 * T + 8, 1 * T + 8, 8 * T + 8, 1 * T + 8, walkable);
  assert.ok(p && p.length > 2, "a path");
  for (const q of p!) assert.ok(walkable(Math.floor(q.x / T), Math.floor(q.y / T)), `waypoint ${q.x},${q.y} on a free tile`);
  assert.ok(p!.some((q) => Math.floor(q.y / T) === 5), "passes through the gap at the bottom");
  const last = p![p!.length - 1];
  assert.deepEqual([last.x, last.y], [8 * T + 8, 1 * T + 8], "ends at the target");
});

test("a straight walk when nothing is in the way", () => {
  const p = findPath(1 * T + 3, 5 * T + 8, 8 * T + 2, 5 * T + 8, walkable);
  assert.ok(p && p.length <= 2, JSON.stringify(p));
});

test("no path to a walled-in target, and the search is bounded", () => {
  const closed = (tx: number, ty: number) => walkable(tx, ty) && !(tx >= 7 && ty <= 2) || (tx === 8 && ty === 1);
  assert.equal(findPath(1 * T + 8, 1 * T + 8, 8 * T + 8, 1 * T + 8, closed), null);
  const open = (tx: number, ty: number) => Math.abs(tx) < 1000 && Math.abs(ty) < 1000 && !(tx === 5 && ty !== 990); // a long wall forces a search
  assert.equal(findPath(0, 0, 900 * T, 900 * T, open, 500), null, "gives up after maxNodes");
});

test("clearLine says whether a straight walk crosses a wall", () => {
  assert.equal(clearLine(1 * T + 8, 1 * T + 8, 3 * T + 8, 1 * T + 8, walkable), true);
  assert.equal(clearLine(3 * T + 8, 1 * T + 8, 5 * T + 8, 1 * T + 8, walkable), false, "through the wall at column 4");
});
