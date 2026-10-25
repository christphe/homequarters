// The whiteboard's model (game/boardModel.ts): the server's events applied to the strokes the board draws.
// Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardModel } from "../src/game/boardModel.ts";
import type { BoardStroke } from "../src/net/protocol.ts";

const stroke = (o: number, i: number, p: number[]): BoardStroke => ({ o, i, k: 0, c: 0x222222, w: 2, p });

function opened(): BoardModel {
  const b = new BoardModel();
  b.apply({ t: "wb", op: "state", bk: "wb:3,4", w: 800, h: 500, s: [stroke(1, 1, [0, 0, 5, 5])] });
  return b;
}

test("a state opens the board with its size and strokes", () => {
  const b = opened();
  assert.equal(b.key, "wb:3,4");
  assert.equal(b.width, 800);
  assert.equal(b.height, 500);
  assert.deepEqual(b.strokes, [stroke(1, 1, [0, 0, 5, 5])]);
});

test("draw adds a stroke, then extends it while it is drawn (same author and id)", () => {
  const b = opened();
  b.apply({ t: "wb", op: "draw", bk: "wb:3,4", ...stroke(2, 1, [10, 10]) });
  b.apply({ t: "wb", op: "draw", bk: "wb:3,4", ...stroke(2, 1, [12, 14]) });
  b.apply({ t: "wb", op: "draw", bk: "wb:3,4", ...stroke(1, 2, [1, 1]) });
  assert.equal(b.strokes.length, 3);
  assert.deepEqual(b.strokes[1].p, [10, 10, 12, 14], "the points of one stroke are appended");
  assert.deepEqual(b.strokes[0].p, [0, 0, 5, 5], "another author's stroke with the same id is another stroke");
});

test("a text note keeps its text", () => {
  const b = opened();
  b.apply({ t: "wb", op: "draw", bk: "wb:3,4", ...stroke(2, 5, [40, 40]), tx: "Agenda" });
  assert.equal(b.strokes.at(-1)?.tx, "Agenda");
});

test("del removes one stroke, clear all of them", () => {
  const b = opened();
  b.apply({ t: "wb", op: "draw", bk: "wb:3,4", ...stroke(2, 1, [10, 10]) });
  b.apply({ t: "wb", op: "del", bk: "wb:3,4", o: 1, i: 1 });
  assert.deepEqual(b.strokes.map((s) => [s.o, s.i]), [[2, 1]]);
  b.apply({ t: "wb", op: "clear", bk: "wb:3,4" });
  assert.deepEqual(b.strokes, []);
});

test("events of another board change nothing", () => {
  const b = opened();
  b.apply({ t: "wb", op: "draw", bk: "wb:9,9", ...stroke(2, 1, [10, 10]) });
  b.apply({ t: "wb", op: "clear", bk: "wb:9,9" });
  b.apply({ t: "wb", op: "del", bk: "wb:9,9", o: 1, i: 1 });
  assert.deepEqual(b.strokes, [stroke(1, 1, [0, 0, 5, 5])]);
});

test("closed empties the board; later events of it are ignored", () => {
  const b = opened();
  b.apply({ t: "wb", op: "closed" });
  assert.equal(b.key, "");
  assert.deepEqual(b.strokes, []);
  b.apply({ t: "wb", op: "draw", bk: "wb:3,4", ...stroke(2, 1, [10, 10]) });
  assert.deepEqual(b.strokes, []);
});

test("every event notifies the subscribers until they unsubscribe", () => {
  const b = new BoardModel();
  let n = 0;
  const off = b.subscribe(() => n++);
  b.apply({ t: "wb", op: "state", bk: "k", w: 1, h: 1, s: [] });
  b.apply({ t: "wb", op: "clear", bk: "other" });
  assert.equal(n, 2);
  off();
  b.apply({ t: "wb", op: "closed" });
  assert.equal(n, 2);
});
