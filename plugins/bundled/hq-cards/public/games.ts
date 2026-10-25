// hq-cards's games: what a game plugin registers (its definition), the standard deck, the free table, and
// what a page is told about a game. Shared by the server code, the page code, the view and the tests.
// Types and pure functions only.

export type Action = "place" | "offer" | "dealAll" | "deal" | "shuffle" | "gather" | "count" | "createPile" | "viewPile" | "draw" | "remove";
export const ACTIONS: readonly Action[] = ["place", "offer", "dealAll", "deal", "shuffle", "gather", "count", "createPile", "viewPile", "draw", "remove"];

// The felt, in felt units (the view draws it at a whole-number scale); positions are within it.
export const FELT_W = 320;
export const FELT_H = 180;

const SUITS = "SHDC";
const RANKS = "A23456789TJQK";
const SUIT_NAMES: Record<string, string> = { S: "spades", H: "hearts", D: "diamonds", C: "clubs" };
const RANK_NAMES: Record<string, string> = { A: "Ace", T: "10", J: "Jack", Q: "Queen", K: "King" };
/** The standard deck: spades, hearts, diamonds, clubs, each ace to king, then the red and the black joker. */
export const STANDARD: readonly string[] = [...[...SUITS].flatMap((s) => [...RANKS].map((r) => r + s)), "XR", "XB"];

export const MAX_SEATS = 8;
export const MAX_CARDS = 128;
export const MAX_PILES = 16;
export const NAME_MAX = 24; // a card's name
export const PILE_NAME_MAX = 16;
export const TITLE_MAX = 40;
export const CLIENT_GAME_MAX = 3800; // UTF-8 bytes of a page's game message, under the 4 KB of a message

export interface StartPile { name: string; face: "up" | "down"; at: [number, number] }
export interface CustomCard { frame?: number; name: string }
export type Deck =
  | { standard: string[] }
  | { sheet: string; cell: [number, number]; back: number; total: number; cards: CustomCard[] };
export interface GameDefinition { title: string; seats: [number, number]; allow?: Action[]; deck: Deck; piles?: StartPile[]; count?: boolean }
/** A registered game; complete once every card of a custom deck arrived. */
export interface Game extends GameDefinition { name: string; complete: boolean }

/** What a page is told about a game: enough to draw its cards and offer its actions. */
export interface ClientGame {
  name: string;
  title: string;
  seats: [number, number];
  allow: Action[];
  deck: { standard: string[] } | { plugin: string; sheet: string; cell: [number, number]; back: number; frames: number[]; names: string[] };
}

export const FREE: Game = {
  name: "free",
  title: "Free table",
  seats: [2, MAX_SEATS],
  deck: { standard: [...STANDARD] },
  piles: [{ name: "Stock", face: "down", at: [FELT_W / 2, FELT_H / 2] }],
  complete: true,
};

type Result<T> = { ok: true } & T | { ok: false; err: string };
const fail = (err: string): { ok: false; err: string } => ({ ok: false, err });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;

/** The UTF-8 size of a string: what a message or an hq.kv value weighs (their 4 KB limits are bytes). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4; // a surrogate pair: one character of 4 bytes
      i++;
    } else n += 3;
  }
  return n;
}

export function deckSize(d: Deck): number {
  return "standard" in d ? d.standard.length : d.total;
}

export function cardName(g: Pick<Game, "deck"> | { deck: ClientGame["deck"] }, n: number): string {
  const d = g.deck;
  if ("standard" in d) {
    const code = d.standard[n];
    if (!code) return "a card";
    if (code === "XR") return "Red joker";
    if (code === "XB") return "Black joker";
    return `${RANK_NAMES[code[0]] ?? code[0]} of ${SUIT_NAMES[code[1]]}`;
  }
  if ("names" in d) return d.names[n] ?? "a card";
  return d.cards[n]?.name ?? "a card";
}

export function allows(g: { allow?: Action[] } | null, a: Action): boolean {
  return !g?.allow || g.allow.includes(a);
}

export function validateCards(cards: unknown, from: number, total: number): Result<{ cards: CustomCard[] }> {
  if (!Array.isArray(cards) || !cards.length) return fail("cards: a non-empty list");
  if (from + cards.length > total) return fail(`deck: ${from + cards.length} cards, over the ${total} announced`);
  const out: CustomCard[] = [];
  for (const c of cards) {
    if (!isObj(c) || !text(c.name, NAME_MAX)) return fail(`name: each card has a name of 1 to ${NAME_MAX} characters`);
    if (c.frame !== undefined && !int(c.frame, 0, 1023)) return fail("frame: a whole number from 0 to 1023");
    out.push(c.frame === undefined ? { name: c.name } : { frame: c.frame, name: c.name });
  }
  return { ok: true, cards: out };
}

function validateDeck(d: unknown): Result<{ deck: Deck }> {
  if (!isObj(d)) return fail("deck: an object");
  if ("standard" in d) {
    const s = d.standard;
    if (!Array.isArray(s) || !s.length || s.length > STANDARD.length) return fail("deck: 1 to 54 standard codes");
    if (s.some((c) => typeof c !== "string" || !STANDARD.includes(c))) return fail("deck: an unknown standard code");
    if (new Set(s).size !== s.length) return fail("deck: a standard code twice");
    return { ok: true, deck: { standard: [...s] as string[] } };
  }
  const { sheet, cell, back, total, cards } = d;
  if (typeof sheet !== "string" || !/^shared\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.png$/.test(sheet)) return fail("sheet: a .png under shared/");
  if (!Array.isArray(cell) || cell.length !== 2 || !int(cell[0], 4, 64) || !int(cell[1], 4, 64)) return fail("cell: [w, h], 4 to 64 px");
  if (!int(total, 1, MAX_CARDS)) return fail(`deck: 1 to ${MAX_CARDS} cards`);
  if (!int(back, 0, 1023)) return fail("back: a frame number");
  const c = validateCards(cards, 0, total);
  if (!c.ok) return c;
  return { ok: true, deck: { sheet, cell: [cell[0], cell[1]], back, total, cards: c.cards } };
}

export function validateDefinition(d: unknown): Result<{ def: GameDefinition }> {
  if (!isObj(d)) return fail("definition: an object");
  if (!text(d.title, TITLE_MAX)) return fail(`title: 1 to ${TITLE_MAX} characters`);
  const seats = d.seats;
  if (!Array.isArray(seats) || seats.length !== 2 || !int(seats[0], 2, MAX_SEATS) || !int(seats[1], 2, MAX_SEATS) || seats[0] > seats[1]) {
    return fail(`seats: [min, max] within 2 to ${MAX_SEATS}`);
  }
  let allow: Action[] | undefined;
  if (d.allow !== undefined) {
    if (!Array.isArray(d.allow) || d.allow.some((a) => !ACTIONS.includes(a))) return fail("allow: actions among " + ACTIONS.join(", "));
    allow = [...new Set(d.allow as Action[])];
  }
  const deck = validateDeck(d.deck);
  if (!deck.ok) return deck;
  let piles: StartPile[] | undefined;
  if (d.piles !== undefined) {
    if (!Array.isArray(d.piles) || d.piles.length > MAX_PILES) return fail(`piles: at most ${MAX_PILES}`);
    piles = [];
    for (const p of d.piles) {
      if (!isObj(p) || !text(p.name, PILE_NAME_MAX)) return fail(`pile: a name of 1 to ${PILE_NAME_MAX} characters`);
      if (p.face !== "up" && p.face !== "down") return fail("pile: face up or down");
      const at = p.at;
      if (!Array.isArray(at) || at.length !== 2 || !int(at[0], 0, FELT_W) || !int(at[1], 0, FELT_H)) return fail("pile: at [x, y] on the felt");
      piles.push({ name: p.name, face: p.face, at: [at[0], at[1]] });
    }
  }
  if (d.count !== undefined && typeof d.count !== "boolean") return fail("count: true or false");
  const def: GameDefinition = { title: d.title, seats: [seats[0], seats[1]], deck: deck.deck };
  if (allow) def.allow = allow;
  if (piles) def.piles = piles;
  if (d.count) def.count = true;
  // the page's game message must fit: judged with the names still to come as long as the longest so far
  if ("cards" in def.deck && def.deck.cards.length < def.deck.total) {
    const longest = def.deck.cards.reduce((a, c) => (c.name.length > a.length ? c.name : a), "");
    const padded = [...def.deck.cards, ...Array.from({ length: def.deck.total - def.deck.cards.length }, () => ({ name: longest }))];
    if (clientSize({ ...def, deck: { ...def.deck, cards: padded } }) > CLIENT_GAME_MAX) return fail("deck: the card names are too big for a page's message");
  } else if (clientSize(def) > CLIENT_GAME_MAX) return fail("deck: the card names are too big for a page's message");
  return { ok: true, def };
}

const clientSize = (def: GameDefinition) => utf8Bytes(JSON.stringify(clientGame({ ...def, name: "x".repeat(32), complete: true })));

export function clientGame(g: Game): ClientGame {
  const d = g.deck;
  const deck: ClientGame["deck"] = "standard" in d
    ? { standard: d.standard }
    : { plugin: g.name, sheet: d.sheet, cell: d.cell, back: d.back, frames: d.cards.map((c, i) => c.frame ?? i), names: d.cards.map((c) => c.name) };
  return { name: g.name, title: g.title, seats: g.seats, allow: g.allow ? [...g.allow] : [...ACTIONS], deck };
}
