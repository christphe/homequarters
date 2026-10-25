// Where things are in hq-cards's table view, in view pixels (the view scales the whole by a whole number):
// the felt in the middle, the other seats around it (clockwise from my left: the left side going up, the
// top going right, the right side going down), my hand fanned in a strip under it. Positions on the felt
// are a card's centre, in felt units, the same for everybody. Pure: the view and the tests share it.
import { CARD_H, CARD_W } from "./art.ts";
import { FELT_H, FELT_W } from "./games.ts";
import { UP, type Table } from "./table.ts";

export { FELT_H, FELT_W };
export const SIDE = 64; // the width of the left and right columns of seats
export const TOP = 36; // the height of the band of seats above the felt
export const HAND = 44; // the height of my hand's strip under the felt
export const FX = SIDE;
export const FY = TOP;
export const VIEW_W = SIDE + FELT_W + SIDE;
export const VIEW_H = TOP + FELT_H + HAND;
export const SEAT_W = 60;
export const SEAT_H = 32;

export interface SeatSpot { seat: number; x: number; y: number; side: "top" | "left" | "right" }
export type Spot = { k: "hand"; i: number } | { k: "loose"; c: number } | { k: "pile"; id: string } | { k: "seat"; seat: number } | { k: "felt"; at: [number, number] };

/** The other seats (all of them but mine), each at the centre of its spot. */
export function seatSpots(seats: number, me: number | null): SeatSpot[] {
  const others: number[] = [];
  for (let k = 1; k <= seats; k++) {
    const s = me === null ? k - 1 : (me + k) % seats;
    if (s !== me) others.push(s);
  }
  const n = others.length;
  const L = n >= 3 ? Math.floor(n / 3) : 0, R = L, T = n - L - R;
  return others.map((seat, i) => {
    if (i < L) return { seat, side: "left", x: SIDE / 2, y: FY + FELT_H - ((i + 0.5) * FELT_H) / L };
    if (i < L + T) return { seat, side: "top", x: FX + ((i - L + 0.5) * FELT_W) / T, y: TOP / 2 };
    return { seat, side: "right", x: FX + FELT_W + SIDE / 2, y: FY + ((i - L - T + 0.5) * FELT_H) / R };
  });
}

/** The top-left corner of a card whose centre is at felt position at. */
export function cardAt(at: [number, number]): { x: number; y: number } {
  return { x: FX + at[0] - CARD_W / 2, y: FY + at[1] - CARD_H / 2 };
}

/** The top-left corners of the n cards of my hand, fanned and centred in the strip. */
export function handSpots(n: number): { x: number; y: number }[] {
  if (!n) return [];
  const step = n > 1 ? Math.min(CARD_W + 2, Math.floor((FELT_W - CARD_W) / (n - 1))) : 0;
  const x0 = FX + Math.floor((FELT_W - (step * (n - 1) + CARD_W)) / 2);
  return Array.from({ length: n }, (_, i) => ({ x: x0 + i * step, y: FY + FELT_H + Math.floor((HAND - CARD_H) / 2) }));
}

const inside = (x: number, y: number, x0: number, y0: number, w: number, h: number) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;

/** The topmost thing under view pixel (x, y): a card of my hand, a loose card, a pile, a seat, or the felt. me: my seat. */
export function hit(t: Table, me: number | null, x: number, y: number): Spot | null {
  if (me !== null) {
    const h = handSpots(t.hands[me]?.length ?? 0);
    for (let i = h.length - 1; i >= 0; i--) if (inside(x, y, h[i].x, h[i].y, CARD_W, CARD_H)) return { k: "hand", i };
  }
  for (let i = t.loose.length - 1; i >= 0; i--) {
    const c = cardAt(t.loose[i].at);
    if (inside(x, y, c.x, c.y, CARD_W, CARD_H)) return { k: "loose", c: t.loose[i].c & ~UP };
  }
  for (let i = t.piles.length - 1; i >= 0; i--) {
    const c = cardAt(t.piles[i].at);
    if (inside(x, y, c.x, c.y, CARD_W, CARD_H)) return { k: "pile", id: t.piles[i].id };
  }
  for (const s of seatSpots(t.seats.length, me)) if (inside(x, y, s.x - SEAT_W / 2, s.y - SEAT_H / 2, SEAT_W, SEAT_H)) return { k: "seat", seat: s.seat };
  if (inside(x, y, FX, FY, FELT_W + 1, FELT_H + 1)) return { k: "felt", at: [Math.round(x - FX), Math.round(y - FY)] };
  return null;
}
