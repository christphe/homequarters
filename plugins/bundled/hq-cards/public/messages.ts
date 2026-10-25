// Messages between hq-cards's server code, its page code and its table view. Types only, plus small constants.
import type { ClientGame } from "./games.ts";
import type { LogEntry } from "./log.ts";
import type { Dest, Src, Table } from "./table.ts";

export type { ClientGame, Dest, LogEntry, Src, Table };

/** x, y: the deck's tile, which names the table. */
type At = { x: number; y: number };

/** What a player does at a table (the view's messages, without the table's tile). */
export type Act =
  | { t: "choose"; game: string } // a registered game's plugin name, or "free"
  | { t: "seat"; seat: number }
  | { t: "place"; from: Src; to: Dest; up: boolean }
  | { t: "flip"; from: Src }
  | { t: "order"; hand: number[] }
  | { t: "offer"; to: number | null }
  | { t: "pick"; i: number }
  | { t: "dealAll"; pile: string }
  | { t: "deal"; pile: string; n: number }
  | { t: "shuffle"; pile: string }
  | { t: "gather" | "count" | "reset" | "unlook" }
  | { t: "newPile"; name: string; face: "up" | "down"; at: [number, number] }
  | { t: "delPile" | "look" | "draw"; pile: string }
  | { t: "reorder"; pile: string; cards: number[] };

export type ToServer = { t: "hello" } | (At & { t: "close" }) | (At & Act);

export interface Looking { seat: number; pile: string }
/** here: the ids of the seated members who have the table open; unavailable: its game is not running. */
export interface TableState { t: Table; here: number[]; looking: Looking[]; unavailable: boolean }

export type ToClient =
  | (At & { t: "open" | "state"; s: TableState })
  | (At & { t: "games"; list: { name: string; title: string }[] }) // the choice, while no game is chosen
  | (At & { t: "game"; g: ClientGame })
  | (At & { t: "log"; log: LogEntry[] });

/** Page to view: each in its own message (a view message holds 4096 bytes). id names the table ("x,y"). */
export type ViewIn =
  | { t: "state"; s: TableState; me: number; id: string }
  | { t: "game"; g: ClientGame | null; id: string }
  | { t: "log"; log: LogEntry[]; id: string };
/** View to page: an act; the page adds the tile. */
export type ViewOut = Act;
