// Last Card, server side: a game for the card table of hq-cards. It registers itself with hq-cards (its
// definition, then the rest of its cards: always two parts, the definition with all 108 names would do in
// one, but the split is the path big decks need) on its first update() and again whenever hq-cards
// (re)starts, and answers hq-cards's "count" hook. The rules, the cards and the count are in rules.ts; the
// card art is public/shared/cards.png, drawn by tools/sprite.mjs.

import { count, DEFINITION, type CountArgs } from "./rules.ts";

const FIRST = 64; // cards sent with the definition; the rest follow with registerCards

let started = false;
let busy = false; // a registration is under way
let again = false; // hq-cards restarted meanwhile: register once more when done
let reported = false; // a failure is logged once, until a registration succeeds

type Answer = { ok?: boolean; err?: string } | null;

function failed(why: string): void {
  if (reported) return;
  reported = true;
  hq.log("not registered with hq-cards:", why);
}

async function registerOnce(): Promise<void> {
  const cards = DEFINITION.deck.cards;
  const head = await hq.plugins.call<Answer>("hq-cards", "register", { ...DEFINITION, deck: { ...DEFINITION.deck, cards: cards.slice(0, FIRST) } });
  if (!head?.ok) return failed(head?.err ?? "refused");
  const rest = await hq.plugins.call<Answer>("hq-cards", "registerCards", { from: FIRST, cards: cards.slice(FIRST) });
  if (!rest?.ok) return failed(rest?.err ?? "refused");
  reported = false;
}

/** Registers with hq-cards if it runs; one registration at a time, so the two parts never interleave. */
function register(): void {
  if (!hq.plugins.running("hq-cards")) return;
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  registerOnce()
    .catch((e: unknown) => failed(e instanceof Error ? e.message : String(e)))
    .finally(() => {
      busy = false;
      if (again) {
        again = false;
        register();
      }
    });
}

export function load(): void {
  hq.expose("count", (caller: HQ.Caller, args: CountArgs) => {
    if (caller.plugin !== "hq-cards") throw new Error("only the card table counts");
    return count(args);
  });
}

export function update(): void {
  if (started) return;
  started = true;
  register();
}

export function onPlugins(): void {
  if (started) register(); // before the first update(), that one registers
}
