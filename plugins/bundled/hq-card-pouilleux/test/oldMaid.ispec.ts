// The bundled Old Maid game (hq-card-pouilleux) on the card table (hq-cards) through the real server (testbed).
// Run: node tools/fdash/cli.ts run test:integration --pkg hq-card-pouilleux (needs bin/homequarters[.exe] or HQ_BIN).
import assert from "node:assert/strict";
import path from "node:path";
import { afterAll, test } from "vitest";
import { CARDS, NAMES, act, cardBed, cardsDir, closeBeds, count, handSizes, lastOf, logVerbs, noErrors, seatAll, stateAfter, tableOf, until, openDeck, waitTable } from "../../hq-cards/test/harness.ts";
import type { Frame } from "../../hq-cards/test/harness.ts";

afterAll(closeBeds);

const OLD_MAID = "hq-card-pouilleux";
const dirs = [cardsDir, path.resolve(import.meta.dirname, "..")];

/** The parts of hq-cards' table and game messages this test reads. */
type Table = { piles: { cards: number[] }[] };
type Game = { title: string; deck: { standard: string[] } };

/** Whether the last "games" message after the `from`-th one lists Old Maid. */
const listsOldMaid = (m: Parameters<typeof lastOf>[0], from = 0): boolean => {
  const list = lastOf(m, "games", from)?.list as Frame[] | undefined;
  return !!list?.some((g) => g.name === OLD_MAID && g.title === "Old Maid");
};

// The catalog starts hq-card-pouilleux before hq-cards; the second order is Old Maid started when the table already runs.
for (const order of ["Old Maid, then the table", "the table, then Old Maid"]) {
  test(`Old Maid registers with the table, off and on again (${order})`, async () => {
    const { bed, members: [alice, bob] } = await cardBed(dirs, NAMES);
    if (order.startsWith("the table")) {
      await bed.setPlugin(OLD_MAID, false);
      await bed.setPlugin(OLD_MAID, true);
    }
    openDeck(alice);
    await until("Old Maid listed", () => listsOldMaid(alice));

    // the table restarted: its games are gone with it until Old Maid registers again
    await bed.setPlugin(CARDS, false);
    await bed.setPlugin(CARDS, true);
    let from = count(alice);
    openDeck(alice);
    await until("Old Maid listed after hq-cards restarted", () => listsOldMaid(alice, from));

    // a game in progress while Old Maid is off: unavailable, only reset acts; back intact when it returns
    await seatAll([alice, bob], OLD_MAID);
    act(alice, { t: "dealAll", pile: "p0" });
    const dealt = await waitTable(alice, "the deal", (t) => handSizes(t)[0] > 0);
    const hands = JSON.stringify(dealt.hands);
    await bed.setPlugin(OLD_MAID, false);
    await waitTable(alice, "the table unavailable", (_, s) => s.unavailable === true);
    for (const msg of [
      { t: "place", from: { k: "hand", i: 0 }, to: { k: "pile", id: "p1" }, up: true },
      { t: "offer", to: 1 },
      { t: "gather" },
    ]) {
      const { tb, s } = await stateAfter(alice, msg);
      assert.ok(JSON.stringify(tb.hands) === hands && tb.offer == null && s.unavailable === true, `${msg.t} acted on an unavailable table: hands ${JSON.stringify(tb.hands)}, offer ${JSON.stringify(tb.offer)}`);
    }
    from = count(alice);
    await bed.setPlugin(OLD_MAID, true);
    const back = await waitTable(alice, "the table available again", (_, s) => s.unavailable === false, from);
    assert.ok(JSON.stringify(back.hands) === hands && back.game === OLD_MAID, `the table comes back intact: game ${back.game}, hands ${JSON.stringify(back.hands)}, was ${hands}`);
    // the same place now acts, so the refusals above were not about its shape
    act(alice, { t: "place", from: { k: "hand", i: 0 }, to: { k: "pile", id: "p1" }, up: true });
    await waitTable(alice, "a card on Pairs", (t) => (t as Table).piles[1].cards.length === 1);

    // reset still works on an unavailable table, for a present seated player
    from = count(alice);
    await bed.setPlugin(OLD_MAID, false);
    await waitTable(alice, "unavailable again", (_, s) => s.unavailable === true, from);
    act(bob, { t: "reset" });
    await waitTable(alice, "the table reset", (t, s) => t.game === null && s.unavailable === false);
    await noErrors(bed);
  });
}

test("Old Maid: the page is told the game, unlisted actions change nothing, a deal, the count", async () => {
  const { bed, members: [alice, bob, carol] } = await cardBed(dirs, NAMES);
  await seatAll([alice, bob, carol], OLD_MAID);
  const g = lastOf(alice, "game")?.g as Game | undefined;
  assert.ok(g?.title === "Old Maid" && g.deck.standard.length === 49, `the page is told Old Maid and its 49 cards: ${JSON.stringify(g)}`);

  // actions Old Maid leaves out change nothing
  const before = tableOf(alice)!.tb;
  for (const msg of [{ t: "draw", pile: "p0" }, { t: "newPile", name: "Mine", face: "up", at: [20, 20] }, { t: "deal", pile: "p0", n: 1 }]) {
    const { tb } = await stateAfter(alice, msg);
    assert.deepEqual(tb, before, `${msg.t} changed the table`);
  }

  // Alice deals from seat 0. hq-cards deals one card at a time round the seated players starting after the
  // dealer (seats 1, 2, then 0): 16 full rounds give 48 cards, the 49th goes to seat 1. Seats 3 to 5 of the
  // six are empty.
  act(alice, { t: "dealAll", pile: "p0" });
  const tb = await waitTable(alice, "the deal", (t) => handSizes(t)[1] > 0);
  assert.deepEqual(handSizes(tb), [16, 17, 16, 0, 0, 0], "hands after dealing all");

  act(bob, { t: "count" });
  const counted = await waitTable(carol, "the count", (t) => t.count !== "");
  assert.equal(counted.count, "49 cards left: Alice 16, Bob 17, Carol 16", "the count comes from Old Maid's hook");
  await until("the count logged", () => logVerbs(carol).includes("counted"));
  await noErrors(bed);
});

test("a window showing the choice of a game: Old Maid turned off leaves its list, turned on comes back", async () => {
  const { bed, members: [alice] } = await cardBed(dirs, NAMES);
  openDeck(alice);
  await until("Old Maid listed", () => listsOldMaid(alice));
  let from = count(alice);
  await bed.setPlugin(OLD_MAID, false);
  await until("Old Maid taken out of the open window's list", () => !!lastOf(alice, "games", from) && !listsOldMaid(alice, from));
  from = count(alice);
  await bed.setPlugin(OLD_MAID, true);
  await until("Old Maid back in the open window's list", () => listsOldMaid(alice, from));
  await noErrors(bed);
});
