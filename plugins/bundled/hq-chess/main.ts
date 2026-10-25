// Chess plugin, server side. A chessboard is a map object (plugin.json "objects"); pressing X next to one
// opens it (onUse). Two members take White and Black, others watch; pieces go where they are dropped, no
// rules. Each board's position and players are saved in hq.kv under "board:<x>,<y>" (its tile), loaded on
// first use and written on every change. Who has a board's window open (its viewers) lives in memory only:
// a seated player is "here" while they are a viewer. The rules of seats and reset are in public/game.ts;
// the browser side is public/client.ts (the window) and public/board.ts (the board view).
//
// Every change is collected and sent in update(), to the board's viewers (state) and to everybody (the
// list of present seated players, for the badge over their heads); a send refused by the budget is kept
// for the next update.

import { canReset, move, parseBoard, reset, seatOf, take, type Board, type Side } from "./public/game";
import type { BoardState, SeatState, ToClient, ToServer } from "./public/messages";

const boards = new Map<string, Board>(); // loaded on first use
const viewers = new Map<string, Set<number>>(); // board key -> members with its window open
const toSend = new Map<number, Set<string>>(); // member -> boards whose state they must be sent
const toOpen = new Map<number, string>(); // member -> the board their window must open on (a refused send)
const toTell = new Set<number>(); // members who must be sent the playing list (they joined)
let playing = "[]"; // the playing list last broadcast, as JSON
let playingSent = true;

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
  return { p: b.p, w: seat(b.w), b: seat(b.b) };
}

function coords(k: string): { x: number; y: number } {
  const [x, y] = k.slice(6).split(",").map(Number);
  return { x, y };
}

/** The board's viewers must be sent its state, and the playing list may have changed. */
function changed(k: string): void {
  for (const id of seen(k)) {
    let s = toSend.get(id);
    if (!s) toSend.set(id, (s = new Set()));
    s.add(k);
  }
  playingSent = false;
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

export function onUse(p: HQ.Player, o: { kind: string; x: number; y: number }): void {
  if (o.kind !== "chessboard" || !tile(o.x) || !tile(o.y)) return;
  const k = key(o.x, o.y);
  let v = viewers.get(k);
  if (!v) viewers.set(k, (v = new Set()));
  const wasHere = v.has(p.id);
  v.add(p.id);
  toSend.get(p.id)?.delete(k); // the open message carries the state
  if (!wasHere && seatOf(board(k), p.id) !== null) changed(k);
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
  if (!viewers.get(k)?.has(p.id)) return; // only from somebody who has this board open
  const b = board(k);
  switch (msg.t) {
    case "seat":
      if ((msg.side === "w" || msg.side === "b") && take(b, msg.side, { id: p.id, name: p.name })) save(k);
      return;
    case "move":
      if (square(msg.from) && square(msg.to) && move(b, p.id, msg.from, msg.to)) save(k);
      return;
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
  if (!playingSent || toTell.size) {
    const list = playingList();
    const json = JSON.stringify(list);
    if (!playingSent) {
      if (json === playing) playingSent = true;
      else if (hq.broadcast(playingMsg(list))) {
        playing = json;
        playingSent = true;
        toTell.clear(); // everybody online just got it
      }
    }
    for (const id of toTell) if (sendTo(id, playingMsg(JSON.parse(playing)))) toTell.delete(id);
  }
}
