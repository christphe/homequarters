// Chess board, seats, reserve and reset rules. Pure: no `hq`, no DOM. Shared by the plugin's server and browser code.
// Erasable TypeScript only (no enums, namespaces or parameter properties).

export type Side = "w" | "b";
export interface Seat { id: number; name: string }
// p: 64 characters, index 0 = a8 ... 63 = h1; "KQRBNP" white, "kqrbnp" black, "." empty.
// r: the reserve, the pieces taken off the board in the order they left it, at most RESERVE_MAX.
// u: the position before the last action (what an undo puts back), m: that action's squares (the highlight);
// both null when there is nothing to undo (a new board, after an undo or a reset, a board saved before them).
export interface Board { p: string; w: Seat | null; b: Seat | null; r: string; u?: Position | null; m?: Last | null }
/** A position as the view shows it: the squares and the reserve. */
export interface Position { p: string; r: string }
/** The squares of the last action: a move has both, a place from the reserve only `to`, a stash only `from`. */
export interface Last { from?: number; to?: number }

export const START = "rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR";

export const RESERVE_MAX = 30; // 32 pieces, two kings never taken in a real game; the bound holds anyway
export const PROMOTIONS = ["q", "r", "b", "n"] as const;

export const PIECE_NAMES: Record<string, string> = { p: "pawn", r: "rook", n: "knight", b: "bishop", q: "queen", k: "king" };

const isSquare = (v: number) => Number.isInteger(v) && v >= 0 && v <= 63;

export function newBoard(): Board {
  return { p: START, w: null, b: null, r: "", u: null, m: null };
}

function parseSeat(v: unknown): Seat | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object" || v === undefined) return undefined;
  const s = v as Record<string, unknown>;
  if (typeof s.id !== "number" || !Number.isInteger(s.id) || typeof s.name !== "string") return undefined;
  return { id: s.id, name: s.name };
}

const validP = (v: unknown): v is string => typeof v === "string" && /^[KQRBNPkqrbnp.]{64}$/.test(v);
const validR = (v: unknown): v is string => typeof v === "string" && v.length <= RESERVE_MAX && /^[KQRBNPkqrbnp]*$/.test(v);

function parseLast(v: unknown): Last | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const out: Last = {};
  for (const k of ["from", "to"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "number" || !isSquare(o[k] as number)) return null;
    out[k] = o[k] as number;
  }
  return out.from === undefined && out.to === undefined ? null : out;
}

// Anything invalid gives a fresh board; an invalid undo (u or m) only drops the undo and the highlight.
export function parseBoard(s: string | null): Board {
  if (s === null) return newBoard();
  try {
    const o = JSON.parse(s) as Record<string, unknown> | null;
    if (typeof o !== "object" || o === null) return newBoard();
    if (!validP(o.p)) return newBoard();
    const w = parseSeat(o.w);
    const b = parseSeat(o.b);
    if (w === undefined || b === undefined) return newBoard();
    const r = o.r === undefined ? "" : o.r;
    if (!validR(r)) return newBoard();
    const u = o.u as Record<string, unknown> | null | undefined;
    const before = typeof u === "object" && u !== null && validP(u.p) && validR(u.r) ? { p: u.p, r: u.r } : null;
    const m = before ? parseLast(o.m) : null;
    return before && m ? { p: o.p, w, b, r, u: before, m } : { p: o.p, w, b, r, u: null, m: null };
  } catch {
    return newBoard();
  }
}

export function sideOf(piece: string): Side | null {
  if (piece.length !== 1 || !"KQRBNP".concat("kqrbnp").includes(piece)) return null;
  return piece === piece.toUpperCase() ? "w" : "b";
}

export function seatOf(b: Board, id: number): Side | null {
  if (b.w !== null && b.w.id === id) return "w";
  if (b.b !== null && b.b.id === id) return "b";
  return null;
}

// A free seat, for a member who holds no seat on this board.
export function take(b: Board, side: Side, who: Seat): boolean {
  if (b[side] !== null || seatOf(b, who.id) !== null) return false;
  b[side] = { id: who.id, name: who.name };
  return true;
}

/** Adds a piece taken off the board to the reserve; past RESERVE_MAX the oldest one goes. */
function stash(b: Board, piece: string): void {
  if (piece === ".") return;
  b.r = (b.r + piece).slice(-RESERVE_MAX);
}

/** Puts piece on square `at`; whatever stood there goes to the reserve. */
function put(b: Board, at: number, piece: string): void {
  stash(b, b.p[at]);
  b.p = b.p.slice(0, at) + piece + b.p.slice(at + 1);
}

/** Keeps what an undo of the action about to be made needs: the position before it, and its squares. */
function remember(b: Board, last: Last): void {
  b.u = { p: b.p, r: b.r };
  b.m = last;
}

/** The last rank of a side's pawns: rank 8 (squares 0-7) for White, rank 1 (56-63) for Black. */
const lastRank = (side: Side, sq: number) => (side === "w" ? sq < 8 : sq >= 56);

// Only the seated player's own pieces move; no other rule. Whatever stood on `to` goes to the reserve.
// promote ("q", "r", "b" or "n"): a pawn of the mover reaching its last rank becomes that piece, whatever
// is already on the board; refused anywhere else. Without it a pawn stays a pawn.
export function move(b: Board, who: number, from: number, to: number, promote?: string): boolean {
  if (!isSquare(from) || !isSquare(to) || from === to) return false;
  const side = seatOf(b, who);
  if (side === null) return false;
  let piece = b.p[from];
  if (sideOf(piece) !== side) return false;
  if (promote !== undefined) {
    if (!(PROMOTIONS as readonly string[]).includes(promote) || piece.toLowerCase() !== "p" || !lastRank(side, to)) return false;
    piece = side === "w" ? promote.toUpperCase() : promote;
  }
  remember(b, { from, to });
  b.p = b.p.slice(0, from) + "." + b.p.slice(from + 1);
  put(b, to, piece);
  return true;
}

// A seated player puts a piece of their colour from the reserve on any square (its latest copy leaves the
// reserve); whatever stood there goes to the reserve.
export function place(b: Board, who: number, piece: string, to: number): boolean {
  if (!isSquare(to) || typeof piece !== "string") return false;
  const side = seatOf(b, who);
  if (side === null || sideOf(piece) !== side) return false;
  const i = b.r.lastIndexOf(piece);
  if (i < 0) return false;
  remember(b, { to });
  b.r = b.r.slice(0, i) + b.r.slice(i + 1);
  put(b, to, piece);
  return true;
}

// A seated player takes one of their pieces off the board into the reserve.
export function toReserve(b: Board, who: number, from: number): boolean {
  if (!isSquare(from)) return false;
  const side = seatOf(b, who);
  if (side === null || sideOf(b.p[from]) !== side) return false;
  remember(b, { from });
  stash(b, b.p[from]);
  b.p = b.p.slice(0, from) + "." + b.p.slice(from + 1);
  return true;
}

// A present seated player, or anybody when neither seated player is present (empty seats count as absent).
export function canReset(b: Board, who: number, present: ReadonlySet<number>): boolean {
  const side = seatOf(b, who);
  if (side !== null && present.has(who)) return true;
  return !(b.w !== null && present.has(b.w.id)) && !(b.b !== null && present.has(b.b.id));
}

export function reset(b: Board): void {
  b.p = START;
  b.r = "";
  b.w = null;
  b.b = null;
  b.u = null;
  b.m = null;
}

// The last action, whoever made it, by a seated player who has the board open; one level: the undo is gone after.
export function canUndo(b: Board, who: number, present: ReadonlySet<number>): boolean {
  return !!b.u && seatOf(b, who) !== null && present.has(who);
}

/** Puts back the position and the reserve before the last action (seats unchanged). */
export function undo(b: Board, who: number, present: ReadonlySet<number>): boolean {
  if (!canUndo(b, who, present)) return false;
  b.p = b.u!.p;
  b.r = b.u!.r;
  b.u = null;
  b.m = null;
  return true;
}

// 0 = a8, 52 = e2, 63 = h1.
export function squareName(i: number): string {
  return "abcdefgh"[i % 8] + String(8 - Math.floor(i / 8));
}

const sideName = (s: Side) => (s === "w" ? "White" : "Black");
const nameOf = (piece: string) => PIECE_NAMES[piece.toLowerCase()];

/** What one action did between two positions, as the view announces it; null when it is not one action. */
export function changeBetween(a: Position, b: Position): string | null {
  if (a.p === b.p && a.r === b.r) return null;
  if (b.p === START && b.r === "") return "The board is set up for a new game";
  const diff: number[] = [];
  for (let i = 0; i < 64; i++) if (a.p[i] !== b.p[i]) diff.push(i);
  if (diff.length === 2) {
    // a move: one square emptied, the other holds the piece that left it (or what a pawn became)
    const [x, y] = diff;
    const [from, to] = b.p[x] === "." ? [x, y] : [y, x];
    const was = a.p[from], now = b.p[to];
    const side = sideOf(was);
    if (b.p[from] !== "." || side === null || sideOf(now) !== side) return null;
    const head = `${sideName(side)}: ${nameOf(was)} ${squareName(from)} to ${squareName(to)}`;
    if (now === was) return head;
    return was.toLowerCase() === "p" ? `${head}, ${nameOf(now)}` : null;
  }
  if (diff.length === 1) {
    const sq = diff[0], now = b.p[sq];
    if (now === ".") {
      const side = sideOf(a.p[sq]);
      return side ? `${sideName(side)}: ${nameOf(a.p[sq])} ${squareName(sq)} to reserve` : null;
    }
    const side = sideOf(now)!;
    return `${sideName(side)}: ${nameOf(now)} from reserve to ${squareName(sq)}`;
  }
  return null;
}
