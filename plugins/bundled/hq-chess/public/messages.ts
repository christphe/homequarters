// Messages between hq-chess's server code, its page code and its board view. Types only, plus small constants.
import type { Seat, Side } from "./game";

export type { Seat, Side };

export type ToServer =
  | { t: "hello" }
  | { t: "seat"; x: number; y: number; side: Side }
  | { t: "move"; x: number; y: number; from: number; to: number; promote?: Promotion }
  | { t: "place"; x: number; y: number; piece: string; to: number }
  | { t: "stash"; x: number; y: number; from: number }
  | { t: "reset"; x: number; y: number }
  | { t: "close"; x: number; y: number }
  | { t: "opened"; x: number; y: number }; // the window of an open was drawn

export type SeatState = Seat & { here: boolean };
// r: the reserve (captured pieces, in capture order); at most 30 letters, so a state stays far under 4 KB.
export interface BoardState { p: string; w: SeatState | null; b: SeatState | null; r: string }

export type ToClient =
  | { t: "open" | "state"; x: number; y: number; s: BoardState }
  | { t: "playing"; list: { id: number; side: Side }[] };

export type Promotion = "q" | "r" | "b" | "n";

// Page to view, and view to page. id names the board ("x,y"): the same view shows another board when it changes.
export interface ViewIn { s: BoardState; me: number; id: string }
export type ViewOut =
  | { t: "move"; from: number; to: number; promote?: Promotion }
  | { t: "place"; piece: string; to: number }
  | { t: "stash"; from: number };
