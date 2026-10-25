// Where things are in hq-cards's table view, in view pixels (the view scales the whole to fit its window).
// Two layouts. WIDE: the felt in the middle, the other seats around it (clockwise from my left: the left
// side going up, the top going right, the right side going down), my hand fanned in a strip under it.
// NARROW, for phones, where WIDE would be drawn under 1x: no side columns, the other seats in rows above
// the felt, and my hand drawn larger (it is what a finger touches most). The felt itself is the same in
// both: positions on it are a card's centre, in felt units, the same for everybody. Pure: the view and the
// tests share it.
import { CARD_H, CARD_W } from "./art.ts";
import { FELT_H, FELT_W } from "./games.ts";
import { UP, type Table } from "./table.ts";

export { FELT_H, FELT_W };

export interface Layout {
  narrow: boolean;
  fx: number; // the felt's top-left corner
  fy: number;
  w: number; // the whole view
  h: number;
  seatW: number; // a seat's spot (name, card backs, count)
  seatH: number;
  hand: number; // the height of my hand's strip under the felt
  handK: number; // my hand's cards drawn this much larger
  font: number; // canvas text, in view pixels
}

const SIDE = 48; // WIDE: the width of the left and right columns of seats (416 px in all: 1.5x fits a large window)
const TOP = 36; // WIDE: the band of seats above the felt
export const WIDE: Layout = { narrow: false, fx: SIDE, fy: TOP, w: SIDE + FELT_W + SIDE, h: TOP + FELT_H + 44, seatW: 46, seatH: 32, hand: 44, handK: 1, font: 7 };
const ROWS_TOP = 64; // NARROW: two rows of seats above the felt
const NARROW_HAND = 58;
export const NARROW: Layout = { narrow: true, fx: 0, fy: ROWS_TOP, w: FELT_W, h: ROWS_TOP + FELT_H + NARROW_HAND, seatW: 78, seatH: 30, hand: NARROW_HAND, handK: 1.4, font: 9 };
const PER_ROW = 4; // NARROW: seats in a row

/** The layout for a view this wide (CSS px): NARROW when WIDE would not fit at 1x. */
export function layoutFor(width: number): Layout {
  return width >= WIDE.w ? WIDE : NARROW;
}

// WIDE's values, for code written against one layout (the browser checks)
export const FX = WIDE.fx;
export const FY = WIDE.fy;
export const VIEW_W = WIDE.w;
export const VIEW_H = WIDE.h;
export const SEAT_W = WIDE.seatW;
export const SEAT_H = WIDE.seatH;

export interface SeatSpot { seat: number; x: number; y: number; side: "top" | "left" | "right" }
export type Spot = { k: "hand"; i: number } | { k: "loose"; c: number } | { k: "pile"; id: string } | { k: "seat"; seat: number } | { k: "felt"; at: [number, number] };

/** The other seats (all of them but mine), each at the centre of its spot. */
export function seatSpots(seats: number, me: number | null, L: Layout = WIDE): SeatSpot[] {
  const others: number[] = [];
  for (let k = 1; k <= seats; k++) {
    const s = me === null ? k - 1 : (me + k) % seats;
    if (s !== me) others.push(s);
  }
  const n = others.length;
  if (L.narrow) {
    return others.map((seat, i) => {
      const row = Math.floor(i / PER_ROW), inRow = Math.min(PER_ROW, n - row * PER_ROW), j = i % PER_ROW;
      return { seat, side: "top", x: ((j + 0.5) * L.w) / inRow, y: L.seatH / 2 + 2 + row * (L.seatH + 2) };
    });
  }
  const left = n >= 3 ? Math.floor(n / 3) : 0, right = left, top = n - left - right;
  return others.map((seat, i) => {
    if (i < left) return { seat, side: "left", x: L.fx / 2, y: L.fy + FELT_H - ((i + 0.5) * FELT_H) / left };
    if (i < left + top) return { seat, side: "top", x: L.fx + ((i - left + 0.5) * FELT_W) / top, y: L.fy / 2 };
    return { seat, side: "right", x: L.fx + FELT_W + (L.w - L.fx - FELT_W) / 2, y: L.fy + ((i - left - top + 0.5) * FELT_H) / right };
  });
}

/** The top-left corner of a card whose centre is at felt position at. */
export function cardAt(at: [number, number], L: Layout = WIDE): { x: number; y: number } {
  return { x: L.fx + at[0] - CARD_W / 2, y: L.fy + at[1] - CARD_H / 2 };
}

/** The top-left corners of the n cards of my hand, fanned and centred in the strip (cards L.handK larger). */
export function handSpots(n: number, L: Layout = WIDE): { x: number; y: number }[] {
  if (!n) return [];
  const w = CARD_W * L.handK, h = CARD_H * L.handK;
  const step = n > 1 ? Math.min(w + 2, Math.floor((FELT_W - w) / (n - 1))) : 0;
  const x0 = L.fx + Math.floor((FELT_W - (step * (n - 1) + w)) / 2);
  return Array.from({ length: n }, (_, i) => ({ x: x0 + i * step, y: L.fy + FELT_H + Math.floor((L.hand - h) / 2) }));
}

const inside = (x: number, y: number, x0: number, y0: number, w: number, h: number) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;

// ---- snapping (a setting of the table) and groups of loose cards

/** The grid's step on the felt: a card and a gap; a row also leaves room for a pile's name under its card and
 * for the handle above the card of the next row. Card centres sit at GRID/2 + k * GRID. */
export const GRID: [number, number] = [24, 44];
/** How much lower a card dropped on another's lower half lands: the index (rank and suit) above it shows. */
export const CASCADE = 13;
const clampX = (x: number) => Math.max(CARD_W / 2, Math.min(FELT_W - CARD_W / 2, x));
const clampY = (y: number) => Math.max(CARD_H / 2, Math.min(FELT_H - CARD_H / 2, y));

function gridAt(v: number, step: number, max: number): number {
  const half = step / 2;
  let k = Math.round((v - half) / step);
  while (k > 0 && half + k * step > max) k--;
  return half + Math.max(0, k) * step;
}

/**
 * Where a card dropped with its centre at `at` lands. Off: there (on the felt). On: over a loose card not
 * being moved (the topmost), on its lower half CASCADE lower, on its upper half exactly on it; elsewhere
 * on the nearest grid point whose card stays on the felt.
 */
export function snapAt(t: Table, at: [number, number], moving: number[], on: boolean): [number, number] {
  if (!on) return [clampX(Math.round(at[0])), clampY(Math.round(at[1]))];
  for (let i = t.loose.length - 1; i >= 0; i--) {
    const l = t.loose[i];
    if (moving.includes(l.c & ~UP)) continue;
    const dx = at[0] - l.at[0], dy = at[1] - l.at[1];
    if (Math.abs(dx) < CARD_W / 2 && Math.abs(dy) < CARD_H / 2) return dy > 0 ? [l.at[0], clampY(l.at[1] + CASCADE)] : [l.at[0], l.at[1]];
  }
  return [gridAt(at[0], GRID[0], FELT_W - CARD_W / 2), gridAt(at[1], GRID[1], FELT_H - CARD_H / 2)];
}

const overlap = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < CARD_W && Math.abs(a[1] - b[1]) < CARD_H;

/** Card c and the loose cards put after it that overlap it or one of them (a stack or cascade above c), in order. */
export function groupFrom(t: Table, c: number): number[] {
  const i = t.loose.findIndex((l) => (l.c & ~UP) === c);
  if (i < 0) return [];
  const chain = [t.loose[i]];
  for (let j = i + 1; j < t.loose.length; j++) if (chain.some((x) => overlap(x.at, t.loose[j].at))) chain.push(t.loose[j]);
  return chain.map((l) => l.c & ~UP);
}

/** The bottom card of every group of two cards or more (where its handle goes): it overlaps no card put before it. */
export function groups(t: Table): { c: number; at: [number, number]; size: number }[] {
  const out: { c: number; at: [number, number]; size: number }[] = [];
  t.loose.forEach((l, i) => {
    if (t.loose.slice(0, i).some((x) => overlap(x.at, l.at))) return;
    const size = groupFrom(t, l.c & ~UP).length;
    if (size > 1) out.push({ c: l.c & ~UP, at: l.at, size });
  });
  return out;
}

/** The topmost thing under view pixel (x, y): a card of my hand, a loose card, a pile, a seat, or the felt. me: my seat. */
export function hit(t: Table, me: number | null, x: number, y: number, L: Layout = WIDE): Spot | null {
  if (me !== null) {
    const h = handSpots(t.hands[me]?.length ?? 0, L);
    for (let i = h.length - 1; i >= 0; i--) if (inside(x, y, h[i].x, h[i].y, CARD_W * L.handK, CARD_H * L.handK)) return { k: "hand", i };
  }
  for (let i = t.loose.length - 1; i >= 0; i--) {
    const c = cardAt(t.loose[i].at, L);
    if (inside(x, y, c.x, c.y, CARD_W, CARD_H)) return { k: "loose", c: t.loose[i].c & ~UP };
  }
  for (let i = t.piles.length - 1; i >= 0; i--) {
    const c = cardAt(t.piles[i].at, L);
    if (inside(x, y, c.x, c.y, CARD_W, CARD_H)) return { k: "pile", id: t.piles[i].id };
  }
  for (const s of seatSpots(t.seats.length, me, L)) if (inside(x, y, s.x - L.seatW / 2, s.y - L.seatH / 2, L.seatW, L.seatH)) return { k: "seat", seat: s.seat };
  if (inside(x, y, L.fx, L.fy, FELT_W + 1, FELT_H + 1)) return { k: "felt", at: [Math.round(x - L.fx), Math.round(y - L.fy)] };
  return null;
}
