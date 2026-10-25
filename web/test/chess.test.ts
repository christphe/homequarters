// hq-chess rules: seats, moves, reset. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  START, newBoard, parseBoard, sideOf, seatOf, take, move, canReset, reset, squareName, place, toReserve, changeBetween, canUndo, undo,
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

// Task 8c: the reserve of captured pieces, and promotion.

/** START with some squares changed: [square, piece]. */
function withSquares(...sq: [number, string][]): string {
  const a = START.split("");
  for (const [i, c] of sq) a[i] = c;
  return a.join("");
}

test("a new board has an empty reserve", () => {
  assert.equal(newBoard().r, "");
});

test("a capture puts the taken piece in the reserve, in capture order", () => {
  const b = seated();
  assert.equal(move(b, 1, 52, 12), true, "e2 takes e7");
  assert.equal(b.r, "p");
  assert.equal(move(b, 2, 3, 12), true, "d8 takes e7");
  assert.equal(b.r, "pP");
  assert.equal(move(b, 1, 51, 43), true, "a move to an empty square takes nothing");
  assert.equal(b.r, "pP");
});

test("the reserve holds at most 30 pieces: the oldest goes first", () => {
  const b = seated();
  b.r = "Q" + "p".repeat(29);
  assert.equal(move(b, 1, 52, 12), true);
  assert.equal(b.r.length, 30);
  assert.equal(b.r, "p".repeat(30), "the oldest (Q) was dropped");
});

test("place: a piece of mine from the reserve onto a square", () => {
  const b = seated();
  b.r = "pQn";
  assert.equal(place(b, 1, "Q", 35), true, "onto empty d4");
  assert.equal(b.p[35], "Q");
  assert.equal(b.r, "pn");
  b.r = "QpQ";
  assert.equal(place(b, 1, "Q", 12), true, "onto e7: the black pawn there goes to the reserve");
  assert.equal(b.p[12], "Q");
  assert.equal(b.r, "Qpp", "one Q removed (the latest), the taken pawn added at the end");
});

test("place refuses another colour, a spectator, a piece not in the reserve, bad input", () => {
  const b = seated();
  b.r = "qP";
  const p = b.p;
  assert.equal(place(b, 1, "q", 35), false, "White places a black piece");
  assert.equal(place(b, 3, "P", 35), false, "spectator");
  assert.equal(place(b, 1, "Q", 35), false, "not in the reserve");
  assert.equal(place(b, 1, "x", 35), false);
  assert.equal(place(b, 1, "PP", 35), false);
  assert.equal(place(b, 1, "P", 64), false);
  assert.equal(place(b, 1, "P", -1), false);
  assert.equal(place(b, 1, "P", 2.5), false);
  assert.equal(place(b, 2, "q", 35), true, "Black places a black one");
  assert.equal(b.r, "P");
  assert.notEqual(b.p, p);
});

test("toReserve: one of my pieces off the board", () => {
  const b = seated();
  assert.equal(toReserve(b, 1, 57), true);
  assert.equal(b.p[57], ".");
  assert.equal(b.r, "N");
  assert.equal(toReserve(b, 1, 12), false, "a black piece");
  assert.equal(toReserve(b, 1, 57), false, "an empty square");
  assert.equal(toReserve(b, 3, 8), false, "spectator");
  assert.equal(toReserve(b, 1, 64), false);
  assert.equal(toReserve(b, 2, 12), true);
  assert.equal(b.r, "Np");
});

test("promotion of a pawn on its last rank, whatever is on the board", () => {
  const b = seated();
  b.p = withSquares([12, "P"], [4, "."]); // a white pawn on e7, e8 empty; White still has its queen
  assert.equal(move(b, 1, 12, 4, "q"), true);
  assert.equal(b.p[4], "Q");
  assert.equal(b.p[12], ".");
  assert.equal(b.p.split("").filter((c) => c === "Q").length, 2, "two white queens");
  b.p = withSquares([12, "P"]);
  assert.equal(move(b, 1, 12, 3, "n"), true, "e7 takes d8 and becomes a knight");
  assert.equal(b.p[3], "N");
  assert.equal(b.r, "q");
  b.p = withSquares([52, "p"]); // a black pawn on e2
  assert.equal(move(b, 2, 52, 61, "r"), true, "black promotes on rank 1");
  assert.equal(b.p[61], "r");
  b.p = withSquares([12, "P"], [4, "."]);
  assert.equal(move(b, 1, 12, 4), true, "without promote it stays a pawn");
  assert.equal(b.p[4], "P");
});

test("promotion refused: not a pawn, not its last rank, a bad choice", () => {
  const b = seated();
  b.p = withSquares([12, "P"], [4, "."], [11, "N"], [3, "."]);
  const before = b.p;
  assert.equal(move(b, 1, 11, 3, "q"), false, "a knight");
  assert.equal(move(b, 1, 52, 44, "q"), false, "a pawn not reaching rank 8");
  assert.equal(move(b, 1, 12, 4, "k"), false);
  assert.equal(move(b, 1, 12, 4, "p"), false);
  assert.equal(move(b, 1, 12, 4, "Q"), false, "the choice is lowercase");
  assert.equal(move(b, 1, 12, 4, ""), false);
  assert.equal(move(b, 2, 12, 4, "q"), false, "Black promoting a white pawn");
  assert.equal(b.p, before, "nothing moved");
  b.p = withSquares([44, "P"], [60, "."]);
  assert.equal(move(b, 1, 44, 60, "q"), false, "a white pawn on rank 1 is not its last rank");
});

test("parseBoard reads the reserve", () => {
  const fresh = newBoard();
  assert.deepEqual(parseBoard(JSON.stringify({ p: START, w: null, b: null })), fresh, "missing r: empty");
  assert.equal(parseBoard(JSON.stringify({ p: START, w: null, b: null, r: "pQ" })).r, "pQ");
  assert.equal(parseBoard(JSON.stringify({ p: START, w: null, b: null, r: "p".repeat(30) })).r.length, 30);
  for (const r of ["x", "p.", "p".repeat(31), 7, null, ["p"]]) {
    assert.deepEqual(parseBoard(JSON.stringify({ p: START, w: ann, b: null, r })), fresh, `bad r ${JSON.stringify(r)}`);
  }
  const b = seated();
  move(b, 1, 52, 12);
  assert.deepEqual(parseBoard(JSON.stringify(b)), b);
});

test("reset empties the reserve", () => {
  const b = seated();
  move(b, 1, 52, 12);
  reset(b);
  assert.equal(b.r, "");
});

test("changeBetween names what one action did", () => {
  const b = seated();
  const at = () => ({ p: b.p, r: b.r });
  let a = at();
  move(b, 1, 52, 36);
  assert.equal(changeBetween(a, at()), "White: pawn e2 to e4");
  a = at();
  move(b, 2, 12, 36);
  assert.equal(changeBetween(a, at()), "Black: pawn e7 to e4");
  a = at();
  place(b, 1, "P", 20);
  assert.equal(changeBetween(a, at()), "White: pawn from reserve to e6");
  a = at();
  toReserve(b, 2, 1);
  assert.equal(changeBetween(a, at()), "Black: knight b8 to reserve");
  b.p = withSquares([12, "P"], [4, "."]);
  a = at();
  move(b, 1, 12, 4, "q");
  assert.equal(changeBetween(a, at()), "White: pawn e7 to e8, queen");
  a = at();
  reset(b);
  assert.equal(changeBetween(a, at()), "The board is set up for a new game");
  assert.equal(changeBetween(at(), at()), null);
  assert.equal(changeBetween({ p: START, r: "" }, { p: withSquares([0, "."], [1, "."], [2, "."]), r: "" }), null);
});

// The undo: the last action only, one level, by either seated player who has the board open.

const both = new Set([1, 2]);
const snap = (b: { p: string; r: string }) => ({ p: b.p, r: b.r });

test("undo restores the position and the reserve before a move, a capture, a promotion, a place and a stash", () => {
  type B = ReturnType<typeof seated>;
  const cases: [string, (b: B) => void, (b: B) => boolean, { from?: number; to?: number }][] = [
    ["a move", () => {}, (b) => move(b, 1, 52, 36), { from: 52, to: 36 }],
    ["a capture", () => {}, (b) => move(b, 1, 52, 12), { from: 52, to: 12 }],
    ["a promotion with a capture", (b) => { b.p = withSquares([12, "P"]); }, (b) => move(b, 1, 12, 3, "q"), { from: 12, to: 3 }],
    ["a place onto a piece", (b) => { b.r = "pQn"; }, (b) => place(b, 1, "Q", 12), { to: 12 }],
    ["a stash", () => {}, (b) => toReserve(b, 2, 1), { from: 1 }],
  ];
  for (const [what, setUp, act, last] of cases) {
    const b = seated();
    b.r = "Pq";
    setUp(b);
    const want = snap(b);
    assert.equal(act(b), true, what);
    assert.notDeepEqual(snap(b), want, what + ": the action changed the board");
    assert.deepEqual(b.u, want, what + ": u is the board before");
    assert.deepEqual(b.m, last, what + ": m is the last action");
    assert.equal(canUndo(b, 1, both), true, what);
    assert.equal(undo(b, 2, both), true, what + ": the other seated player undoes it");
    assert.deepEqual(snap(b), want, what + ": position and reserve exactly as before");
    assert.equal(b.u, null);
    assert.equal(b.m, null);
    assert.equal(seatOf(b, 1), "w", "seats unchanged");
    assert.equal(seatOf(b, 2), "b");
  }
});

test("one level only: a second undo is refused", () => {
  const b = seated();
  move(b, 1, 52, 36);
  move(b, 2, 12, 28);
  assert.equal(undo(b, 1, both), true);
  assert.equal(b.p[36], "P", "only the last action went back");
  assert.equal(b.p[28], ".");
  assert.equal(canUndo(b, 1, both), false);
  assert.equal(undo(b, 1, both), false);
  assert.equal(undo(b, 2, both), false);
  assert.equal(b.p[36], "P");
});

test("undo is refused to a watcher, an absent seated player, and on a board with nothing to undo", () => {
  const b = seated();
  assert.equal(undo(b, 1, both), false, "nothing done yet");
  move(b, 1, 52, 36);
  const after = snap(b);
  assert.equal(canUndo(b, 3, new Set([1, 2, 3])), false, "a watcher");
  assert.equal(undo(b, 3, new Set([1, 2, 3])), false);
  assert.equal(canUndo(b, 1, new Set([2])), false, "the mover, window closed");
  assert.equal(undo(b, 1, new Set([2])), false);
  assert.deepEqual(snap(b), after);
  assert.equal(undo(b, 1, new Set([1])), true, "present, without the other player");
});

test("a refused action keeps the undo of the last good one; reset clears it", () => {
  const b = seated();
  move(b, 1, 52, 36);
  assert.equal(move(b, 1, 12, 28), false);
  assert.deepEqual(b.m, { from: 52, to: 36 });
  reset(b);
  assert.equal(b.u, null);
  assert.equal(b.m, null);
});

test("parseBoard: u and m round trip; old boards and bad values load without them", () => {
  const b = seated();
  move(b, 1, 52, 12);
  const back = parseBoard(JSON.stringify(b));
  assert.deepEqual(back, b);
  assert.deepEqual(back.u, { p: START, r: "" });
  assert.deepEqual(back.m, { from: 52, to: 12 });
  const old = parseBoard(JSON.stringify({ p: START, w: ann, b: null, r: "p" }));
  assert.equal(old.u, null);
  assert.equal(old.m, null);
  assert.deepEqual(old.w, ann, "an old board keeps its game");
  for (const u of [7, "x", { p: "x", r: "" }, { p: START, r: "x" }, { p: START }]) {
    const o = parseBoard(JSON.stringify({ p: START, w: ann, b: null, r: "", u, m: { from: 1 } }));
    assert.equal(o.u, null, `bad u ${JSON.stringify(u)}`);
    assert.equal(o.m, null, "no highlight without its undo either");
    assert.deepEqual(o.w, ann);
  }
  for (const m of [7, {}, { from: 64 }, { to: -1 }, { from: 1.5 }, { from: "1" }]) {
    const o = parseBoard(JSON.stringify({ p: START, w: ann, b: null, r: "", u: { p: START, r: "" }, m }));
    assert.equal(o.m, null, `bad m ${JSON.stringify(m)}`);
  }
});
