// hq-chess's board view and window without the browser: what the view lets a member pick up and send, what it
// says, how it confirms or undoes an action of mine (public/sync.ts), and the window's buttons (public/window.ts).
// The browser scenario e2e/scenarios/chess.mjs keeps the wiring: real drags, keys and buttons. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { START } from "../../plugins/bundled/hq-chess/public/game.ts";
import type { BoardState, ViewIn } from "../../plugins/bundled/hq-chess/public/messages.ts";
import { BoardSync } from "../../plugins/bundled/hq-chess/public/sync.ts";
import { holders, resetAllowed, seatButton, undoAllowed } from "../../plugins/bundled/hq-chess/public/window.ts";

const ANN = 1, BO = 2, CY = 3; // White, Black, a spectator
const sq = (name: string) => (8 - Number(name[1])) * 8 + "abcdefgh".indexOf(name[0]);
const state = (o: Partial<BoardState> = {}): BoardState => ({
  p: START, w: { id: ANN, name: "Ann", here: true }, b: { id: BO, name: "Bo", here: true }, r: "", u: false, m: null, undone: null, ...o,
});
const msg = (s: BoardState, me: number, id = "13,22"): ViewIn => ({ s, me, id });
/** A view that got its first state of the board. */
function viewOf(me: number, s = state()): BoardSync {
  const v = new BoardSync();
  v.receive(msg(s, me));
  return v;
}
/** START with some squares changed. */
function withSquares(...set: [string, string][]): string {
  const a = START.split("");
  for (const [name, c] of set) a[sq(name)] = c;
  return a.join("");
}
const e4 = withSquares(["e2", "."], ["e4", "P"]);

// ---- what may be picked up and what a drop sends

test("a spectator picks nothing up, White only white pieces, Black only black ones", () => {
  const cy = viewOf(CY), ann = viewOf(ANN), bo = viewOf(BO);
  assert.equal(cy.canHold({ k: "sq", sq: sq("e2") }), false, "the spectator");
  assert.equal(cy.canHold({ k: "sq", sq: sq("e4") }), false, "the spectator, an empty square");
  assert.equal(cy.canHold({ k: "res", i: 0 }), false, "the spectator, past an empty reserve");
  assert.equal(cy.dropOf({ k: "sq", sq: sq("e2") }, { k: "sq", sq: sq("e4") }), null, "nothing is sent for a spectator's drag");
  assert.equal(ann.canHold({ k: "sq", sq: sq("e2") }), true);
  assert.equal(ann.canHold({ k: "sq", sq: sq("e7") }), false, "White, a black pawn");
  assert.equal(ann.dropOf({ k: "sq", sq: sq("e7") }, { k: "sq", sq: sq("e5") }), null, "nothing is sent for it");
  assert.equal(ann.canHold({ k: "sq", sq: sq("e4") }), false, "an empty square");
  assert.equal(bo.canHold({ k: "sq", sq: sq("e7") }), true);
  assert.equal(bo.canHold({ k: "sq", sq: sq("e2") }), false);
});

test("a drop outside the board or back on its square sends nothing; on another square, one move", () => {
  const ann = viewOf(ANN);
  const d2 = { k: "sq", sq: sq("d2") } as const;
  assert.equal(ann.dropOf(d2, null), null, "outside the canvas: the piece goes back");
  assert.equal(ann.dropOf(d2, { k: "sq", sq: sq("d2") }), null);
  assert.deepEqual(ann.dropOf(d2, { k: "sq", sq: sq("d4") }), { t: "move", from: sq("d2"), to: sq("d4") });
  assert.deepEqual(ann.dropOf({ k: "sq", sq: sq("g1") }, { k: "sq", sq: sq("f3") }), { t: "move", from: sq("g1"), to: sq("f3") });
});

test("a pawn dropped on its last rank asks for the promotion first; a piece there, or a pawn short of it, just moves", () => {
  const ann = viewOf(ANN), bo = viewOf(BO);
  assert.deepEqual(ann.dropOf({ k: "sq", sq: sq("a2") }, { k: "sq", sq: sq("e8") }), { t: "promote", from: sq("a2"), to: sq("e8") });
  assert.deepEqual(ann.dropOf({ k: "sq", sq: sq("b1") }, { k: "sq", sq: sq("b8") }), { t: "move", from: sq("b1"), to: sq("b8") }, "a knight");
  assert.deepEqual(ann.dropOf({ k: "sq", sq: sq("a2") }, { k: "sq", sq: sq("a7") }), { t: "move", from: sq("a2"), to: sq("a7") });
  assert.deepEqual(ann.dropOf({ k: "sq", sq: sq("a2") }, { k: "sq", sq: sq("a1") }), { t: "move", from: sq("a2"), to: sq("a1") }, "rank 1 is not White's last");
  assert.deepEqual(bo.dropOf({ k: "sq", sq: sq("h7") }, { k: "sq", sq: sq("h1") }), { t: "promote", from: sq("h7"), to: sq("h1") });
  assert.equal(ann.isMyPawn(sq("a2")), true);
  assert.equal(ann.isMyPawn(sq("a7")), false, "a black pawn");
  assert.equal(ann.isMyPawn(sq("b1")), false, "a knight");
});

test("a piece dropped on a strip goes to the reserve; a reserve piece of mine goes back on a square, not on a strip", () => {
  const ann = viewOf(ANN, state({ r: "pP" }));
  assert.deepEqual(ann.dropOf({ k: "sq", sq: sq("b1") }, { k: "res", side: "w", j: null }), { t: "stash", from: sq("b1") });
  assert.equal(ann.canHold({ k: "res", i: 0 }), false, "a black pawn in the reserve");
  assert.deepEqual(ann.dropOf({ k: "res", i: 1 }, { k: "sq", sq: sq("e3") }), { t: "place", piece: "P", to: sq("e3") });
  assert.equal(ann.dropOf({ k: "res", i: 1 }, { k: "res", side: "w", j: 0 }), null);
  assert.equal(ann.canHold({ k: "res", i: 5 }), false, "past the reserve");
});

// ---- my action at once, confirmed or undone

test("my move shows at once with its squares tinted, and is announced once", () => {
  const ann = viewOf(ANN);
  const r = ann.act({ t: "move", from: sq("e2"), to: sq("e4") });
  assert.deepEqual(r, { say: "White: pawn e2 to e4" });
  assert.equal(ann.shown.p, e4);
  assert.deepEqual(ann.last, { from: sq("e2"), to: sq("e4") });
  // the server's state confirms it: nothing more is said, and the lost-move timer has nothing to undo
  const back = ann.receive(msg(state({ p: e4, u: true, m: { from: sq("e2"), to: sq("e4") } }), ANN));
  assert.equal(back?.say, null);
  assert.equal(ann.expire(), null);
  assert.equal(ann.shown.p, e4);
});

test("an action the rules refuse is neither shown nor sent", () => {
  const ann = viewOf(ANN), cy = viewOf(CY);
  assert.equal(ann.act({ t: "move", from: sq("e7"), to: sq("e5") }), null);
  assert.equal(ann.act({ t: "place", piece: "Q", to: sq("e3") }), null, "no queen in the reserve");
  assert.equal(cy.act({ t: "move", from: sq("e2"), to: sq("e4") }), null, "a spectator");
  assert.equal(ann.shown.p, START);
  assert.equal(ann.last, null);
});

test("a move lost on the way: the view goes back to the server's position and says so; nobody else saw it", () => {
  const ann = viewOf(ANN, state({ m: { from: sq("g1"), to: sq("f3") } }));
  ann.act({ t: "move", from: sq("d2"), to: sq("d4") });
  assert.equal(ann.shown.p[sq("d4")], "P", "shown at once");
  // no state within CONFIRM_MS: board.ts's timer calls expire
  assert.equal(ann.expire(), "Move not received: the board shows the last position again");
  assert.equal(ann.shown.p, START);
  assert.deepEqual(ann.last, { from: sq("g1"), to: sq("f3") }, "the server's last action is tinted again");
  assert.equal(ann.expire(), null, "said once");
});

test("a refused move comes back as the server's state: the view shows the server's position again", () => {
  const ann = viewOf(ANN, state({ p: e4 }));
  ann.act({ t: "move", from: sq("d2"), to: sq("d4") });
  const r = ann.receive(msg(state({ p: e4 }), ANN)); // the server refused it and sent its position again
  assert.equal(ann.shown.p, e4);
  assert.equal(r?.say, "White: pawn d4 to d2", "the change back is announced like any change of the board");
  assert.equal(ann.expire(), null, "nothing left for the lost-move timer");
});

// ---- states from the page: what is announced

test("somebody else's move, capture, place and undo are announced", () => {
  const ann = viewOf(ANN);
  assert.equal(ann.receive(msg(state({ p: withSquares(["e7", "."], ["e5", "p"]) }), ANN))?.say, "Black: pawn e7 to e5");
  const bo = viewOf(BO, state({ p: e4 }));
  assert.equal(bo.receive(msg(state({ p: START, undone: "b" }), BO))?.say, "Black undid the last move");
  assert.equal(bo.receive(msg(state({ p: START, undone: "b" }), BO))?.say, null, "the same state again says nothing");
  const cy = viewOf(CY, state({ p: e4 }));
  assert.equal(cy.receive(msg(state({ p: withSquares(["e2", "."], ["e4", "."], ["d7", "."]) }), CY))?.say, null, "two squares emptied: not one action");
  assert.equal(cy.receive(msg(state({ r: "", p: START }), CY))?.say, "The board is set up for a new game");
});

test("another board opened in the same view announces nothing, even a position one move away, and drops the tint", () => {
  const cy = viewOf(CY, state({ p: e4, m: { from: sq("e2"), to: sq("e4") } }));
  const other = cy.receive(msg(state({ w: null, b: null }), CY, "14,22"));
  assert.deepEqual(other, { switched: true, turned: false, reserveChanged: false, say: null });
  assert.equal(cy.shown.p, START);
  assert.equal(cy.last, null);
  const back = cy.receive(msg(state({ p: e4 }), CY, "13,22"));
  assert.equal(back?.switched, true);
  assert.equal(back?.say, null, "and back on the first one, nothing either");
  assert.equal(cy.receive(msg(state({ p: e4 }), CY, "13,22"))?.switched, false);
});

test("Black's view is turned; taking or losing the black seat turns it", () => {
  const bo = new BoardSync();
  assert.equal(bo.receive(msg(state({ b: null }), BO))?.turned, false, "watching: White at the bottom");
  assert.equal(bo.mine, null);
  const seated = bo.receive(msg(state(), BO));
  assert.equal(seated?.turned, true);
  assert.equal(bo.flipped, true);
  assert.equal(bo.mine, "b");
  assert.equal(bo.receive(msg(state(), BO))?.turned, false);
  assert.equal(bo.receive(msg(state({ w: null, b: null }), BO))?.turned, true, "a reset frees the seat");
  assert.equal(bo.flipped, false);
});

test("a change of the reserve is reported (a reserve piece held by its index is let go)", () => {
  const ann = viewOf(ANN, state({ r: "pP" }));
  assert.equal(ann.receive(msg(state({ r: "pP", p: e4 }), ANN))?.reserveChanged, false);
  assert.equal(ann.receive(msg(state({ r: "pPn", p: e4 }), ANN))?.reserveChanged, true);
});

test("what is not a board state is ignored; a bad highlight is dropped", () => {
  const v = viewOf(ANN);
  for (const bad of [null, 7, "x", {}, { s: null, me: 1, id: "1,1" }, { s: { p: "x", r: "" }, me: 1, id: "1,1" }, { s: { p: START, r: "p".repeat(31) }, me: 1, id: "1,1" }, { s: state(), me: 1 }]) {
    assert.equal(v.receive(bad), null, JSON.stringify(bad));
  }
  assert.equal(v.shown.p, START);
  for (const m of [{ from: 64 }, { to: -1 }, { from: 1.5 }, 7]) {
    v.receive(msg(state({ m: m as never }), ANN));
    assert.equal(v.last, null, JSON.stringify(m));
  }
  v.receive(msg(state({ m: { to: 20 } }), ANN));
  assert.deepEqual(v.last, { from: undefined, to: 20 });
});

// ---- the window's buttons

test("seats: a spectator sees both taken seats named and disabled; a seated player cannot change side", () => {
  const s = state();
  assert.deepEqual(seatButton(s, "w", CY), { label: "White: Ann", pressed: false, disabled: true, free: false });
  assert.deepEqual(seatButton(s, "b", CY), { label: "Black: Bo", pressed: false, disabled: true, free: false });
  assert.deepEqual(seatButton(s, "w", ANN), { label: "White: Ann", pressed: true, disabled: true, free: false });
  const half = state({ b: null });
  assert.deepEqual(seatButton(half, "b", ANN), { label: "Black", pressed: false, disabled: true, free: true }, "Ann holds White");
  assert.deepEqual(seatButton(half, "b", CY), { label: "Black", pressed: false, disabled: false, free: true }, "free for a spectator");
  assert.equal(seatButton(state({ b: { id: BO, name: "Bo", here: false } }), "b", ANN).label, "Black: Bo (away)");
  const long = seatButton(state({ w: { id: ANN, name: "A".repeat(30), here: false } }), "w", CY).label;
  assert.equal(long, "White: " + "A".repeat(23) + "… (away)");
  assert.ok(long.length <= 40);
});

test("the holders' line names both seats, here or away, or free", () => {
  assert.equal(holders(state()), "White: Ann (here) · Black: Bo (here)");
  assert.equal(holders(state({ b: { id: BO, name: "Bo", here: false } })), "White: Ann (here) · Black: Bo (away)");
  assert.equal(holders(state({ w: null, b: null })), "White: free · Black: free");
});

test("Undo: for either seated player once there is a last action, never for a spectator", () => {
  assert.equal(undoAllowed(state({ u: true }), ANN), true);
  assert.equal(undoAllowed(state({ u: true }), BO), true, "the other player undoes it too");
  assert.equal(undoAllowed(state({ u: true }), CY), false);
  assert.equal(undoAllowed(state({ u: false }), ANN), false, "nothing to undo (after an undo: one level)");
});

test("Reset: a present seated player, or anybody once neither seated player is here", () => {
  assert.equal(resetAllowed(state(), ANN), true);
  assert.equal(resetAllowed(state(), CY), false, "the spectator while Ann and Bo are here");
  assert.equal(resetAllowed(state({ b: { id: BO, name: "Bo", here: false } }), CY), false, "Ann still here");
  assert.equal(resetAllowed(state({ w: { id: ANN, name: "Ann", here: false }, b: { id: BO, name: "Bo", here: false } }), CY), true);
  assert.equal(resetAllowed(state({ w: null, b: null }), CY), true, "free seats");
  assert.equal(resetAllowed(state({ w: { id: ANN, name: "Ann", here: false } }), BO), true, "Bo, seated, here (his window is open)");
});
