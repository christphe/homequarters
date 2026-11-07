// Shared by the integration tests of the card table and of its games (`*.ispec.ts`): a testbed with a card
// deck on the map, members standing round it, and readers for what the table sent them. The table and its
// game are in hq-cards, so every message goes to "hq-cards", whichever game is played.
import assert from "node:assert/strict";
import path from "node:path";
import { testbed } from "../../../sdk/testbed.ts";
import type { Member, Testbed, Tile } from "../../../sdk/testbed.ts";

export const CARDS = "hq-cards";
export const cardsDir = path.resolve(import.meta.dirname, "..");
export const fixture = (name: string): string => path.join(import.meta.dirname, "fixtures", name);

/** The deck's tile: the table is named by it in every message. */
export const DECK: Tile = { x: 13, y: 24 };
// the eight tiles round the deck, where members stand (within reach of it): free floor in the default office
const ROUND: Tile[] = [
  { x: 13, y: 25 }, { x: 12, y: 25 }, { x: 14, y: 25 }, { x: 12, y: 24 },
  { x: 14, y: 24 }, { x: 12, y: 23 }, { x: 13, y: 23 }, { x: 14, y: 23 },
];

/** The members of most tests, in the order of the seats they take. */
export const NAMES = ["Alice", "Bob", "Carol"];

/** A message of the table, as JSON. */
export type Frame = Record<string, any>;

const open: Testbed[] = [];
/** Closes every bed opened by `cardBed`: `after(closeBeds)` in each suite. */
export const closeBeds = async (): Promise<void> => {
  await Promise.all(open.splice(0).map((b) => b.close()));
};

/** A testbed with the given plugin folders, the members standing round a deck (the first is the administrator). */
export async function cardBed(plugins: string[], names: string[]): Promise<{ bed: Testbed; members: Member[] }> {
  const bed = await testbed({ plugins, timeoutMs: 8000 });
  open.push(bed);
  const members = [await bed.join(names[0]!, { at: ROUND[0]! })];
  await bed.placeObject("hq-cards/deck", DECK);
  for (const [i, name] of names.slice(1).entries()) members.push(await bed.join(name, { at: ROUND[i + 1]! }));
  return { bed, members };
}

export const frames = (m: Member, from = 0): Frame[] => (m.received(CARDS) as Frame[]).slice(from);
/** How many table messages the member has got so far: a `from` for the readers below. */
export const count = (m: Member): number => m.received(CARDS).length;

/** Sends an action to the deck's table. */
export const act = (m: Member, a: Frame): void => m.send(CARDS, { x: DECK.x, y: DECK.y, ...a });

/** The last message of type `t` the member got (after their `from`-th message). */
export const lastOf = (m: Member, t: string, from = 0): Frame | undefined => frames(m, from).findLast((d) => d.t === t);

/** The table and the whole state of the last open or state message (after the `from`-th message). */
export function tableOf(m: Member, from = 0): { tb: Frame; s: Frame } | undefined {
  const d = frames(m, from).findLast((x) => x.t === "open" || x.t === "state");
  return d ? { tb: d.s.t, s: d.s } : undefined;
}

/** Polls until `fn` returns something truthy; rejects after `ms` naming `what`. Messages arrive on their own: no fixed sleep. */
export async function until<T>(what: string, fn: () => T | undefined | false | null, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline) throw new Error(`timed out after ${ms} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The table, once the last open or state message (after `from`) satisfies `ok(table, state)`. */
export async function waitTable(m: Member, what: string, ok: (tb: Frame, s: Frame) => boolean, from = 0, ms = 8000): Promise<Frame> {
  const r = await until(
    `${m.name}: ${what}`,
    () => {
      const t = tableOf(m, from);
      return t && ok(t.tb, t.s) ? t : undefined;
    },
    ms,
  );
  return r.tb;
}

/** Sends `a`, then waits for the next state of the table the member gets (a refused action sends the real state again). */
export async function stateAfter(m: Member, a: Frame): Promise<{ tb: Frame; s: Frame }> {
  const from = count(m);
  act(m, a);
  return until(`${m.name}: the state again after ${JSON.stringify(a)}`, () => tableOf(m, from));
}

export const handSizes = (tb: Frame): number[] => tb.hands.map((h: unknown[]) => h.length);
export const seatedCount = (tb: Frame): number => tb.seats.filter((s: unknown) => s !== null).length;
export const logVerbs = (m: Member): string[] => (lastOf(m, "log")?.log ?? []).map((e: Frame) => e.v);

/** Every member opens the deck. */
export const openDeck = (...members: Member[]): void => {
  for (const m of members) m.use(DECK);
};

/** The members open the deck, the first chooses `game` once the games are listed, and all take a seat in order. */
export async function seatAll(members: Member[], game: string): Promise<void> {
  const first = members[0]!;
  openDeck(...members);
  await until(`${game} in the games list`, () => lastOf(first, "games")?.list.some((g: Frame) => g.name === game));
  act(first, { t: "choose", game });
  for (const [i, m] of members.entries()) {
    await waitTable(m, `${m.name} sees ${game}`, (tb) => tb.game === game);
    act(m, { t: "seat", seat: i });
  }
  await waitTable(first, "everybody seated", (tb) => seatedCount(tb) === members.length);
}

/** The free table, where anything goes. */
export const freeTable = (members: Member[]): Promise<void> => seatAll(members, "free");

/** No plugin errors, in any plugin. */
export async function noErrors(bed: Testbed): Promise<void> {
  assert.deepEqual(await bed.errors(), {});
}
