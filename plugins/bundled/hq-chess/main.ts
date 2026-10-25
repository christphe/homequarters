// Chess plugin, server side. A chessboard is a map object (plugin.json "objects"); pressing X next to one
// opens it (onUse). Two members take White and Black, others watch; pieces go where they are dropped, no
// rules. A taken piece goes to the board's reserve, from which its side may put it back anywhere; a pawn
// on its last rank may be promoted. Each board's position, reserve and players are saved in hq.kv under
// "board:<x>,<y>" (its tile), loaded on first use and written on every change. Who has a board's window
// open (its viewers) lives in memory only: a seated player is "here" while they are a viewer. The rules of
// seats, moves, the reserve and reset are in public/game.ts;
// the browser side is public/client.ts (the window) and public/board.ts (the board view).
//
// Every change is collected and sent in update(), to the board's viewers (state) and to every member on
// their own (the list of present seated players, for the badge over their heads); a send refused by the budget is kept
// for the next update.

import { canReset, move, parseBoard, place, reset, seatOf, take, toReserve, type Board, type Side } from "./public/game";
import type { BoardState, SeatState, ToClient, ToServer } from "./public/messages";

const boards = new Map<string, Board>(); // loaded on first use
const viewers = new Map<string, Set<number>>(); // board key -> members with its window open
const toSend = new Map<number, Set<string>>(); // member -> boards whose state they must be sent
const toOpen = new Map<number, string>(); // member -> the board their window must open on (a refused send)
// member -> the board an open was sent for, until their page confirms it drew the window ("opened"). A page
// whose plugin starts late says hello after the open: the confirmation makes the member a viewer again.
const unconfirmed = new Map<number, string>();
// members who must be sent the playing list (it changed, or they joined): each on their own, so a member
// whose budget is spent never holds it back from the others
const toTell = new Set<number>();
let playing = "[]"; // the current playing list, as JSON
let playingDirty = false; // something changed: the list may differ

const key = (x: number, y: number) => `board:${x},${y}`;
const tile = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 100000;
const square = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 63;

function board(k: string): Board {
  let b = boards.get(k);
  if (!b) {
    b = parseBoard(hq.kv.get(k));
    boards.set(k, b);
  }
  return b;
}

const seen = (k: string) => viewers.get(k) ?? new Set<number>();

function stateOf(k: string): BoardState {
  const b = board(k), here = seen(k);
  const seat = (s: Board["w"]): SeatState | null => (s ? { id: s.id, name: s.name, here: here.has(s.id) } : null);
  return { p: b.p, w: seat(b.w), b: seat(b.b), r: b.r };
}

function coords(k: string): { x: number; y: number } {
  const [x, y] = k.slice(6).split(",").map(Number);
  return { x, y };
}

/** That member must be sent the board's state (in update()). */
function queue(id: number, k: string): void {
  let s = toSend.get(id);
  if (!s) toSend.set(id, (s = new Set()));
  s.add(k);
}

/** The board's viewers must be sent its state, and the playing list may have changed. */
function changed(k: string): void {
  for (const id of seen(k)) queue(id, k);
  playingDirty = true;
}

function save(k: string): void {
  try {
    hq.kv.set(k, JSON.stringify(board(k)));
  } catch {
    hq.log("board not saved: storage full"); // the game goes on in memory
  }
  changed(k);
}

/** A member no longer has the window of that board open (their seat stays). */
function leaveBoard(k: string, id: number): void {
  const v = viewers.get(k);
  if (!v || !v.delete(id)) return;
  if (!v.size) viewers.delete(k);
  toSend.get(id)?.delete(k);
  if (toOpen.get(id) === k) toOpen.delete(id);
  if (seatOf(board(k), id) !== null) changed(k);
}

function leaveAll(id: number): void {
  for (const k of [...viewers.keys()]) leaveBoard(k, id);
}

/** Present seated players, each listed once. */
function playingList(): { id: number; side: Side }[] {
  const out: { id: number; side: Side }[] = [];
  const listed = new Set<number>();
  for (const [k, v] of viewers) {
    const b = board(k);
    for (const side of ["w", "b"] as const) {
      const s = b[side];
      if (s && v.has(s.id) && !listed.has(s.id)) {
        listed.add(s.id);
        out.push({ id: s.id, side });
      }
    }
  }
  return out;
}

function sendTo(id: number, msg: ToClient): boolean {
  return hq.send(id, msg);
}

const playingMsg = (list: { id: number; side: Side }[]): ToClient => ({ t: "playing", list });

/** That member has the board's window open; a seated player is here again. */
function addViewer(id: number, k: string): void {
  let v = viewers.get(k);
  if (!v) viewers.set(k, (v = new Set()));
  if (v.has(id)) return;
  v.add(id);
  if (seatOf(board(k), id) !== null) changed(k);
}

export function onUse(p: HQ.Player, o: { kind: string; x: number; y: number }): void {
  if (o.kind !== "chessboard" || !tile(o.x) || !tile(o.y)) return;
  const k = key(o.x, o.y);
  addViewer(p.id, k);
  unconfirmed.set(p.id, k);
  toSend.get(p.id)?.delete(k); // the open message carries the state
  if (!sendTo(p.id, { t: "open", x: o.x, y: o.y, s: stateOf(k) })) toOpen.set(p.id, k);
}

export function onJoin(p: HQ.Player): void {
  toTell.add(p.id);
}

export function onLeave(p: HQ.Player): void {
  leaveAll(p.id);
  toSend.delete(p.id);
  toOpen.delete(p.id);
  toTell.delete(p.id);
  unconfirmed.delete(p.id);
}

export function onMessage(p: HQ.Player, raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const msg = raw as ToServer;
  if (msg.t === "hello") {
    // the page (re)started: no window of this member's can be open
    leaveAll(p.id);
    return;
  }
  if (!("x" in msg) || !tile(msg.x) || !tile(msg.y)) return;
  const k = key(msg.x, msg.y);
  if (msg.t === "opened") {
    // the page drew the window of the board it was last opened on (X, within reach): it is open, even when
    // the page's hello came after the open; any other confirmation changes nothing
    if (unconfirmed.get(p.id) !== k) return;
    unconfirmed.delete(p.id);
    if (!viewers.get(k)?.has(p.id)) {
      addViewer(p.id, k);
      queue(p.id, k); // its window shows the state of the open: send the current one
    }
    return;
  }
  if (msg.t === "close" && unconfirmed.get(p.id) === k) unconfirmed.delete(p.id); // a closed window stays closed
  if (!viewers.get(k)?.has(p.id)) return; // only from somebody who has this board open
  const b = board(k);
  switch (msg.t) {
    case "seat":
      if ((msg.side === "w" || msg.side === "b") && take(b, msg.side, { id: p.id, name: p.name })) save(k);
      return;
    case "move":
    case "place":
    case "stash": {
      let ok = false;
      if (msg.t === "move") {
        const promote: unknown = msg.promote; // absent: a plain move; null or a number: refused
        ok = square(msg.from) && square(msg.to) && (promote === undefined || typeof promote === "string") && move(b, p.id, msg.from, msg.to, promote);
      } else if (msg.t === "place") ok = typeof msg.piece === "string" && square(msg.to) && place(b, p.id, msg.piece, msg.to);
      else ok = square(msg.from) && toReserve(b, p.id, msg.from);
      if (ok) save(k);
      // refused: the player's view already shows the action (optimistic), so it gets the real position again
      else if (seatOf(b, p.id) !== null) queue(p.id, k);
      return;
    }
    case "reset":
      if (canReset(b, p.id, seen(k))) {
        reset(b);
        save(k);
      }
      return;
    case "close":
      leaveBoard(k, p.id);
      return;
  }
}

export function update(): void {
  for (const [id, k] of toOpen) {
    if (!viewers.get(k)?.has(id)) {
      toOpen.delete(id);
      continue;
    }
    if (sendTo(id, { t: "open", ...coords(k), s: stateOf(k) })) toOpen.delete(id);
  }
  for (const [id, ks] of toSend) {
    for (const k of ks) {
      if (!viewers.get(k)?.has(id)) {
        ks.delete(k);
        continue;
      }
      if (!sendTo(id, { t: "state", ...coords(k), s: stateOf(k) })) break; // this member's budget is spent
      ks.delete(k);
    }
    if (!ks.size) toSend.delete(id);
  }
  if (playingDirty) {
    playingDirty = false;
    const json = JSON.stringify(playingList());
    if (json !== playing) {
      playing = json;
      for (const p of hq.players()) toTell.add(p.id);
    }
  }
  if (toTell.size) {
    const msg = playingMsg(JSON.parse(playing));
    for (const id of toTell) if (sendTo(id, msg)) toTell.delete(id); // refused: that member waits for the next update
  }
}
