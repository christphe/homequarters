// The bundled Last Card game (hq-card-lastcard) on the card table (hq-cards) through the real server (testbed).
// It registers its 108 cards in two parts (64, then 44) and counts the points left in each hand.
// Run: node --test "plugins/bundled/hq-card-lastcard/test/*.ispec.ts" (needs bin/homequarters[.exe] or HQ_BIN).
import assert from "node:assert/strict";
import path from "node:path";
import { after, test } from "node:test";
import { NAMES, act, cardBed, cardsDir, closeBeds, handSizes, lastOf, noErrors, seatedCount, until, openDeck, waitTable } from "../../hq-cards/test/harness.ts";
import type { Frame } from "../../hq-cards/test/harness.ts";

after(closeBeds);

const LAST_CARD = "hq-card-lastcard";

/** The count text Last Card should give for a table: numbers their face value, Skip, Reverse and Draw Two 20, both wilds 50 (cards 100-107); card n of a colour is at n % 25. */
function expectedCount(tb: Frame): string {
  const value = (n: number): number => {
    if (n >= 100) return 50;
    const i = n % 25;
    if (i === 0) return 0;
    return i <= 18 ? (i + 1) >> 1 : 20;
  };
  const parts: string[] = [];
  for (const [i, s] of tb.seats.entries()) {
    if (s === null) continue;
    const sum = (tb.hands[i] as number[]).reduce((a, c) => a + value(c & ~128), 0);
    parts.push(`${s.name} ${sum}`);
  }
  return parts.join(", ");
}

test("Last Card registers in two parts, its table deals and counts", async () => {
  const { bed, members: [alice, bob, carol] } = await cardBed([cardsDir, path.resolve(import.meta.dirname, "..")], NAMES);
  // registration is asynchronous: the open window is told when the game arrives
  openDeck(alice!);
  await until("Last Card in the game list", () => (lastOf(alice!, "games")?.list as Frame[] | undefined)?.some((g) => g.name === LAST_CARD && g.title === "Last Card"));
  openDeck(bob!, carol!);
  act(alice!, { t: "choose", game: LAST_CARD });
  const g = (await until("the game message", () => lastOf(alice!, "game"))).g;
  const deck = g.deck;
  assert.ok(deck.names.length === 108 && deck.names[0] === "Red 0" && deck.names[107] === "Wild Draw Four", `108 names, from Red 0 to Wild Draw Four: ${deck.names.length}`);
  assert.ok(deck.plugin === LAST_CARD && deck.sheet === "shared/cards.png" && deck.back === 108, `the deck is the game's own sheet: ${JSON.stringify({ ...deck, names: undefined })}`);
  for (const n of deck.names as string[]) assert.ok(!n.toLowerCase().includes("uno"), `a card named after the trademarked game: ${n}`);

  for (const [i, m] of [alice!, bob!, carol!].entries()) {
    await waitTable(m, `${m.name} sees Last Card`, (tb) => tb.game === LAST_CARD);
    act(m, { t: "seat", seat: i });
  }
  let tb = await waitTable(alice!, "three seated", (t) => seatedCount(t) === 3);
  assert.ok(
    tb.piles.length === 2 && tb.piles[0].name === "Draw" && tb.piles[1].name === "Discard",
    `the starting piles are Draw and Discard: ${JSON.stringify(tb.piles)}`,
  );

  act(alice!, { t: "deal", pile: "p0", n: 7 });
  tb = await waitTable(alice!, "seven each", (t) => handSizes(t)[2] === 7);
  assert.deepEqual(handSizes(tb).slice(0, 3), [7, 7, 7]);
  const want = expectedCount(tb);

  act(bob!, { t: "count" });
  tb = await waitTable(alice!, "the count", (t) => t.count !== "");
  assert.equal(tb.count, want, "the count comes from the game's hook");

  // dealAll is not among Last Card's actions: nothing changes
  const before = handSizes(tb);
  act(alice!, { t: "dealAll", pile: "p0" });
  act(alice!, { t: "draw", pile: "p0" }); // allowed: proves the dealAll was handled first
  tb = await waitTable(alice!, "Alice's draw", (t) => handSizes(t)[0] === before[0]! + 1);
  assert.ok(handSizes(tb)[1] === before[1] && handSizes(tb)[2] === before[2], `dealAll is refused: before ${JSON.stringify(before)}, after ${JSON.stringify(handSizes(tb))}`);
  await noErrors(bed);
});
