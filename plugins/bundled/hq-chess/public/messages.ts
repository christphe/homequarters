// Messages between hq-chess's server code, its page code and its board view. Types only, plus small constants.
import type { Seat, Side } from "./game";

export type { Seat, Side };

export type ToServer =
  | { t: "hello" }
  | { t: "seat"; x: number; y: number; side: Side }
  | { t: "move"; x: number; y: number; from: number; to: number }
  | { t: "reset"; x: number; y: number }
  | { t: "close"; x: number; y: number };

export type SeatState = Seat & { here: boolean };
export interface BoardState { p: string; w: SeatState | null; b: SeatState | null }

export type ToClient =
  | { t: "open" | "state"; x: number; y: number; s: BoardState }
  | { t: "playing"; list: { id: number; side: Side }[] };

// Page to view, and view to page.
export interface ViewIn { s: BoardState; me: number }
export type ViewOut = { t: "move"; from: number; to: number };
