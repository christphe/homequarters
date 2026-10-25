// Old Maid plugin, server side. A game of the Cards table (hq-cards): it has no map object, no window and no
// state of its own. It registers its definition (rules.ts) through hq-cards's "register" hook, which narrows
// the table to Old Maid's actions, deck and piles, and it answers hq-cards's calls to its "count" hook.
//
// Registering cannot happen in load() (calls between plugins are refused there), and onPlugins() only runs
// when another plugin starts or stops: so it registers on its first update() when hq-cards runs, and again
// whenever hq-cards (re)starts. hq-cards forgets the game when this plugin stops; its tables wait, saved,
// until it registers again.

import { count, DEFINITION, type CountArgs } from "./rules.ts";

const CARDS = "hq-cards";
let started = false; // the first update() ran
let warned = false; // a failed registration was logged; set back once one succeeds

function failed(why: unknown): void {
  if (warned) return;
  warned = true;
  hq.log("not registered with hq-cards:", String(why instanceof Error ? why.message : why).slice(0, 200));
}

function register(): void {
  let answer: Promise<unknown>;
  try {
    answer = hq.plugins.call(CARDS, "register", DEFINITION);
  } catch (e) {
    return failed(e);
  }
  answer
    .then((r) => {
      const a = (typeof r === "object" && r !== null ? r : {}) as { ok?: unknown; err?: unknown };
      if (a.ok === true) warned = false;
      else failed(a.err ?? "refused");
    })
    .catch(failed);
}

const isCard = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const cardList = (v: unknown): v is number[] => Array.isArray(v) && v.length <= 128 && v.every(isCard);

/** The count hook's arguments, checked for shape: hq-cards is trusted, but its shape could change. */
function countArgs(v: unknown): CountArgs {
  const a = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const { seats, hands } = a;
  if (!Array.isArray(seats) || seats.length > 8 || !seats.every((s) => s === null || typeof s === "string")) throw new Error("seats");
  if (!Array.isArray(hands) || hands.length > 8 || !hands.every(cardList)) throw new Error("hands");
  return { seats, hands, piles: [], loose: [] }; // Old Maid's count reads only the hands
}

export function load(): void {
  hq.expose("count", (caller: HQ.Caller, args: unknown) => {
    if (caller.plugin !== CARDS) throw new Error("count is for hq-cards");
    return count(countArgs(args));
  });
}

export function update(): void {
  if (started) return;
  started = true;
  if (hq.plugins.running(CARDS)) register(); // otherwise onPlugins() registers once hq-cards starts
}

/** Another plugin started or stopped. Registers whenever hq-cards runs: running() cannot tell that hq-cards
 * restarted (stopped and started again before this runs), and registering again only replaces the game. */
export function onPlugins(): void {
  if (started && hq.plugins.running(CARDS)) register(); // before the first update(), that update registers
}
