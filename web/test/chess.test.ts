// hq-chess rules: seats, moves, reset. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  START, newBoard, parseBoard, sideOf, seatOf, take, move, canReset, reset, squareName,
} from "../../plugins/bundled/hq-chess/public/game.ts";

const ann = { id: 1, name: "Ann" };
const bob = { id: 2, name: "Bob" };

function seated() {
  const b = newBoard();
  assert.ok(take(b, "w", ann));
  assert.ok(take(b, "b", bob));
  return b;
}

test("take refuses a taken seat and a member already seated", () => {
  const b = newBoard();
  assert.equal(take(b, "w", ann), true);
  assert.equal(take(b, "w", bob), false);
  assert.equal(take(b, "b", ann), false);
  assert.equal(take(b, "w", ann), false);
  assert.equal(take(b, "b", bob), true);
  assert.equal(seatOf(b, 1), "w");
  assert.equal(seatOf(b, 2), "b");
  assert.equal(seatOf(b, 3), null);
});

test("move rules", () => {
  const b = seated();
  assert.equal(move(b, 1, 52, 36), true);
  assert.equal(b.p[52], ".");
  assert.equal(b.p[36], "P");
  assert.equal(move(b, 1, 12, 28), false, "white moves a black piece");
  assert.equal(move(b, 3, 8, 16), false, "spectator");
  assert.equal(move(b, 1, 48, 48), false, "same square");
  assert.equal(move(b, 1, -1, 5), false);
  assert.equal(move(b, 1, 48, 64), false);
  assert.equal(move(b, 1, 1.5, 3), false);
});

test("move onto a black piece removes it", () => {
  const b = seated();
  assert.equal(move(b, 1, 60, 4), true);
  assert.equal(b.p[4], "K");
  assert.equal(b.p[60], ".");
  assert.equal(b.p.replace(/\./g, "").length, 31);
});

test("moving an empty square fails", () => {
  const b = seated();
  assert.equal(move(b, 1, 32, 33), false);
});

test("canReset", () => {
  const b = seated();
  assert.equal(canReset(b, 1, new Set([1])), true);
  assert.equal(canReset(b, 3, new Set([1, 3])), false);
  assert.equal(canReset(b, 3, new Set([3])), true);
  assert.equal(canReset(b, 1, new Set([2, 1])), true);
  assert.equal(canReset(b, 1, new Set([2])), false, "absent seated player while the other is present");
  assert.equal(canReset(newBoard(), 3, new Set([3])), true);
  assert.equal(canReset(newBoard(), 3, new Set()), true);
});

test("reset", () => {
  const b = seated();
  move(b, 1, 52, 36);
  reset(b);
  assert.equal(b.p, START);
  assert.equal(b.w, null);
  assert.equal(b.b, null);
});

test("parseBoard", () => {
  const fresh = newBoard();
  assert.deepEqual(parseBoard(null), fresh);
  assert.deepEqual(parseBoard("{"), fresh);
  assert.deepEqual(parseBoard(JSON.stringify({ p: START.slice(1), w: null, b: null })), fresh);
  assert.deepEqual(parseBoard(JSON.stringify({ p: "x" + START.slice(1), w: null, b: null })), fresh);
  assert.deepEqual(parseBoard(JSON.stringify({ p: START, w: { id: "a", name: "A" }, b: null })), fresh);
  const b = seated();
  assert.deepEqual(parseBoard(JSON.stringify(b)), b);
});

test("sideOf and squareName", () => {
  assert.equal(sideOf("K"), "w");
  assert.equal(sideOf("k"), "b");
  assert.equal(sideOf("."), null);
  assert.equal(sideOf("x"), null);
  assert.equal(squareName(52), "e2");
  assert.equal(squareName(0), "a8");
  assert.equal(squareName(63), "h1");
});
