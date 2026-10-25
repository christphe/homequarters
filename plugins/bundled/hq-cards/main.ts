// Cards plugin, server side. A card deck is a map object (plugin.json "objects"); pressing X next to one
// opens its table (onUse). A table plays one game: the free table, or a game another plugin registered
// through this plugin's hooks (register, registerCards), which narrows the actions and may count (its own
// "count" hook). Nothing checks a game's rules. Each table and its log are saved in hq.kv under
// "table:<x>,<y>" and "log:<x>,<y>" (its tile), loaded on first use and written on every change. Who has a
// table's window open (its viewers) and who looks through which pile live in memory only: a seated player
// is "here" while they are a viewer. The table's actions are in public/table.ts, the log in public/log.ts,
// games in public/games.ts; the browser side is public/client.ts (the window) and public/view.ts (the felt).
//
// Every change is queued and sent in update(), to the table's viewers: the table's state (an "open" first,
// which opens the window), the game (or the list of games while none is chosen), the log, in that order; a
// send refused by the budget is kept for the next update.

import { allows, clientGame, CLIENT_GAME_MAX, FREE, utf8Bytes, validateCards, validateDefinition, type Game } from "./public/games.ts";
import { append, parseLog, type LogEntry } from "./public/log.ts";
import {
  canReset, choose, counted, createPile, deal, dealAll, defaultCount, draw, flip, gather, offer, order, parseTable, pick, place,
  removePile, reorderPile, reset, seatOf, shuffle, take, UP, type Done, type Table,
} from "./public/table.ts";
import type { Act, Looking, TableState, ToClient, ToServer } from "./public/messages.ts";

const tables = new Map<string, Table>(); // "x,y" -> table, loaded on first use
const logs = new Map<string, LogEntry[]>();
const viewers = new Map<string, Set<number>>(); // table -> members with its window open
const lookers = new Map<string, Map<number, string>>(); // table -> member -> the pile they look through
const games = new Map<string, Game>(); // plugin name -> its registered game, complete
const pending = new Map<string, Game>(); // plugin name -> a definition whose cards are still arriving
// member -> table -> what they must be sent: h (the game or the games), s (the state), l (the log), o (as an open)
const toSend = new Map<number, Map<string, { h: boolean; s: boolean; l: boolean; o: boolean }>>();

const tile = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 100000;
const coords = (k: string) => {
  const [x, y] = k.split(",").map(Number);
  return { x, y };
};

function table(k: string): Table {
  let t = tables.get(k);
  if (!t) {
    t = parseTable(hq.kv.get("table:" + k));
    tables.set(k, t);
    logs.set(k, parseLog(hq.kv.get("log:" + k)));
  }
  return t;
}
const logOf = (k: string) => (table(k), logs.get(k)!);
const seen = (k: string) => viewers.get(k) ?? new Set<number>();

/** The game a table plays, or null when none is chosen or its plugin is not running (unavailable). */
function gameOf(t: Table): Game | null {
  if (t.game === "free") return FREE;
  const g = t.game === null ? undefined : games.get(t.game);
  return g?.complete ? g : null;
}

function stateOf(k: string): TableState {
  const t = table(k), here = seen(k);
  const looking: Looking[] = [];
  for (const [id, pile] of lookers.get(k) ?? []) {
    const seat = seatOf(t, id);
    if (seat !== null) looking.push({ seat, pile });
  }
  return {
    t,
    here: t.seats.flatMap((s) => (s && here.has(s.id) ? [s.id] : [])),
    looking,
    unavailable: t.game !== null && gameOf(t) === null,
  };
}

function queue(id: number, k: string, what: { h?: boolean; s?: boolean; l?: boolean; o?: boolean }): void {
  let m = toSend.get(id);
  if (!m) toSend.set(id, (m = new Map()));
  const q = m.get(k) ?? { h: false, s: false, l: false, o: false };
  m.set(k, { h: q.h || !!what.h, s: q.s || !!what.s, l: q.l || !!what.l, o: q.o || !!what.o });
}

/** The table's viewers must be sent what changed. */
function changed(k: string, what: { h?: boolean; s?: boolean; l?: boolean }): void {
  for (const id of seen(k)) queue(id, k, what);
}

function save(k: string): void {
  const t = table(k);
  try {
    if (t.game === null) {
      // a table back to new keeps nothing: its keys are freed (an office holds 1000 per plugin)
      hq.kv.delete("table:" + k);
      hq.kv.delete("log:" + k);
      return;
    }
    hq.kv.set("table:" + k, JSON.stringify(t));
    hq.kv.set("log:" + k, JSON.stringify(logOf(k)));
  } catch {
    hq.log("table not saved: storage full"); // the game goes on in memory
  }
}

/** The outcome of an action: saved, logged and sent; refused, the player gets the real state again. */
function done(k: string, id: number, r: Done): void {
  if (!r.ok) {
    queue(id, k, { s: true });
    return;
  }
  if (r.log) logs.set(k, append(logOf(k), r.log));
  save(k);
  changed(k, { s: true, l: !!r.log });
}

/** A member no longer has that table's window open (their seat stays). */
function leaveTable(k: string, id: number): void {
  const v = viewers.get(k);
  if (!v || !v.delete(id)) return;
  if (!v.size) viewers.delete(k);
  const looked = lookers.get(k)?.delete(id);
  toSend.get(id)?.delete(k);
  if (looked || seatOf(table(k), id) !== null) changed(k, { s: true });
}

function leaveAll(id: number): void {
  for (const k of [...viewers.keys()]) leaveTable(k, id);
}

/** The games changed: every open window gets its game (or the list) and state again. */
function gamesChanged(): void {
  for (const k of viewers.keys()) changed(k, { h: true, s: true });
}

export function load(): void {
  hq.expose("register", (caller: HQ.Caller, def: unknown) => {
    if (caller.plugin === FREE.name) return { ok: false, err: "a game cannot be named free" };
    const r = validateDefinition(def);
    if (!r.ok) return { ok: false, err: r.err };
    const d = r.def.deck;
    const g: Game = { ...r.def, name: caller.plugin, complete: !("cards" in d) || d.cards.length === d.total };
    if (g.complete) settle(g);
    else pending.set(caller.plugin, g); // the game it replaces keeps serving its tables until the rest arrives
    return { ok: true };
  });
  hq.expose("registerCards", (caller: HQ.Caller, args: unknown) => {
    const g = pending.get(caller.plugin);
    const a = (typeof args === "object" && args !== null ? args : {}) as { from?: unknown; cards?: unknown };
    if (!g || !("cards" in g.deck)) return { ok: false, err: "register a custom deck first" };
    const d = g.deck;
    if (a.from !== d.cards.length) return { ok: false, err: `from: the next card is ${d.cards.length}` };
    const r = validateCards(a.cards, d.cards.length, d.total);
    if (!r.ok) return { ok: false, err: r.err };
    const next: Game = { ...g, deck: { ...d, cards: [...d.cards, ...r.cards] } };
    next.complete = "cards" in next.deck && next.deck.cards.length === d.total;
    if (next.complete && utf8Bytes(JSON.stringify(clientGame(next))) > CLIENT_GAME_MAX) {
      pending.delete(caller.plugin);
      return { ok: false, err: "deck: the card names are too big for a page's message" };
    }
    if (next.complete) settle(next);
    else pending.set(caller.plugin, next);
    return { ok: true };
  });
}

/** A game's definition is complete: it serves its tables, and open windows hear of it if it changed. */
function settle(g: Game): void {
  pending.delete(g.name);
  const before = games.get(g.name);
  games.set(g.name, g);
  if (!before || JSON.stringify(before) !== JSON.stringify(g)) gamesChanged();
}

export function onPlugins(): void {
  let gone = false;
  for (const name of [...games.keys(), ...pending.keys()]) {
    if (!hq.plugins.running(name)) {
      pending.delete(name);
      if (games.delete(name)) gone = true;
    }
  }
  if (gone) gamesChanged();
}

export function onUse(p: HQ.Player, o: { kind: string; x: number; y: number }): void {
  if (o.kind !== "deck" || !tile(o.x) || !tile(o.y)) return;
  const k = `${o.x},${o.y}`;
  let v = viewers.get(k);
  if (!v) viewers.set(k, (v = new Set()));
  const wasHere = v.has(p.id);
  v.add(p.id);
  queue(p.id, k, { h: true, s: true, l: true, o: true });
  if (!wasHere && seatOf(table(k), p.id) !== null) changed(k, { s: true });
}

export function onJoin(): void {}

export function onLeave(p: HQ.Player): void {
  leaveAll(p.id);
  toSend.delete(p.id);
}

/** What a count hook gets: names and card numbers, without the face-up mark. */
function countArgs(t: Table) {
  const c = (n: number) => n & ~UP;
  return {
    seats: t.seats.map((s) => s?.name ?? null),
    hands: t.hands,
    piles: t.piles.map((p) => ({ name: p.name, cards: p.cards.map(c) })),
    loose: t.loose.map((l) => c(l.c)),
  };
}

function count(k: string, p: HQ.Player, t: Table, g: Game): void {
  const seat = seatOf(t, p.id);
  if (!g.count || g === FREE) return done(k, p.id, counted(t, seat, defaultCount(t), g));
  if (seat === null || !allows(g, "count")) return done(k, p.id, { ok: false });
  const ask = (text: string) => {
    const now = table(k);
    if (now.game !== g.name || seatOf(now, p.id) !== seat) return; // reset or changed meanwhile
    done(k, p.id, counted(now, seat, text, g));
  };
  hq.plugins
    .call<unknown>(g.name, "count", countArgs(t))
    .then((text) => ask(typeof text === "string" && text.trim() ? text : "Count unavailable"))
    .catch(() => ask("Count unavailable"));
}

function act(p: HQ.Player, k: string, m: Act): void {
  const t = table(k);
  if (m.t === "choose") {
    const g = m.game === "free" ? FREE : typeof m.game === "string" ? games.get(m.game) : undefined;
    if (t.game !== null || !g?.complete) return queue(p.id, k, { h: true, s: true });
    choose(t, g);
    logs.set(k, []);
    lookers.delete(k);
    save(k);
    return changed(k, { h: true, s: true, l: true });
  }
  if (m.t === "reset") {
    if (!canReset(t, p.id, seen(k))) return queue(p.id, k, { s: true });
    reset(t);
    logs.set(k, []);
    lookers.delete(k);
    save(k);
    return changed(k, { h: true, s: true, l: true });
  }
  const g = gameOf(t);
  if (!g) return queue(p.id, k, { h: true, s: true }); // no game, or its plugin is off: only reset
  const seat = seatOf(t, p.id);
  switch (m.t) {
    case "seat": return done(k, p.id, take(t, m.seat, { id: p.id, name: p.name }));
    case "place": return done(k, p.id, place(t, seat, m.from, m.to, m.up === true, g));
    case "flip": return done(k, p.id, flip(t, seat, m.from, g));
    case "order": return done(k, p.id, order(t, seat, m.hand));
    case "offer": return done(k, p.id, offer(t, seat, m.to ?? null, g));
    case "pick": return done(k, p.id, pick(t, seat, m.i, g));
    case "dealAll": return done(k, p.id, dealAll(t, seat, m.pile, g));
    case "deal": return done(k, p.id, deal(t, seat, m.pile, m.n, g));
    case "shuffle": return done(k, p.id, shuffle(t, seat, m.pile, g));
    case "gather": {
      const r = gather(t, seat, g);
      if (r.ok) lookers.delete(k);
      return done(k, p.id, r);
    }
    case "count": return count(k, p, t, g);
    case "newPile": return done(k, p.id, createPile(t, seat, m.name, m.face, m.at, g));
    case "delPile": return done(k, p.id, removePile(t, seat, m.pile, g));
    case "reorder": return done(k, p.id, reorderPile(t, seat, m.pile, m.cards, g));
    case "draw": return done(k, p.id, draw(t, seat, m.pile, g));
    case "look": {
      const pile = t.piles.find((x) => x.id === m.pile);
      if (seat === null || !pile || !allows(g, "viewPile")) return done(k, p.id, { ok: false });
      let l = lookers.get(k);
      if (!l) lookers.set(k, (l = new Map()));
      if (l.get(p.id) === pile.id) return; // already looking: nothing new for the log
      l.set(p.id, pile.id);
      return done(k, p.id, { ok: true, log: { s: seat, v: "looked", p: pile.name } });
    }
    case "unlook":
      if (lookers.get(k)?.delete(p.id)) changed(k, { s: true });
      return;
  }
}

export function onMessage(p: HQ.Player, raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const m = raw as ToServer;
  if (m.t === "hello") {
    // the page (re)started: no window of this member's can be open
    leaveAll(p.id);
    return;
  }
  if (!("x" in m) || !tile(m.x) || !tile(m.y)) return;
  const k = `${m.x},${m.y}`;
  if (!viewers.get(k)?.has(p.id)) return; // only from somebody who has this table open
  if (m.t === "close") return leaveTable(k, p.id);
  if (typeof m.t !== "string") return;
  act(p, k, m as Act);
}

function headOf(k: string): ToClient {
  const t = table(k), at = coords(k);
  if (t.game === null) {
    const list = [{ name: "free", title: FREE.title }];
    for (const g of games.values()) if (g.complete) list.push({ name: g.name, title: g.title });
    return { t: "games", ...at, list };
  }
  const g = gameOf(t);
  return g ? { t: "game", ...at, g: clientGame(g) } : { t: "games", ...at, list: [] };
}

/** Sends, or false when the budget is spent; a message the host refuses outright (over 4 KB) is dropped. */
function sendTo(id: number, msg: ToClient): boolean {
  try {
    return hq.send(id, msg);
  } catch {
    if (!warnedSize) hq.log("a table message was too big to send; dropped");
    warnedSize = true;
    return true; // dropped: retrying would throw on every update and stop the plugin
  }
}
let warnedSize = false;

export function update(): void {
  for (const [id, m] of toSend) {
    for (const [k, q] of m) {
      if (!viewers.get(k)?.has(id)) {
        m.delete(k);
        continue;
      }
      if (q.s) {
        if (!sendTo(id, { t: q.o ? "open" : "state", ...coords(k), s: stateOf(k) })) break; // this member's budget is spent
        q.s = q.o = false;
      }
      if (q.h) {
        if (!sendTo(id, headOf(k))) break;
        q.h = false;
      }
      if (q.l) {
        if (!sendTo(id, { t: "log", ...coords(k), log: logOf(k) })) break;
        q.l = false;
      }
      m.delete(k);
    }
    if (!m.size) toSend.delete(id);
  }
}
