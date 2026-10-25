// Messages between hq-chess's server code, its page code and its board view. Types only, plus small constants.
import type { Last, Seat, Side } from "./game";

export type { Last, Seat, Side };

export type ToServer =
  | { t: "hello" }
  | { t: "seat"; x: number; y: number; side: Side }
  | { t: "move"; x: number; y: number; from: number; to: number; promote?: Promotion }
  | { t: "place"; x: number; y: number; piece: string; to: number }
  | { t: "stash"; x: number; y: number; from: number }
  | { t: "reset"; x: number; y: number }
  | { t: "undo"; x: number; y: number } // the last action, by a present seated player
  | { t: "close"; x: number; y: number }
  | { t: "opened"; x: number; y: number }; // the window of an open was drawn

export type SeatState = Seat & { here: boolean };
// r: the reserve (captured pieces, in capture order); at most 30 letters, so a state stays far under 4 KB.
// u: an undo is available; m: the last action's squares (the highlight), null when none;
// undone: the side whose player undid the last action, until the next action (the view announces it).
export interface BoardState { p: string; w: SeatState | null; b: SeatState | null; r: string; u: boolean; m: Last | null; undone: Side | null }

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
