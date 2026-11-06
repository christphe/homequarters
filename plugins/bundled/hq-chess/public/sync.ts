// hq-chess's board view without its canvas: the position it shows (the server's, or my last action until the
// server confirms it), what its live region says when a state comes, which pieces I may pick up and what a
// drop sends. Pure: no DOM, no hqView, no timer. public/board.ts draws it and owns the pointer, the keyboard
// and the confirmation timer; web/test/chessView.test.ts tests it.
import { START, changeBetween, move, place, seatOf, sideOf, toReserve, type Board, type Last, type Position, type Side } from "./game.ts";
import type { ViewIn, ViewOut } from "./messages.ts";

// Where a piece is picked up from: a square, or index i of the reserve string.
export type Src = { k: "sq"; sq: number } | { k: "res"; i: number };
// Where the pointer or the cursor is: a square, or a strip (j: its cell, null past its last piece).
export type Spot = { k: "sq"; sq: number } | { k: "res"; side: Side; j: number | null };
/** A pawn of mine dropped on its last rank: the view asks which piece it becomes before it sends the move. */
export interface Promote { t: "promote"; from: number; to: number }
/** What a state from the page changed for the view. */
export interface Received {
  switched: boolean; // another board in the same view: nothing held or chosen carries over
  turned: boolean; // the board turned round (I took Black, or left it): the cursor goes back to my side
  reserveChanged: boolean; // a reserve piece held by its index must be let go
  say: string | null; // somebody else's action, or an undo, for the live region
}

export const CONFIRM_MS = 1000; // an action lost on the way (a budget, a full queue) is undone after this

const sideName = (s: Side) => (s === "w" ? "White" : "Black");
const validPos = (s: { p?: unknown; r?: unknown }) =>
  typeof s.p === "string" && s.p.length === 64 && typeof s.r === "string" && s.r.length <= 30;
const squareOrNone = (v: unknown) => v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 63);
const lastOf = (m: unknown): Last | null => {
  if (typeof m !== "object" || m === null) return null;
  const { from, to } = m as Last;
  return squareOrNone(from) && squareOrNone(to) ? { from, to } : null;
};

export class BoardSync {
  boardId = ""; // which board the window shows: the same view is reused for another one
  synced = false; // a first state of this board came: later changes are announced
  shown: Position = { p: START, r: "" }; // what the canvas draws: the server's position, or mine until it confirms it
  server: Position = { p: START, r: "" }; // the last position the server sent
  last: Last | null = null; // the squares tinted: the last action, the server's or my own until it confirms it
  serverLast: Last | null = null;
  me = 0;
  mine: Side | null = null;
  flipped = false; // Black's view is turned round

  /** A message from the page; null when it is not a board state (ignored). */
  receive(m: unknown): Received | null {
    const v = m as ViewIn | null;
    if (!v || typeof v !== "object" || !v.s || !validPos(v.s) || typeof v.id !== "string") return null;
    const switched = v.id !== this.boardId;
    if (switched) {
      this.boardId = v.id;
      this.synced = false;
      this.last = this.serverLast = null;
    }
    const before = this.shown;
    const s = v.s;
    this.me = v.me;
    const side = seatOf({ p: s.p, w: s.w, b: s.b, r: s.r }, v.me);
    const turned = this.flipped !== (side === "b");
    this.mine = side;
    this.flipped = side === "b";
    this.shown = this.server = { p: s.p, r: s.r };
    this.last = this.serverLast = lastOf(s.m);
    // somebody else's action (mine was said when I made it, and the server's copy matches what I show), or an undo
    const moved = before.p !== this.shown.p || before.r !== this.shown.r;
    let say: string | null = null;
    if (this.synced && moved && (s.undone === "w" || s.undone === "b")) say = `${sideName(s.undone)} undid the last move`;
    else if (this.synced) say = changeBetween(before, this.shown);
    this.synced = true;
    return { switched, turned, reserveChanged: before.r !== this.shown.r, say };
  }

  pieceOf(src: Src): string {
    return src.k === "sq" ? this.shown.p[src.sq] : (this.shown.r[src.i] ?? ".");
  }

  /** Only a seated player picks up, and only a piece of their own colour. */
  canHold(src: Src): boolean {
    return this.mine !== null && sideOf(this.pieceOf(src)) === this.mine;
  }

  /** A pawn of mine stands there (a promotion waiting for its choice is still possible). */
  isMyPawn(sq: number): boolean {
    return this.shown.p[sq].toLowerCase() === "p" && sideOf(this.shown.p[sq]) === this.mine;
  }

  /**
   * What dropping a held piece on a spot does: the message to send, the promotion choice, or null (outside
   * the canvas, a piece not mine, back where it was, or a reserve piece dropped on a strip).
   */
  dropOf(src: Src, to: Spot | null): ViewOut | Promote | null {
    if (!to || !this.canHold(src)) return null;
    if (src.k === "sq" && to.k === "sq") {
      if (to.sq === src.sq) return null;
      const lastRank = this.mine === "w" ? to.sq < 8 : to.sq >= 56;
      if (this.pieceOf(src).toLowerCase() === "p" && lastRank) return { t: "promote", from: src.sq, to: to.sq };
      return { t: "move", from: src.sq, to: to.sq };
    }
    if (src.k === "sq" && to.k === "res") return { t: "stash", from: src.sq };
    if (src.k === "res" && to.k === "sq") return { t: "place", piece: this.pieceOf(src), to: to.sq };
    return null;
  }

  /**
   * Plays my action on the view at once, before the server confirms it. null when the rules refuse it (nothing
   * is sent); otherwise what the live region says of it.
   */
  act(out: ViewOut): { say: string | null } | null {
    if (this.mine === null) return null;
    const b: Board = { p: this.shown.p, r: this.shown.r, w: null, b: null };
    b[this.mine] = { id: this.me, name: "" };
    const ok =
      out.t === "move" ? move(b, this.me, out.from, out.to, out.promote) : out.t === "place" ? place(b, this.me, out.piece, out.to) : toReserve(b, this.me, out.from);
    if (!ok) return null;
    const before = this.shown;
    this.shown = { p: b.p, r: b.r };
    this.last = b.m ?? null;
    return { say: changeBetween(before, this.shown) };
  }

  /**
   * No state came within CONFIRM_MS of my action: it was lost on the way, the view goes back to the server's
   * position. What the live region says, or null when the view already shows the server's position.
   */
  expire(): string | null {
    if (this.shown.p === this.server.p && this.shown.r === this.server.r) return null;
    this.shown = this.server;
    this.last = this.serverLast;
    return "Move not received: the board shows the last position again";
  }
}
