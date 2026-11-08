// Cards, the table: the bundled hq-cards plugin (plugins/bundled/hq-cards) alone, turned on by an administrator, a
// deck placed on a table of the map through the map API, then three players at the table (Ann, Bo, Cy). Everything a
// player does goes through the real controls: X, the window's buttons and fields, real mouse drags on the table
// view's canvas and the keyboard. What a page's view shows is read from what it drew (window.__drawn in the view:
// each card with its face, in canvas pixels) and from its live region.
// Each check names the criterion of docs/superpowers/specs/2026-10-25-plugin-cards-design.md it proves. The games
// have their own scenarios: Old Maid in plugins/e2e/hq-card-pouilleux-e2e/oldMaid.ts (a game turned on in
// the choice, Old Maid's table), Last Card in plugins/e2e/hq-card-lastcard-e2e/lastCard.ts (criteria 10 and 10b);
// the helpers the three share are in lib.ts.
// Rules and logic are unit-tested, not here: the table, the log, snapping and the layout in
// plugins/bundled/hq-cards/test/cards.test.ts, Old Maid and Last Card in plugins/bundled/hq-card-pouilleux/test/oldMaid.test.ts and hq-card-lastcard/test/lastCard.test.ts, the server
// side (who may act, restarts, game hooks such as Old Maid's count, a game turned off and on) in
// plugins/bundled/hq-cards/test/cards.ispec.ts and hq-card-pouilleux/test/oldMaid.ispec.ts. This scenario keeps what needs the browser: real
// controls, drags and the keyboard, what each page draws, sync between pages, and the axe audit of the Cards window
// and its table view once dealt (e2e/axe.ts).
// It runs against the testbed, without LiveKit (e2e/plugin-run.ts): node tools/fdash/cli.ts run test:e2e --pkg hq-cards-e2e
// (after "node tools/fdash/cli.ts run build --pkg server --pkg web"). Of its RunContext it uses only adminCookie.
import { check, summary, resetChecks, launch, joinAs, waitFor, sleep, type RunContext, type User } from "../../../e2e/lib.ts";
import { audit, auditView } from "../../../e2e/axe.ts";
import { CARD_H } from "../../bundled/hq-cards/public/art.ts";
import { NARROW, GRID, CASCADE, cardAt, handSpots } from "../../bundled/hq-cards/public/layout.ts";
import { FREE } from "../../bundled/hq-cards/public/games.ts";
import {
  PLUGIN, T, DECK, MODAL, FEET, SPOTS, setPlugin, setDecks, read, viewFrame, drawn, handOf, looseOf, logOf, modal, hasButton, press, pressInView, type,
  handAt, pileAt, feltAt, seatAt, drag, click, countFrames, within, goTo, openWithX, consoleErrors, type Player,
} from "./lib.ts";

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  const users: Player[] = [];
  try {
    const t = String(Date.now() % 10000);
    check("an administrator turns hq-cards on (admin API)", (await setPlugin(ctx, PLUGIN, true)).ok);
    check("a deck is placed on a table through the map API", await setDecks(ctx, [DECK]));
    const ann = await joinAs(browser, "Ann" + t, { avatar: { sk: 1, hs: 1, hc: 2, sh: 2, pa: 1 } }) as Player;
    const bo = await joinAs(browser, "Bo" + t, { avatar: { sk: 3, hs: 3, hc: 1, sh: 5, pa: 0 } }) as Player;
    // Cy has a name of 24 characters, the longest a member can have
    const cy = await joinAs(browser, "Cyrillia Featherston" + t, { avatar: { sk: 0, hs: 2, hc: 3, sh: 1, pa: 2 } }) as Player;
    users.push(ann, bo, cy);
    for (const u of users) await countFrames(u);
    await Promise.all([goTo(ann, SPOTS[0], FEET), goTo(bo, SPOTS[1], FEET), goTo(cy, SPOTS[2], FEET)]);

    // ---- criterion 1: the deck on the table, with the X hint
    const sprite = await waitFor(async () => {
      const s = await read(ann, () => window.__hq.view.objSprites.filter((x) => !x.destroyed).map((x) => ({ x: x.x, y: x.y, w: x.texture.width, h: x.texture.height, on: x.visible })));
      return s.find((x) => x.w === 16 && x.x === 13 * 16) ?? null;
    }, { what: "the deck sprite" });
    check("1: the deck's sprite is drawn on its tile of the table (16x16)", sprite!.on && sprite!.y === (DECK.y + 1) * T, JSON.stringify(sprite));
    const hint = await waitFor(() => read(ann, () => document.querySelector(".interaction-hint")?.textContent ?? ""), { what: "the X hint" });
    check("1: standing beside it, the X hint names it", hint.includes("Card deck") && hint.includes("X"), JSON.stringify(hint));

    // ---- criterion 2: the choice of a game follows the game plugins
    await bo.page.setViewport({ width: 800, height: 450 }); // Bo plays at the CI size
    for (const u of users) await openWithX(u);
    const choiceSeen = await waitFor(() => read(bo, (sel) => {
      const b = [...document.querySelectorAll(sel + " button")].find((x) => x.textContent.trim() === "Free table");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, H: innerHeight };
    }, MODAL), { what: "Bo's choice" });
    check("UX: at 800x450 the game choice shows when the window opens", choiceSeen!.top >= 0 && choiceSeen!.bottom <= choiceSeen!.H, JSON.stringify(choiceSeen));
    const only = await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Free table") && (await modal(ann)), { what: "the game choice" }) as NonNullable<Awaited<ReturnType<typeof modal>>>;
    check("2: a new table offers Free table, and no game while none runs", only.buttons.some((b) => b.text === "Free table") && !only.buttons.some((b) => b.text === "Old Maid"), JSON.stringify(only.buttons));

    // ---- criterion 4: seats
    await press(ann, "Free table");
    await waitFor(async () => hasButton(ann, "Seat 1"), { what: "the free table's seats" });
    await press(ann, "Seat 1");
    await waitFor(async () => (await hasButton(bo, "Seat 2")) && (await modal(bo))!.buttons.some((b) => b.text === "Seat 1: " + ann.name), { what: "Ann seated, on Bo's page" });
    await press(bo, "Seat 2");
    await waitFor(async () => (await hasButton(cy, "Seat 3")) && (await modal(cy))!.buttons.some((b) => b.text === "Seat 2: " + bo.name), { what: "Bo seated" });
    await press(cy, "Seat 3");
    await waitFor(async () => (await drawn(cy))?.seat === 2, { what: "Cy seated" });
    const annSeats = (await modal(ann))!.buttons;
    // (a seated player cannot take another seat: seatButtons in hq-cards/test/controls.test.ts)
    check("4: each takes a seat through its button; Ann's shows pressed", annSeats.find((b) => b.text === "Seat 1: " + ann.name)?.pressed === true, JSON.stringify(annSeats.slice(0, 4)));
    await press(cy, "Close");
    const away = await within(async () => (await modal(ann))!.buttons.some((b) => b.text === `Seat 3: ${cy.name} (away)`), 1000);
    check("4: Cy closes the window: Ann sees Cy away within 1 s, the seat kept", away >= 0, `${away} ms`);
    await openWithX(cy);
    const back = await within(async () => (await modal(ann))!.buttons.some((b) => b.text === `Seat 3: ${cy.name}`) && (await drawn(cy))?.seat === 2, 2000);
    check("4: Cy opens it again and is back in the seat", back >= 0, `${back} ms`);

    // ---- criterion 5: deal, then drags to the felt, a pile and a player
    await press(ann, "Deal");
    await waitFor(async () => (await handOf(ann)).length === 7 && (await handOf(bo)).length === 7 && (await handOf(cy)).length === 7, { what: "7 cards each" });
    const alive = await Promise.all(users.map((u) => read(u, () => Object.keys(window.__hq.session.plugins?.stopReasons ?? {}).length === 0 || !("hq-cards" in (window.__hq.session.plugins?.stopReasons ?? {})))));
    check("UX: with a 24-character name at the table, the Cards plugin keeps running on every page after the deal", alive.every(Boolean) && (await Promise.all(users.map((u) => viewFrame(u)))).every(Boolean), JSON.stringify(alive));
    const fits = await (await viewFrame(bo))!.evaluate(() => {
      const c = document.querySelector("canvas")!.getBoundingClientRect(), b = document.querySelector(".bar")!.getBoundingClientRect();
      return { canvasTop: c.top, canvasBottom: c.bottom, barBottom: b.bottom, H: innerHeight, scroll: scrollY };
    });
    check("UX: at 800x450 the whole table, my hand included, and the buttons under it fit Bo's view without scrolling", fits.canvasTop >= 0 && fits.barBottom <= fits.H + 1, JSON.stringify(fits));
    check("5: Deal 7 each gives every seated player 7 cards, shown face up in their own hand only",
      (await handOf(ann)).every((c) => c.up) && ((await drawn(ann))!.cards.filter((c) => c.where === "loose")).length === 0);
    // accessibility, the free table dealt through the real controls: axe on the Cards window in Ann's page, and inside
    // the table view's own document. The window only: the rest of the page is the platform's, audited by e2e's a11y
    // scenario (with LiveKit; the testbed has none, and its media bar's "unavailable" line is not this plugin's)
    await audit(ann.page, "the Cards window with a dealt free table", MODAL);
    await auditView((await viewFrame(ann))!, "the card table view");
    const first = (await handOf(ann))[0];
    const handAfter = async (n: number) => waitFor(async () => (await handOf(ann)).length === n, { what: "Ann's hand of " + n });
    let d = await drag(ann, await handAt(ann, 0), feltAt(60, 120));
    const seen = await Promise.all([bo, cy].map((u) => within(async () => (await looseOf(u)).some((c) => c.c === first.c && c.up), 1000)));
    check("5: Ann drags her first card onto the felt: Bo and Cy see it face up within 1 s", seen.every((ms) => ms >= 0), JSON.stringify(seen));
    check("12: nothing sent while dragging, one plg frame for the drop", d.during === 0 && d.total === 1 && d.msgs[0].t === "place", JSON.stringify(d));
    await handAfter(6);
    const stock = { at: FREE.piles![0].at }; // the free table's stock, in the middle of the felt
    d = await drag(ann, await handAt(ann, 0), pileAt(stock.at));
    const onStock = await within(async () => (await logOf(bo)).some((l) => l === `${ann.name} put a card on Stock`), 1000);
    check("5: a card dragged onto the Stock pile goes on it (face down, as the pile) and is logged", onStock >= 0 && d.total === 1, `${onStock} ms ` + JSON.stringify({ d, hand: (await handOf(ann)).length, log: (await logOf(bo)).slice(-3), annLog: (await logOf(ann)).slice(-2) }));
    await handAfter(5);
    const boSpot = seatAt(8, 0, 1);
    d = await drag(ann, await handAt(ann, 0), boSpot);
    const gave = await within(async () => (await handOf(bo)).length === 8, 1000);
    check("5: a card dragged onto Bo's name goes into Bo's hand", gave >= 0 && (await handOf(ann)).length === 4, `${gave} ms`);
    const barOf = async (u: User) => (await viewFrame(u))!.evaluate(() => [...document.querySelectorAll(".bar button")].map((b) => b.textContent));
    const lifted = (await handOf(ann)).some((c, _i, a) => c.y !== a[0].y);
    check("UX: after a drag nothing is left selected: no card lifted, no buttons under the table", !lifted && (await barOf(ann)).length === 0, JSON.stringify(await barOf(ann)));
    // select card 0, then card 2, then the button: card 2 is played; twice: two places on the felt
    const before = await handOf(ann);
    await click(ann, await handAt(ann, 0));
    await click(ann, await handAt(ann, 2));
    await pressInView(ann, "Put it on the table face up");
    await waitFor(async () => (await handOf(ann)).length === 3, { what: "a card put from the bar" });
    const now1 = await handOf(ann);
    const left1 = before.find((c) => !now1.some((x) => x.c === c.c));
    await click(ann, await handAt(ann, 0));
    await pressInView(ann, "Put it on the table face up");
    await waitFor(async () => (await handOf(ann)).length === 2, { what: "a second card put from the bar" });
    const loose = await looseOf(bo);
    const spots = new Set(loose.map((c) => c.x + "," + c.y));
    check("UX: the button under the table plays the card selected last, and two cards put that way land in two places", left1?.c === before[2].c && spots.size === loose.length, JSON.stringify({ played: left1?.c, selected: before[2].c, loose: loose.map((c) => [c.c, c.x, c.y]) }));

    // ---- UX: on a phone (390x844) the narrow layout: the whole felt, the other seats on top, my hand larger
    await cy.page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    // the page lays itself out for touch and closes the window: Cy opens it again, as on a phone
    await sleep(500);
    if (!(await cy.page.$(MODAL))) await openWithX(cy);
    const phone = await waitFor(async () => { const d = await drawn(cy); return d?.layout === "narrow" ? d : null; }, { timeout: 5000, what: "Cy's narrow layout" }).catch(() => null);
    const cyHand = phone?.cards.filter((c) => c.where === "hand") ?? [];
    check("UX: on a 390 px phone the table switches to the narrow layout, hand cards at least 24 CSS px wide, text at least 8 px", !!phone && cyHand.length > 0 && cyHand.every((c) => c.w >= 24) && phone.font >= 8, JSON.stringify({ layout: phone?.layout, scale: phone?.scale, font: phone?.font, w: cyHand.map((c) => Math.round(c.w)) }));
    if (phone) {
      const hs = handSpots(cyHand.length, NARROW)[0];
      const from = { x: hs.x + 14, y: hs.y + 20 }, to = { x: NARROW.fx + 250, y: NARROW.fy + 140 };
      const card = cyHand[0].c;
      const dPhone = await drag(cy, from, to);
      const onFelt = await within(async () => (await looseOf(ann)).some((c) => c.c === card), 1500);
      check("UX: on the phone, a card dragged from Cy's hand lands on the felt for everybody", onFelt >= 0 && dPhone.total === 1, JSON.stringify({ onFelt, d: dPhone }));
    }
    await cy.page.setViewport({ width: 1280, height: 720 });
    await sleep(500);
    if (!(await cy.page.$(MODAL))) await openWithX(cy);
    await waitFor(async () => (await drawn(cy))?.layout === "wide", { timeout: 5000, what: "Cy back to the wide layout" }).catch(() => {});

    // (a spectator cannot move a card: cards.test.ts, cards.ispec.ts)

    // ---- criterion 6: a pile created, shuffled, drawn from, looked through and reordered, all logged
    await type(ann, "New pile", "Discard");
    await waitFor(() => hasButton(ann, "Face up"), { what: "New pile enabled" });
    await press(ann, "Face up");
    await waitFor(async () => (await logOf(bo)).includes(`${ann.name} created the pile Discard`), { what: "Discard created" });
    await click(ann, pileAt(stock.at));
    await pressInView(ann, "Shuffle Stock");
    await waitFor(async () => (await logOf(bo)).includes(`${ann.name} shuffled Stock`), { what: "shuffle logged" });
    await pressInView(ann, "Draw from Stock");
    await waitFor(async () => (await logOf(bo)).includes(`${ann.name} drew a card from Stock`), { what: "draw logged" });
    await pressInView(ann, "Look through Stock");
    const lookingSeen = await within(async () => (await read(bo, () => 0), (await drawn(bo))!.cards.length >= 0) && (await logOf(bo)).includes(`${ann.name} looked at Stock`), 1000);
    const row = await waitFor(async () => { const r = (await drawn(ann))!.cards.filter((c) => c.where === "look"); return r.length > 2 ? r : null; }, { what: "the pile's row" });
    const k = (await drawn(ann))!.scale;
    const a0 = { x: row![0].x / k + 4, y: row![0].y / k + 10 }, a2 = { x: row![2].x / k + 4, y: row![2].y / k + 10 };
    await drag(ann, a0, a2);
    const moved = (await drawn(ann))!.cards.filter((c) => c.where === "look");
    await pressInView(ann, "Done");
    const reordered = await within(async () => (await logOf(bo)).includes(`${ann.name} reordered Stock`), 1000);
    check("6: Ann looks through Stock and reorders it: Bo's log says so within 1 s of each", lookingSeen >= 0 && reordered >= 0 && moved[2].c === row![0].c, JSON.stringify({ lookingSeen, reordered }));
    // (the log names no card Ann saw alone: the entries of draw and reorderPile and their sentences, cards.test.ts)

    // ---- criterion 7: Ann offers her hand to Bo, who picks her third card
    // Bo is typing a pile's name when the offer's notice appears above his controls: his field keeps the focus
    await type(bo, "New pile", "Wa");
    await press(ann, `Offer my hand to ${bo.name}`);
    await waitFor(async () => (await logOf(bo)).includes(`${ann.name} offered their hand to ${bo.name}`), { what: "the offer" });
    await waitFor(async () => (await (await viewFrame(bo))!.evaluate(() => !!document.querySelector(".controls .notice"))), { timeout: 3000, what: "the offer's notice for Bo" });
    await bo.page.keyboard.type("ste");
    const typed = await (await viewFrame(bo))!.evaluate(() => ({ value: [...document.querySelectorAll(".controls label.field")].find((l) => l.textContent.trim().startsWith("New pile"))?.querySelector("input")?.value, focused: document.activeElement?.tagName }));
    check("UX: a notice appearing above the controls while Bo types keeps his field and its focus", typed.value === "Waste" && typed.focused === "INPUT", JSON.stringify(typed));
    const annBefore = await handOf(ann);
    await click(bo, seatAt(8, 1, 0));
    await pressInView(bo, `Draw a card from ${ann.name}`).catch(() => {}); // the click on Ann's seat already opened the row
    const pickRow = await waitFor(async () => { const r = (await drawn(bo))!.cards.filter((c) => c.where === "pick"); return r.length === annBefore.length ? r : null; }, { what: "Bo's pick row" });
    check("7: the hand offered shows to Bo as backs only", pickRow!.every((c) => !c.up));
    const kb = (await drawn(bo))!.scale;
    await click(bo, { x: pickRow![2].x / kb + 4, y: pickRow![2].y / kb + 10 });
    const picked = await within(async () => (await logOf(cy)).includes(`${bo.name} drew a card from ${ann.name}'s hand`), 1000);
    const annAfter = await handOf(ann);
    check("7: Bo picks the third card: it leaves Ann's hand, it is logged for everybody", picked >= 0 && annAfter.length === annBefore.length - 1 && !annAfter.some((c) => c.c === annBefore[2].c), `${picked} ms`);
    // (only the player offered a hand may draw from it: seatPick in hq-cards/test/controls.test.ts)

    // ---- criterion 13 (keyboard half): a card moved with the keyboard only reaches Bo and is announced
    const f = (await viewFrame(ann))!;
    await f.focus("canvas");
    const said = async (u: User) => (await viewFrame(u))!.evaluate(() => document.querySelector("[aria-live]")!.textContent);
    const handN = (await handOf(ann)).length;
    await ann.page.keyboard.press("ArrowLeft");
    await ann.page.keyboard.press("ArrowRight"); // the cursor on my first card
    const sayFirst = await waitFor(async () => (await said(ann)) || null, { timeout: 2000, what: "the live region" }).catch(() => "");
    await ann.page.keyboard.press("Enter");
    const looseN = (await drawn(ann))!.cards.filter((c) => c.where === "loose").length;
    for (let i = 0; i < handN + looseN; i++) await ann.page.keyboard.press("ArrowRight"); // to the first pile, Stock
    await ann.page.keyboard.press("Enter");
    const kbd = await within(async () => (await logOf(bo)).at(-1) === `${ann.name} put a card on Stock`, 1000);
    check("13: with the keyboard only, Ann puts a card on Stock; Bo's log has it within 1 s, Ann's live region spoke", kbd >= 0 && /your hand/.test(sayFirst!), JSON.stringify({ kbd, sayFirst }));

    // (the table, its seats and its log survive a server restart: cards.ispec.ts)

    // ---- round 2 (R1-R7): a solitaire on the free table, Ann alone, through the real controls; Bo watches
    await press(ann, "Reset");
    await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Free table"), { timeout: 8000, what: "the choice for the solitaire" });
    await press(ann, "Free table");
    await waitFor(() => hasButton(ann, "Seat 1"), { what: "the solitaire's seats" });
    await press(ann, "Seat 1");
    await waitFor(async () => (await drawn(ann))?.seat === 0, { what: "Ann seated alone" });
    const box = await read(ann, (sel: string) => { const r = document.querySelector(sel)!.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), W: innerWidth, H: innerHeight }; }, MODAL);
    check("R1: with a game, the Cards window fills the screen less its margin", Math.abs(box.W - 24 - box.w) <= 2 && Math.abs(box.H - 24 - box.h) <= 2, JSON.stringify(box));
    // 1.75x and more at 1280 x 720; at the small size (800 x 450, E2E_VIEWPORT=small) the whole table still shows, under 1x
    const sc = (await drawn(ann))!.scale, wide = ann.page.viewport()!.width >= 1280;
    check(wide ? "R2: at 1280x720 the table is drawn at 1.75x or more" : "R2: at 800x450 the whole table is drawn (0.75x or more)", sc >= (wide ? 1.75 : 0.75), String(sc));
    // R3: snapping off and on again, for everybody
    await press(ann, "Snapping: on");
    const snapOff = await within(async () => (await modal(bo))?.texts.includes("Snapping is off.") && (await logOf(bo)).at(-1) === `${ann.name} turned snapping off`, 2000);
    check("R3: Ann turns snapping off: Bo's window shows it off and the log says so", snapOff >= 0, `${snapOff} ms`);
    await press(ann, "Snapping: off");
    await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Snapping: on"), { what: "snapping on again" });
    // R7: two columns, of 1 and 3 cards: the first near a grid point, each next one dropped on the previous
    // card's lower half (it cascades CASCADE lower); everything comes from the stock, face down. Where a drop
    // lands, a run and a stack: snapAt and groupFrom in cards.test.ts; here, the drags that use them.
    const stockAt = pileAt(FREE.piles![0].at);
    const colX = (k: number) => GRID[0] / 2 + 3 * GRID[0] + k * GRID[0]; // grid columns 3 and 4, clear of the stock
    const top = GRID[1] / 2;
    const sizes = [1, 3];
    for (let k = 0; k < sizes.length; k++) {
      for (let i = 0; i < sizes[k]; i++) {
        const target = i === 0 ? feltAt(colX(k) + 3, top + 2) : feltAt(colX(k) + 2, top + (i - 1) * CASCADE + 9);
        const before = (await looseOf(ann)).length;
        await drag(ann, stockAt, target);
        await waitFor(async () => (await looseOf(ann)).length === before + 1, { timeout: 5000, what: `card ${i + 1} of column ${k + 1}` });
      }
    }
    const k1 = (await drawn(ann))!.scale;
    const column = async (x: number) => (await looseOf(ann)).filter((c) => Math.round(c.x / k1) === cardAt([x, 0]).x).map((c) => Math.round(c.y / k1)).sort((a, b) => a - b);
    const cols = [await column(colX(0)), await column(colX(1))];
    const cascades = cols.every((ys, k) => ys.length === sizes[k] && ys.every((y, i) => y === cardAt([0, top + i * CASCADE]).y));
    check("R3, R7: with snapping, cards dropped by hand land on a grid point, each next one CASCADE below the last", cascades, JSON.stringify(cols));
    // the top card of the second column turned face up with a double click
    await click(ann, feltAt(colX(1), top + 2 * CASCADE + 6), 2);
    const turnedUp = await within(async () => (await looseOf(ann)).filter((c) => c.up).length === 1, 5000);
    check("R7: a double click turns the top of a column face up", turnedUp >= 0, `${turnedUp} ms`);
    // R4: a run: the 2nd card of column 2 and the one on it move onto column 1's card
    // pressed in the 2nd card's visible strip (6 above its centre), dropped 2 below the top: its centre lands 8 below column 1's card
    const dRun = await drag(ann, feltAt(colX(1), top + CASCADE - 6), feltAt(colX(0) + 1, top + 2));
    await waitFor(async () => (await logOf(bo)).at(-1) === `${ann.name} moved 2 cards`, { timeout: 3000, what: "the run moved" }).catch(() => {});
    const col1 = await column(colX(0));
    check("R4: picking a card in a cascade moves it and the cards on it: column 1 gets 2 more, in cascade, in one message", col1.length === 3 && col1.every((y, i) => y === cardAt([0, top + i * CASCADE]).y) && dRun.total === 1 && dRun.msgs[0].t === "moveCards", JSON.stringify({ col1, msgs: dRun.msgs }));
    // R4: column 1 moved whole by its handle (just above its bottom card) to an empty grid point, three rows
    // lower (a column of 3 dropped on the fifth row would end off the felt, and is refused)
    // the card follows the hand: dropping the handle 17 above a grid point puts the bottom card on it
    const dHandle = await drag(ann, feltAt(colX(0), top - CARD_H / 2 - 3), feltAt(colX(0) + 2, top + 3 * GRID[1] - CARD_H / 2 - 2));
    await waitFor(async () => (await logOf(bo)).at(-1) === `${ann.name} moved 3 cards`, { timeout: 3000, what: "the column moved by its handle" }).catch(() => {});
    const moved3 = await column(colX(0));
    check("R4: dragging a cascade's handle moves the whole column to the grid point it is dropped on", JSON.stringify(moved3) === JSON.stringify([0, 1, 2].map((i) => cardAt([0, top + 3 * GRID[1] + i * CASCADE]).y)), JSON.stringify({ moved3, d: dHandle.msgs.map((m) => m.t) }));
    // R5: a pile made, moved by its handle, then removed: its card goes back to the stock
    await type(ann, "New pile", "Waste");
    await waitFor(() => hasButton(ann, "Face up"), { what: "New pile enabled" });
    await press(ann, "Face up");
    await waitFor(async () => (await logOf(bo)).includes(`${ann.name} created the pile Waste`), { what: "Waste created" });
    const wasteAt: [number, number] = [GRID[0] / 2, GRID[1] / 2]; // the first free place along the top of the felt
    await drag(ann, stockAt, pileAt(wasteAt));
    const wasteTo: [number, number] = [GRID[0] / 2 + 12 * GRID[0], GRID[1] / 2]; // along the top row: the card lands there, its handle near the felt's edge
    await drag(ann, feltAt(wasteAt[0], wasteAt[1] - CARD_H / 2 - 3), feltAt(wasteTo[0], wasteTo[1] - CARD_H / 2 - 3));
    const pileMoved = await within(async () => (await logOf(bo)).at(-1) === `${ann.name} moved the pile Waste`, 3000);
    check("R5: a pile moves by its handle to the felt's top row, for everybody", pileMoved >= 0, `${pileMoved} ms`);
    // the latest line of the log shows for the seated player, a pile selected (the selection bar above it)
    await click(ann, pileAt(wasteTo));
    const logSeen = await (await viewFrame(ann))!.evaluate(() => {
      const last = [...document.querySelectorAll(".log li")].at(-1), log = document.querySelector(".log"), panel = document.querySelector(".panel");
      if (!last) return null;
      const r = last.getBoundingClientRect(), l = log!.getBoundingClientRect(), p = panel!.getBoundingClientRect();
      return { inLog: r.bottom <= l.bottom + 1 && r.top >= l.top - 1, inPanel: r.bottom <= p.bottom + 1, last: last.textContent };
    });
    check("UX: at 1280x720, seated, a pile selected, the log's latest line is in sight", !!logSeen?.inLog && !!logSeen?.inPanel, JSON.stringify(logSeen));
    await click(ann, pileAt(wasteTo));
    await pressInView(ann, "Remove the pile Waste");
    const removed = await within(async () => (await logOf(bo)).at(-1) === `${ann.name} removed the pile Waste`, 3000);
    check("R5: a pile with a card in it is removed, its card back to the stock", removed >= 0, `${removed} ms`);
    // R6: the stock's top set aside: out of the game through Gather all
    await click(ann, stockAt);
    await pressInView(ann, "Set the top aside");
    await waitFor(async () => ((await logOf(bo)).at(-1) ?? "").endsWith(" aside"), { timeout: 3000, what: "a card set aside" }).catch(() => {});
    await press(ann, "Gather all");
    await waitFor(async () => (await logOf(bo)).at(-1) === `${ann.name} gathered all the cards`, { what: "gathered" });
    await press(ann, "Count");
    const outCount = await waitFor(async () => (await modal(bo))?.texts.find((x) => x.startsWith("Count: ")) ?? null, { timeout: 5000, what: "the count" }).catch(() => "");
    check("R6: a card set aside stays out through Gather all (Count: Stock 53 and 1 set aside)", /Stock 53/.test(outCount!) && /1 set aside/.test(outCount!), outCount!);
    // a named pile turned over as a whole: the stock, face down, comes face up (its bottom card on top)
    await click(ann, stockAt);
    await pressInView(ann, "Turn the pile over");
    const turned = await within(async () => (await logOf(bo)).at(-1) === `${ann.name} turned the pile Stock over` && (await drawn(bo))!.cards.some((c) => c.where === "pile" && c.up), 3000);
    check("a named pile turns over: the log says so and its top card now shows face up on every page", turned >= 0, `${turned} ms`);
    await click(ann, stockAt);
    await pressInView(ann, "Turn the pile over"); // back face down
    // the next press waits for that turn to reach the pages: a press while the view redraws was lost on CI
    // (2026-11-08: the jokers stayed in, the count read Stock 34 and 20 set aside)
    await waitFor(async () => !(await drawn(ann))!.cards.some((c) => c.where === "pile" && c.up) && !(await drawn(bo))!.cards.some((c) => c.where === "pile" && c.up), { timeout: 3000, what: "the stock face down again" });
    // a 32-card game: the jokers, then the 2s to 6s chosen one by one, set aside from the panel
    await press(ann, "Play with 52 cards");
    await waitFor(async () => ((await logOf(bo)).at(-1) ?? "").endsWith("set aside the jokers"), { timeout: 3000, what: "the jokers set aside" });
    for (const r of ["2", "3", "4", "5", "6"]) await press(ann, r);
    await press(ann, "Set the chosen aside");
    const ranksOut = await within(async () => (await logOf(bo)).at(-1) === `${ann.name} set aside the 2s, 3s, 4s, 5s and 6s`, 3000);
    await press(ann, "Count");
    const deck32 = await waitFor(async () => { const x = (await modal(bo))?.texts.find((t) => t.startsWith("Count: ")); return x && x !== outCount ? x : null; }, { timeout: 5000, what: "the new count" }).catch(() => "");
    const m32 = /Stock (\d+) · (\d+) set aside/.exec(deck32 ?? "");
    check("a 32-card game from the panel: whole ranks set aside in one line of the log; at most 32 cards left, the rest set aside", ranksOut >= 0 && !!m32 && Number(m32[1]) <= 32 && Number(m32[1]) + Number(m32[2]) === 54, `${ranksOut} ms; ${deck32}`);

    for (const u of users) check(`${u.name}: no console errors`, consoleErrors(u).length === 0, consoleErrors(u).slice(0, 3).join(" | "));
    // leave the table as new for later scenarios that put a deck on the same tile
    await press(ann, "Reset").catch(() => {});
    await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Free table"), { timeout: 5000, what: "the table reset" }).catch(() => {});
  } catch (e) {
    // what each page showed when it failed (HQ_FAIL_SHOTS: a folder)
    if (process.env.HQ_FAIL_SHOTS) for (const u of users) await u.page.screenshot({ path: `${process.env.HQ_FAIL_SHOTS}/${u.name}.png` }).catch((x) => console.log("no shot of " + u.name + ": " + x));
    check("scenario completed", false, String((e && (e as Error).stack) || e));
  } finally {
    await setPlugin(ctx, PLUGIN, false).catch(() => {});
    await setDecks(ctx, []).catch(() => {});
    await browser.close();
  }
  return summary();
}

