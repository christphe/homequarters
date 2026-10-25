// hq-cards's table: one card game on one deck of the map. Seats, hands, piles and the cards lying loose on
// the felt, and every action a seated player may take. Nothing checks a game's rules: a game only narrows
// the actions (games.ts, allows). Each action returns ok and, when something happened that the table must
// see, its log entry; a refused action changes nothing. A card is a number, its index in the game's deck;
// on the felt or in a pile, UP is added while it lies face up. Shared by the server code, the page code and
// the tests. Pure functions only (shuffling takes the random source as an argument).
import { allows, deckSize, FELT_H, FELT_W, FREE, MAX_PILES, PILE_NAME_MAX, utf8Bytes, type Action, type Game, type StartPile } from "./games.ts";
import type { LogEntry } from "./log.ts";

export const UP = 128; // card numbers are below MAX_CARDS (128)
export const TABLE_MAX = 3650; // UTF-8 bytes of JSON: a table is saved in one hq.kv value and sent, with who is here and looking, in one 4 KB message
export const DEAL_MAX = 52;
export const COUNT_MAX = 200;

export interface Seat { id: number; name: string }
/** cards: bottom first, the last one is the top. mine: created by a player (gather removes it). */
export interface Pile { id: string; name: string; at: [number, number]; face: "up" | "down"; cards: number[]; mine: boolean }
export interface Loose { c: number; at: [number, number] }
export interface Table {
  game: string | null;
  seats: (Seat | null)[];
  hands: number[][];
  piles: Pile[];
  loose: Loose[];
  offer: { from: number; to: number } | null;
  count: string;
  next: number; // the next pile id's number
  snap: boolean; // drops land on a grid and on other cards (layout.ts snapAt), for everybody at the table
  out: number[]; // cards set aside, out of the game until a reset
}
export type Dest = { k: "felt"; at: [number, number] } | { k: "pile"; id: string } | { k: "hand"; seat: number };
export type Src = { k: "hand"; i: number } | { k: "loose"; c: number } | { k: "pile"; id: string };
export type Done = { ok: false } | { ok: true; log?: LogEntry };

const NO: Done = { ok: false };
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const onFelt = (at: unknown): at is [number, number] =>
  Array.isArray(at) && at.length === 2 && isInt(at[0]) && isInt(at[1]) && at[0] >= 0 && at[0] <= FELT_W && at[1] >= 0 && at[1] <= FELT_H;
const card = (c: number) => c & ~UP;
// what a page sends is checked for shape before anything is taken out of a hand or a pile
const isSrc = (s: unknown): s is Src => typeof s === "object" && s !== null && ["hand", "loose", "pile"].includes((s as Src).k);
const isDest = (d: unknown): d is Dest => typeof d === "object" && d !== null && ["felt", "pile", "hand"].includes((d as Dest).k);
const sameCards = (a: number[], b: number[]) => {
  if (a.length !== b.length || !b.every(isInt)) return false;
  const x = [...a].sort((p, q) => p - q), y = [...b].sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
};

export function newTable(): Table {
  return { game: null, seats: [], hands: [], piles: [], loose: [], offer: null, count: "", next: 0, snap: true, out: [] };
}

export function parseTable(s: string | null): Table {
  if (!s) return newTable();
  try {
    const t = JSON.parse(s) as Table;
    const ok = typeof t === "object" && t !== null && (t.game === null || typeof t.game === "string") && Array.isArray(t.seats) &&
      Array.isArray(t.hands) && Array.isArray(t.piles) && Array.isArray(t.loose) && typeof t.count === "string" && isInt(t.next);
    if (!ok) return newTable();
    // tables saved before snapping and setting aside existed
    if (typeof t.snap !== "boolean") t.snap = true;
    if (!Array.isArray(t.out)) t.out = [];
    return t;
  } catch {
    return newTable();
  }
}

/** The table's JSON in UTF-8 bytes. */
export function encodedSize(t: Table): number {
  return utf8Bytes(JSON.stringify(t));
}

function shuffled(cards: number[], rnd: () => number): void {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
}

/** Starts a game on the table: empty seats, its starting piles, every card shuffled face down into the first. */
export function choose(t: Table, g: Game, rnd: () => number = Math.random): void {
  const starts: StartPile[] = g.piles?.length ? g.piles : FREE.piles!;
  const n = g.seats[1];
  Object.assign(t, newTable(), {
    game: g.name,
    seats: Array.from({ length: n }, () => null),
    hands: Array.from({ length: n }, () => []),
    piles: starts.map((p, i) => ({ id: "p" + i, name: p.name, at: [p.at[0], p.at[1]], face: p.face, cards: [], mine: false })),
    next: starts.length,
  });
  const deck = Array.from({ length: deckSize(g.deck) }, (_, i) => i);
  shuffled(deck, rnd);
  t.piles[0].cards = deck;
}

export function seatOf(t: Table, id: number): number | null {
  const i = t.seats.findIndex((s) => s?.id === id);
  return i < 0 ? null : i;
}

const seated = (t: Table, seat: unknown): seat is number => isInt(seat) && seat >= 0 && seat < t.seats.length && t.seats[seat] !== null;

/**
 * Runs an action for a seated player, if the game allows it, and undoes it when the table would no longer
 * fit TABLE_MAX. fn returns null (refused) or the log entry (undefined: nothing to log).
 */
function act(t: Table, seat: number | null, g: Game, a: Action | null, fn: (seat: number) => LogEntry | undefined | null): Done {
  if (!seated(t, seat) || (a && !allows(g, a))) return NO;
  const before = JSON.stringify(t);
  const log = fn(seat);
  if (log === null) return NO;
  if (encodedSize(t) > TABLE_MAX) {
    Object.assign(t, JSON.parse(before));
    return NO;
  }
  return log ? { ok: true, log } : { ok: true };
}

function pile(t: Table, id: unknown): Pile | undefined {
  return typeof id === "string" ? t.piles.find((p) => p.id === id) : undefined;
}

export function take(t: Table, seat: number, who: { id: number; name: string }): Done {
  if (t.game === null || !isInt(seat) || seat < 0 || seat >= t.seats.length || t.seats[seat] || seatOf(t, who.id) !== null) return NO;
  t.seats[seat] = { id: who.id, name: who.name };
  if (encodedSize(t) > TABLE_MAX) {
    t.seats[seat] = null; // a long name on a full table: it would no longer fit a message
    return NO;
  }
  return { ok: true, log: { s: seat, v: "took" } };
}

/** Takes the card out of where it is; null if it is not there. */
function lift(t: Table, seat: number, from: Src): number | null {
  if (from.k === "hand") {
    const h = t.hands[seat];
    if (!isInt(from.i) || from.i < 0 || from.i >= h.length) return null;
    return h.splice(from.i, 1)[0];
  }
  if (from.k === "loose") {
    const i = t.loose.findIndex((l) => card(l.c) === from.c);
    return i < 0 ? null : t.loose.splice(i, 1)[0].c;
  }
  if (from.k === "pile") {
    const p = pile(t, from.id);
    return p?.cards.length ? p.cards.pop()! : null;
  }
  return null;
}

export function place(t: Table, seat: number | null, from: Src, to: Dest, up: boolean, g: Game): Done {
  return act(t, seat, g, "place", (me) => {
    if (!isSrc(from) || !isDest(to)) return null;
    if (to.k === "hand" && (!seated(t, to.seat) || (to.seat === me && from.k !== "loose"))) return null; // pile to my hand: draw
    if (to.k === "felt" && !onFelt(to.at)) return null;
    const dest = to.k === "pile" ? pile(t, to.id) : undefined;
    if (to.k === "pile" && (!dest || (from.k === "pile" && from.id === to.id))) return null;
    const c = lift(t, me, from);
    if (c === null) return null;
    const face = card(c) | (up ? UP : 0);
    if (to.k === "hand") {
      t.hands[to.seat].push(card(c));
      return to.seat === me ? { s: me, v: "took back" } : { s: me, v: "gave", to: to.seat };
    }
    if (to.k === "felt") t.loose.push({ c: face, at: [to.at[0], to.at[1]] });
    else dest!.cards.push(face);
    const e: LogEntry = { s: me, v: "placed" };
    if (up) e.c = card(c);
    if (dest) e.p = dest.name;
    return e;
  });
}

export function flip(t: Table, seat: number | null, from: Src, g: Game): Done {
  return act(t, seat, g, "place", (me) => {
    let set: (c: number) => void, c: number;
    if (from?.k === "loose") {
      const l = t.loose.find((x) => card(x.c) === from.c);
      if (!l) return null;
      c = l.c;
      set = (v) => (l.c = v);
    } else if (from?.k === "pile") {
      const p = pile(t, from.id);
      if (!p?.cards.length) return null;
      c = p.cards[p.cards.length - 1];
      set = (v) => (p.cards[p.cards.length - 1] = v);
    } else return null;
    set(c ^ UP);
    return c & UP ? { s: me, v: "flipped" } : { s: me, v: "flipped", c: card(c) };
  });
}

export function order(t: Table, seat: number | null, hand: number[]): Done {
  if (!seated(t, seat) || !Array.isArray(hand) || !sameCards(t.hands[seat], hand)) return NO;
  t.hands[seat] = [...hand];
  return { ok: true };
}

export function offer(t: Table, seat: number | null, to: number | null, g: Game): Done {
  return act(t, seat, g, "offer", (me) => {
    if (to === null) {
      if (t.offer?.from !== me) return null;
      t.offer = null;
      return { s: me, v: "withdrew" };
    }
    if (!seated(t, to) || to === me || !t.hands[me].length) return null;
    t.offer = { from: me, to };
    return { s: me, v: "offered", to };
  });
}

export function pick(t: Table, seat: number | null, i: number, g: Game): Done {
  return act(t, seat, g, "offer", (me) => {
    const o = t.offer;
    if (!o || o.to !== me || !seated(t, o.from)) return null;
    const from = t.hands[o.from];
    if (!isInt(i) || i < 0 || i >= from.length) return null;
    t.hands[me].push(from.splice(i, 1)[0]);
    t.offer = null;
    return { s: me, v: "picked", to: o.from };
  });
}

/** The seated seats in dealing order: the one after the dealer first, the dealer last. */
function round(t: Table, dealer: number): number[] {
  const n = t.seats.length;
  const out: number[] = [];
  for (let k = 1; k <= n; k++) if (t.seats[(dealer + k) % n]) out.push((dealer + k) % n);
  return out;
}

function dealFrom(t: Table, dealer: number, id: string, n: number): boolean {
  const p = pile(t, id);
  if (!p?.cards.length) return false;
  const order = round(t, dealer);
  for (let r = 0; r < n && p.cards.length; r++) for (const s of order) if (p.cards.length) t.hands[s].push(card(p.cards.pop()!));
  return true;
}

export function dealAll(t: Table, seat: number | null, id: string, g: Game): Done {
  return act(t, seat, g, "dealAll", (me) => (dealFrom(t, me, id, Infinity) ? { s: me, v: "dealt" } : null));
}

export function deal(t: Table, seat: number | null, id: string, n: number, g: Game): Done {
  if (!isInt(n) || n < 1 || n > DEAL_MAX) return NO;
  return act(t, seat, g, "deal", (me) => (dealFrom(t, me, id, n) ? { s: me, v: "dealt", n } : null));
}

export function shuffle(t: Table, seat: number | null, id: string, g: Game, rnd: () => number = Math.random): Done {
  return act(t, seat, g, "shuffle", (me) => {
    const p = pile(t, id);
    if (!p) return null;
    if (p.cards.length < 2) return undefined; // nothing to shuffle, nothing to log
    shuffled(p.cards, rnd);
    return { s: me, v: "shuffled", p: p.name };
  });
}

export function gather(t: Table, seat: number | null, g: Game): Done {
  return act(t, seat, g, "gather", (me) => {
    const stock = t.piles[0];
    if (!stock) return null;
    const cards = [...t.hands.flat(), ...t.piles.flatMap((p) => p.cards), ...t.loose.map((l) => l.c)].map(card);
    for (const h of t.hands) h.length = 0;
    t.piles = t.piles.filter((p) => !p.mine);
    for (const p of t.piles) p.cards = [];
    t.piles[0].cards = cards;
    t.loose = [];
    t.offer = null;
    return { s: me, v: "gathered" };
  });
}

export function createPile(t: Table, seat: number | null, name: string, face: "up" | "down", at: [number, number], g: Game): Done {
  return act(t, seat, g, "createPile", (me) => {
    if (typeof name !== "string" || !name.trim() || name.length > PILE_NAME_MAX || (face !== "up" && face !== "down") || !onFelt(at)) return null;
    if (t.piles.length >= MAX_PILES) return null;
    t.piles.push({ id: "p" + t.next++, name, at: [at[0], at[1]], face, cards: [], mine: true });
    return { s: me, v: "created", p: name };
  });
}

/** Any pile but the stock (the first); its cards go back to the stock, face down. */
export function removePile(t: Table, seat: number | null, id: string, g: Game): Done {
  return act(t, seat, g, "createPile", (me) => {
    const p = pile(t, id);
    if (!p || p === t.piles[0]) return null;
    t.piles[0].cards.push(...p.cards.map(card));
    t.piles = t.piles.filter((x) => x !== p);
    return { s: me, v: "removed", p: p.name };
  });
}

/** Snapping on or off, for everybody at the table. */
export function setSnap(t: Table, seat: number | null, on: boolean): Done {
  if (!seated(t, seat) || typeof on !== "boolean") return NO;
  t.snap = on;
  return { ok: true, log: { s: seat, v: "snap", n: on ? 1 : 0 } };
}

/** Loose cards moved together by (dx, dy): they keep their order and go on top. */
export function moveCards(t: Table, seat: number | null, cards: number[], dx: number, dy: number, g: Game): Done {
  return act(t, seat, g, "place", (me) => {
    if (!Array.isArray(cards) || !cards.length || cards.length > t.loose.length || !isInt(dx) || !isInt(dy)) return null;
    if (new Set(cards).size !== cards.length) return null;
    const moving = t.loose.filter((l) => cards.includes(card(l.c)));
    if (moving.length !== cards.length) return null;
    const moved = moving.map((l) => ({ c: l.c, at: [l.at[0] + dx, l.at[1] + dy] as [number, number] }));
    if (!moved.every((l) => onFelt(l.at))) return null;
    t.loose = [...t.loose.filter((l) => !moving.includes(l)), ...moved];
    return { s: me, v: "moved", n: cards.length };
  });
}

/** A pile turned over as a whole, as a deck is: its order reversed, every card the other face, the pile's face too. */
export function turnPile(t: Table, seat: number | null, id: string, g: Game): Done {
  return act(t, seat, g, "place", (me) => {
    const p = pile(t, id);
    if (!p) return null;
    p.cards = p.cards.reverse().map((c) => c ^ UP);
    p.face = p.face === "up" ? "down" : "up";
    return { s: me, v: "turned pile", p: p.name };
  });
}

export function movePile(t: Table, seat: number | null, id: string, at: [number, number], g: Game): Done {
  return act(t, seat, g, "place", (me) => {
    const p = pile(t, id);
    if (!p || !onFelt(at)) return null;
    p.at = [at[0], at[1]];
    return { s: me, v: "moved pile", p: p.name };
  });
}

const RANK_ORDER = "23456789TJQKA";
const RANK_WORDS: Record<string, string> = { A: "aces", T: "10s", J: "jacks", Q: "queens", K: "kings" };
/** "the 2s, 3s and the jokers": the ranks set aside, for the log. */
function rankList(ranks: string[]): string {
  const words = [...RANK_ORDER].filter((r) => ranks.includes(r)).map((r) => RANK_WORDS[r] ?? r + "s");
  const all = [...words.map((w, i) => (i === 0 ? "the " + w : w)), ...(ranks.includes("X") ? ["the jokers"] : [])];
  return all.length > 1 ? all.slice(0, -1).join(", ") + " and " + all[all.length - 1] : all[0];
}

/**
 * Every card of these ranks (rank letters of the standard deck, X for the jokers) out of the game, wherever
 * it is, until a reset: a 32- or a 52-card game from the standard deck. Nothing left of them: nothing to log.
 */
export function setAsideRanks(t: Table, seat: number | null, ranks: string[], g: Game): Done {
  if (!Array.isArray(ranks) || !ranks.length || ranks.some((r) => typeof r !== "string" || r.length !== 1 || !(RANK_ORDER + "X").includes(r))) return NO;
  if (!("standard" in g.deck)) return NO;
  const codes = g.deck.standard;
  return act(t, seat, g, "remove", (me) => {
    const out = (c: number) => ranks.includes(codes[card(c)]?.[0] ?? "");
    const gone = [...t.hands.flat(), ...t.piles.flatMap((p) => p.cards), ...t.loose.map((l) => l.c)].filter(out).map(card);
    if (!gone.length) return undefined;
    for (const h of t.hands) h.splice(0, h.length, ...h.filter((c) => !out(c)));
    for (const p of t.piles) p.cards = p.cards.filter((c) => !out(c));
    t.loose = t.loose.filter((l) => !out(l.c));
    t.out.push(...gone);
    return { s: me, v: "set aside", n: gone.length, text: rankList(ranks) };
  });
}

/** A card out of the game (from my hand, the felt or a pile's top) until a reset. */
export function setAside(t: Table, seat: number | null, from: Src, g: Game): Done {
  return act(t, seat, g, "remove", (me) => {
    if (!isSrc(from)) return null;
    const c = lift(t, me, from);
    if (c === null) return null;
    t.out.push(card(c));
    return { s: me, v: "set aside", c: card(c) };
  });
}

export function reorderPile(t: Table, seat: number | null, id: string, cards: number[], g: Game): Done {
  return act(t, seat, g, "viewPile", (me) => {
    const p = pile(t, id);
    if (!p || !Array.isArray(cards) || !sameCards(p.cards, cards)) return null;
    p.cards = [...cards];
    return { s: me, v: "reordered", p: p.name };
  });
}

export function draw(t: Table, seat: number | null, id: string, g: Game): Done {
  return act(t, seat, g, "draw", (me) => {
    const p = pile(t, id);
    if (!p?.cards.length) return null;
    t.hands[me].push(card(p.cards.pop()!));
    return { s: me, v: "drew", p: p.name };
  });
}

/** Keeps a count's result (the game's or defaultCount's) on the table and logs it. */
export function counted(t: Table, seat: number | null, text: string, g: Game): Done {
  return act(t, seat, g, "count", (me) => {
    t.count = [...String(text)].slice(0, COUNT_MAX).join("");
    return { s: me, v: "counted", text: t.count };
  });
}

/** The count of a table without a game's own: cards in each seated hand, in each pile, and loose. */
export function defaultCount(t: Table): string {
  const hands = t.seats.flatMap((s, i) => (s ? [`${s.name} ${t.hands[i].length}`] : [])).join(", ");
  const piles = t.piles.map((p) => `${p.name} ${p.cards.length}`).join(", ");
  const parts = [hands, piles].filter(Boolean);
  if (t.loose.length) parts.push(`${t.loose.length} on the table`);
  if (t.out.length) parts.push(`${t.out.length} set aside`);
  return parts.join(" · ");
}

/** As chess: a present seated player may always reset; anybody may when no seated player is present. */
export function canReset(t: Table, member: number, present: Set<number>): boolean {
  const here = t.seats.filter((s): s is Seat => !!s && present.has(s.id));
  return here.length === 0 || here.some((s) => s.id === member);
}

export function reset(t: Table): void {
  for (const k of Object.keys(t)) delete (t as unknown as Record<string, unknown>)[k];
  Object.assign(t, newTable());
}
