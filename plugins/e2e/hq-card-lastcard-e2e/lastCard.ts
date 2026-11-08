// Cards, Last Card: the bundled game hq-card-lastcard (plugins/bundled/hq-card-lastcard) on the hq-cards table, a
// game with its own cards. A deck on a table of the map, Ann and Bo at it with the Cards window open; Last Card
// chosen, seated, dealt and played through the real controls, then turned off and on by an administrator.
// Each check names the criterion of docs/superpowers/specs/2026-10-25-plugin-cards-design.md it proves; the
// table itself is plugins/e2e/hq-cards-e2e/cards.ts, whose helpers (lib.ts) this scenario uses.
// Rules and logic are unit-tested, not here: Last Card's rules in plugins/bundled/hq-card-lastcard/test/lastCard.test.ts,
// its count through the real server in plugins/bundled/hq-card-lastcard/test/lastCard.ispec.ts.
// It runs against the testbed, without LiveKit (e2e/plugin-run.ts), with hq-cards and hq-card-lastcard loaded:
// node tools/fdash/cli.ts run test:e2e --pkg hq-card-lastcard-e2e (after "node tools/fdash/cli.ts run build --pkg
// server --pkg web"). Of its RunContext it uses only adminCookie.
import { check, summary, resetChecks, launch, waitFor, sleep, type RunContext } from "../../../e2e/lib.ts";
import {
  PLUGIN, drawn, handOf, logOf, modal, hasButton, press, setPlugin, setDecks, drag, handAt, pileAt, openWithX, within, twoAtTheTable, noConsoleErrors, type Player,
} from "../hq-cards-e2e/lib.ts";

const GAME = "hq-card-lastcard";

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  const users: Player[] = [];
  try {
    // the testbed turns Last Card on as it loads it: the window opens on the choice of a game, Last Card in it
    if (!(await setPlugin(ctx, GAME, true)).ok) throw new Error("Last Card could not be turned on");
    const { ann, bo } = await twoAtTheTable(ctx, browser, String(Date.now() % 10000));
    users.push(ann, bo);

    // ---- criterion 10b: Last Card, a game with its own cards
    await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Last Card"), { timeout: 5000, what: "Last Card offered" });
    await press(ann, "Last Card");
    // a game with its own cards starts each window's view afresh (its security policy then admits the game's images)
    const renewed = await Promise.all([ann, bo].map((u) => within(async () => (await drawn(u))?.sheet === "loaded" && (await hasButton(u, "Seat 1")), 5000)));
    check("10b: on choosing Last Card, every open window's view renews and loads the game's own sheet (shared/cards.png)", renewed.every((ms) => ms >= 0), JSON.stringify(renewed));
    // a click right after the views renew was once lost (2026-10-26, no seat message sent): pressed again
    // until the seat is taken, and the number of presses reported
    let annPresses = 0;
    const annSeated = await waitFor(async () => {
      if ((await drawn(ann))?.seat === 0) return true;
      if (annPresses < 3) { annPresses++; await press(ann, "Seat 1").catch(() => {}); }
      await sleep(700);
      return false;
    }, { timeout: 8000, what: "Ann seated at Last Card" }).catch(() => false);
    check("10b: Ann takes seat 1 at Last Card through its button", annSeated === true, `${annPresses} press(es)`);
    const nAnn = ann.sent.length;
    await waitFor(async () => (await modal(bo))?.buttons.some((x) => x.text === `Seat 1: ${ann.name}`) && hasButton(bo, "Seat 2"), { what: "seat 2 for Bo" }).catch(async (e: Error) => {
      throw new Error(e.message + " " + JSON.stringify({ annSent: ann.sent.slice(nAnn - 2), ann: (await modal(ann))?.buttons.slice(0, 4), bo: (await modal(bo))?.buttons.slice(0, 4), log: (await logOf(bo)).slice(-2) }));
    });
    const nSeat = bo.sent.length;
    await press(bo, "Seat 2");
    await waitFor(async () => (await drawn(bo))?.seat === 1, { what: "Bo seated at Last Card" }).catch(async (e: Error) => {
      throw new Error(e.message + " " + JSON.stringify({ sent: bo.sent.slice(nSeat), frames: (await bo.page.$$("iframe.plugin-view")).length, log: (await logOf(bo)).slice(-3), seat: (await drawn(bo))?.seat }));
    });
    await press(ann, "Deal");
    await waitFor(async () => (await handOf(ann)).length === 7 && (await handOf(bo)).length === 7, { what: "Last Card dealt" });
    await drag(ann, await handAt(ann, 0), pileAt([190, 90]));
    const lcLog = await waitFor(async () => (await logOf(bo)).find((l) => l.startsWith(`${ann.name} put the`) && l.endsWith("on Discard")) ?? null, { timeout: 3000, what: "a Last Card play" });
    check("10b: a card played on Discard is named in the log with its own name", /put the (Red|Yellow|Green|Blue|Wild)/.test(lcLog), lcLog);
    // (Last Card's count, through the real server: lastCard.ispec.ts; the Count button and its text: the Old Maid and table scenarios)
    // turned off and on with the window open: the page learns of the plugin after the game is back, and the
    // view must still end up drawing the game's own sheet
    await setPlugin(ctx, GAME, false);
    // (a game turned off: its table offers only Reset, hq-cards/test/client.test.ts; the server marking it unavailable, cards.ispec.ts)
    await waitFor(async () => (await modal(ann))!.texts.some((x) => x.startsWith("This game is not available")), { timeout: 5000, what: "the game off in Ann's window" });
    // the window opened again while the game is off: its view starts without the game's images allowed
    await press(ann, "Close");
    await openWithX(ann);
    await setPlugin(ctx, GAME, true);
    const again = await within(async () => (await drawn(ann))?.sheet === "loaded" && (await handOf(ann)).length === 6, 20000); // a plugin turned on under load can take seconds to register
    const inWindow = await (await (await ann.page.$('iframe.plugin-frame[data-plugin="hq-cards"]'))?.contentFrame())?.evaluate(() => (globalThis as unknown as { __cards?: () => unknown }).__cards?.()).catch((x) => String(x));
    check("10b: Last Card off, the window opened, Last Card on: its cards come back drawn from its sheet", again >= 0, `${again} ms, sheet ${(await drawn(ann))?.sheet} ` + JSON.stringify({ inWindow, modal: await modal(ann), hand: (await handOf(ann)).length, seat: (await drawn(ann))?.seat }));
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
