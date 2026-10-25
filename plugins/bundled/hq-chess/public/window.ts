// What the Chess window shows for a board's state, as seen by one member: the seat buttons, whether Undo and
// Reset may be pressed, and the line naming the seat holders. Pure: public/client.ts draws it with hq.ui;
// web/test/chessView.test.ts tests it.
import { canReset, type Board, type Side } from "./game.ts";
import type { BoardState } from "./messages.ts";

export const NAME_MAX = 24; // a seat's label must stay within a button's 40 characters

export interface SeatButton {
  label: string;
  pressed: boolean; // my seat
  disabled: boolean;
  free: boolean; // pressing it takes the seat
}

export const sideName = (s: Side) => (s === "w" ? "White" : "Black");

export function short(name: string): string {
  const c = [...name];
  return c.length > NAME_MAX ? c.slice(0, NAME_MAX - 1).join("") + "…" : name;
}

/** My side on this board, or null when I only watch. */
export const mySide = (s: BoardState, me: number): Side | null => (s.w?.id === me ? "w" : s.b?.id === me ? "b" : null);

/** A seat's button: taken, it names its holder and is never pressable (leaving takes a reset); free, only
 * a member without a seat may take it. */
export function seatButton(s: BoardState, side: Side, me: number): SeatButton {
  const seat = s[side];
  if (seat) return { label: `${sideName(side)}: ${short(seat.name)}${seat.here ? "" : " (away)"}`, pressed: seat.id === me, disabled: true, free: false };
  return { label: sideName(side), pressed: false, disabled: mySide(s, me) !== null, free: true };
}

/** Who holds each seat, as a line of text: disabled seat buttons are out of the Tab order, this line is not. */
export function holders(s: BoardState): string {
  const one = (side: Side) => {
    const seat = s[side];
    return `${sideName(side)}: ${seat ? `${short(seat.name)} (${seat.here ? "here" : "away"})` : "free"}`;
  };
  return `${one("w")} · ${one("b")}`;
}

/** Undo: the last action, whoever made it, for a seated player (my window is open, so I am present). */
export const undoAllowed = (s: BoardState, me: number): boolean => s.u && mySide(s, me) !== null;

/** Reset, by the rule of public/game.ts: who has the board open is the seated players marked here, and me. */
export function resetAllowed(s: BoardState, me: number): boolean {
  const board: Board = { p: s.p, w: s.w, b: s.b, r: s.r };
  const present = new Set<number>([me]);
  for (const seat of [s.w, s.b]) if (seat?.here) present.add(seat.id);
  return canReset(board, me, present);
}
