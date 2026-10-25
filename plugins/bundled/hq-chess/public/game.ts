// Chess board, seats and reset rules. Pure: no `hq`, no DOM. Shared by the plugin's server and browser code.
// Erasable TypeScript only (no enums, namespaces or parameter properties).

export type Side = "w" | "b";
export interface Seat { id: number; name: string }
// p: 64 characters, index 0 = a8 ... 63 = h1; "KQRBNP" white, "kqrbnp" black, "." empty.
export interface Board { p: string; w: Seat | null; b: Seat | null }

export const START = "rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR";

export function newBoard(): Board {
  return { p: START, w: null, b: null };
}

function parseSeat(v: unknown): Seat | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object" || v === undefined) return undefined;
  const s = v as Record<string, unknown>;
  if (typeof s.id !== "number" || !Number.isInteger(s.id) || typeof s.name !== "string") return undefined;
  return { id: s.id, name: s.name };
}

// Anything invalid gives a fresh board.
export function parseBoard(s: string | null): Board {
  if (s === null) return newBoard();
  try {
    const o = JSON.parse(s) as Record<string, unknown> | null;
    if (typeof o !== "object" || o === null) return newBoard();
    if (typeof o.p !== "string" || !/^[KQRBNPkqrbnp.]{64}$/.test(o.p)) return newBoard();
    const w = parseSeat(o.w);
    const b = parseSeat(o.b);
    if (w === undefined || b === undefined) return newBoard();
    return { p: o.p, w, b };
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

// Only the seated player's own pieces move; no other rule. Whatever stood on `to` is removed.
export function move(b: Board, who: number, from: number, to: number): boolean {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 63 || to < 0 || to > 63 || from === to) return false;
  const side = seatOf(b, who);
  if (side === null) return false;
  const piece = b.p[from];
  if (sideOf(piece) !== side) return false;
  const a = b.p.split("");
  a[to] = piece;
  a[from] = ".";
  b.p = a.join("");
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
  b.w = null;
  b.b = null;
}

// 0 = a8, 52 = e2, 63 = h1.
export function squareName(i: number): string {
  return "abcdefgh"[i % 8] + String(8 - Math.floor(i / 8));
}
