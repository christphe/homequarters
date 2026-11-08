// Cards, Old Maid: the bundled game hq-card-pouilleux (plugins/bundled/hq-card-pouilleux) on the hq-cards table.
// A deck on a table of the map, Ann and Bo at it with the Cards window open; Old Maid turned on by an
// administrator while the choice of a game is open, then an Old Maid table seated and dealt through its buttons.
// Each check names the criterion of docs/superpowers/specs/2026-10-25-plugin-cards-design.md it proves; the
// table itself is plugins/e2e/hq-cards-e2e/cards.ts, whose helpers (lib.ts) this scenario uses.
// Rules and logic are unit-tested, not here: Old Maid's controls, its 49 cards, pairs, offer and count in
// plugins/bundled/hq-card-pouilleux/test/oldMaid.test.ts; through the real server, and turning it off and on, in
// plugins/bundled/hq-card-pouilleux/test/oldMaid.ispec.ts and plugins/bundled/hq-cards/test/cards.ispec.ts.
// It runs against the testbed, without LiveKit (e2e/plugin-run.ts), with hq-cards and hq-card-pouilleux loaded:
// node tools/fdash/cli.ts run test:e2e --pkg hq-card-pouilleux-e2e (after "node tools/fdash/cli.ts run build --pkg
// server --pkg web"). Of its RunContext it uses only adminCookie.
import { check, summary, resetChecks, launch, waitFor, type ElementHandle, type RunContext } from "../../../e2e/lib.ts";
import { PLUGIN, drawn, handOf, logOf, modal, hasButton, press, setPlugin, setDecks, viewFrame, within, twoAtTheTable, noConsoleErrors, type Player } from "../hq-cards-e2e/lib.ts";

const GAME = "hq-card-pouilleux";

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  const users: Player[] = [];
  try {
    // the testbed turns every plugin it loads on: Old Maid off first, so the window opens on a table with no game
    if (!(await setPlugin(ctx, GAME, false)).ok) throw new Error("Old Maid could not be turned off");
    const { ann, bo } = await twoAtTheTable(ctx, browser, String(Date.now() % 10000));
    users.push(ann, bo);
    await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Free table") && !(await modal(ann))?.buttons.some((b) => b.text === "Old Maid"), { what: "the choice, without Old Maid" });

    // ---- criterion 2: the choice of a game follows the game plugins
    await setPlugin(ctx, GAME, true);
    const listed = await within(async () => (await modal(ann))?.buttons.some((b) => b.text === "Old Maid"), 5000);
    check("2: turning Old Maid on adds it to the open window's choice", listed >= 0, `${listed} ms`);
    // (turning it off takes it away: the server's list in oldMaid.ispec.ts "a window showing the choice of a game", the
    // window drawing it in hq-cards/test/client.test.ts)

    // ---- criteria 8 and 9: Old Maid, with its narrowed actions and its count
    await press(ann, "Old Maid");
    await waitFor(() => hasButton(ann, "Seat 1"), { what: "Old Maid's seats" });
    await press(ann, "Seat 1");
    // Bo looks before he clicks: Ann's name in seat 1 widens it and moves seat 2
    await waitFor(async () => (await modal(bo))?.buttons.some((x) => x.text === `Seat 1: ${ann.name}`) && hasButton(bo, "Seat 2"), { what: "seat 2 free for Bo" });
    // Bo's click straddles a rebuild of his controls (Ann counts between his press and his release): it still lands
    {
      const f = (await viewFrame(bo))!;
      const seat2 = await f.evaluateHandle(() => [...document.querySelectorAll<HTMLButtonElement>(".controls button")].find((b) => b.textContent!.trim() === "Seat 2")) as ElementHandle<HTMLButtonElement>;
      await seat2.evaluate((b) => b.scrollIntoView({ block: "center" }));
      const box = (await seat2.boundingBox())!;
      await bo.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await bo.page.mouse.down();
      await press(ann, "Count");
      await waitFor(async () => (await (await viewFrame(bo))!.evaluate(() => [...document.querySelectorAll(".controls p")].some((p) => p.textContent!.startsWith("Count: ")))), { timeout: 3000, what: "Bo's controls rebuilt by the count" });
      await bo.page.mouse.up();
    }
    const straddled = await within(async () => (await drawn(bo))?.seat === 1, 3000);
    check("a click pressed while the controls are rebuilt by somebody else's move still lands (Bo takes seat 2)", straddled >= 0, `${straddled} ms`);
    if (straddled < 0) await press(bo, "Seat 2");
    await waitFor(async () => (await drawn(bo))?.seat === 1, { what: "Bo seated at Old Maid" }).catch(async (e) => {
      throw new Error(e.message + " " + JSON.stringify({ controls: (await modal(bo))?.buttons.slice(0, 10), log: (await logOf(bo)).slice(-3), sent: bo.sent.slice(-3), vp: bo.page.viewport() }));
    });
    // (Old Maid's controls, Deal all and Count but no Deal N, new pile, draw or look: hq-card-pouilleux/test/oldMaid.test.ts)
    await press(ann, "Deal all");
    await waitFor(async () => (await handOf(ann)).length + (await handOf(bo)).length === 49, { what: "Old Maid dealt" });
    // (its 49 cards: oldMaid.test.ts; "Deal all" through its button is what the wait above proves)
    // (Old Maid's pairs, offer, count from its hook, and turning it off and on: oldMaid.test.ts, oldMaid.ispec.ts,
    // cards.ispec.ts; the same controls are checked on the free table and with Last Card)
    // the console stays clean (not a check of its own: the table's scenario has those; this throws, and the
    // scenario then fails with "scenario completed")
    noConsoleErrors(users);
  } catch (e) {
    // what each page showed when it failed (HQ_FAIL_SHOTS: a folder)
    if (process.env.HQ_FAIL_SHOTS) for (const u of users) await u.page.screenshot({ path: `${process.env.HQ_FAIL_SHOTS}/${u.name}.png` }).catch((x) => console.log("no shot of " + u.name + ": " + x));
    check("scenario completed", false, String((e && (e as Error).stack) || e));
  } finally {
    for (const name of [GAME, PLUGIN]) await setPlugin(ctx, name, false).catch(() => {});
    await setDecks(ctx, []).catch(() => {});
    await browser.close();
  }
  return summary();
}
