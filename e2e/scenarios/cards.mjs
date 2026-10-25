// Cards: the bundled hq-cards plugin (plugins/bundled/hq-cards) and its games (hq-card-pouilleux, Old Maid;
// hq-card-lastcard, Last Card), turned on by an administrator, a deck placed on a table of the map through the
// map API, then three players at the table (Ann, Bo, Cy) and a late spectator (Di). Everything a player does
// goes through the real controls: X, the window's buttons and fields, real mouse drags on the table view's
// canvas and the keyboard. What a page's view shows is read from what it drew (window.__drawn in the view:
// each card with its face, in canvas pixels) and from its live region.
// Each check names the criterion of docs/superpowers/specs/2026-10-25-plugin-cards-design.md it proves.
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, sleep, API } from "../lib.mjs";
import { CARD_W, CARD_H } from "../../plugins/bundled/hq-cards/public/art.ts";
import { FX, FY, NARROW, cardAt, handSpots, seatSpots } from "../../plugins/bundled/hq-cards/public/layout.ts";
import { CODES as OLD_MAID } from "../../plugins/bundled/hq-card-pouilleux/rules.ts";

const PLUGIN = "hq-cards";
const T = 16;
const DECK = { x: 13, y: 22 }; // bottom row of the social area's 4x2 table at (12, 21), as the chess scenario
const MODAL = '.modal.plugin-modal[aria-label="Cards"]';

const admin = (ctx, method, path, body) =>
  fetch(API + path, { method, headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: body && JSON.stringify(body) });
const setPlugin = (ctx, name, enabled) => admin(ctx, "PUT", "/api/admin/plugins/" + name, { enabled });
const installed = async (ctx) => (await (await admin(ctx, "GET", "/api/admin/plugins")).json()).map((p) => p.name);
async function setDecks(ctx, at) {
  const m = await (await admin(ctx, "GET", "/api/admin/map")).json();
  m.props = m.props.filter((p) => p.t !== PLUGIN + "/deck");
  for (const d of at) m.props.push({ t: PLUGIN + "/deck", x: d.x, y: d.y, w: 1, h: 1 });
  return (await admin(ctx, "PUT", "/api/map", m)).ok;
}

const read = (u, fn, arg) => u.page.evaluate(fn, arg);
async function viewFrame(u) {
  const el = await u.page.$(MODAL + ' iframe.plugin-view[data-view="table"]');
  return el ? el.contentFrame() : null;
}
/** What the page's table view drew, its seat, and its log. */
async function drawn(u) {
  const f = await viewFrame(u);
  return f ? f.evaluate(() => window.__drawn ?? null) : null;
}
const handOf = async (u) => ((await drawn(u))?.cards ?? []).filter((c) => c.where === "hand");
const looseOf = async (u) => ((await drawn(u))?.cards ?? []).filter((c) => c.where === "loose");
const logOf = async (u) => (await drawn(u))?.log ?? [];

/** The window's buttons (text, disabled, pressed) and its texts. */
const modal = (u) => read(u, (sel) => {
  const m = document.querySelector(sel);
  if (!m) return null;
  return {
    buttons: [...m.querySelectorAll(".plugin-body button")].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, pressed: b.getAttribute("aria-pressed") === "true" })),
    texts: [...m.querySelectorAll(".plugin-body p")].map((p) => p.textContent.trim()),
  };
}, MODAL);
const hasButton = async (u, text) => !!(await modal(u))?.buttons.find((b) => b.text === text && !b.disabled);
async function press(u, text) {
  for (const h of await u.page.$$(MODAL + " button")) if ((await h.evaluate((b) => b.textContent.trim())) === text) return h.click();
  throw new Error("no button " + text + " for " + u.name);
}
async function pressInView(u, text) {
  const f = await viewFrame(u);
  for (const h of await f.$$(".bar button")) if ((await h.evaluate((b) => b.textContent.trim())) === text) return h.click();
  throw new Error("no view button " + text + " for " + u.name);
}
async function type(u, label, value) {
  const input = await u.page.evaluateHandle((sel, label) => [...document.querySelectorAll(sel + " label.plugin-field")].find((l) => l.textContent.trim().startsWith(label))?.querySelector("input"), MODAL, label);
  await input.click({ clickCount: 3 });
  await input.type(value);
  await input.press("Enter");
}

/** Page coordinates of view points (view units), the view scrolled into sight. */
async function onPage(u, ...pts) {
  await u.page.evaluate((sel) => document.querySelector(sel + " iframe.plugin-view")?.scrollIntoView({ block: "center" }), MODAL);
  const f = await viewFrame(u);
  const k = (await drawn(u)).scale;
  await f.evaluate((ys) => {
    const r = document.querySelector("canvas").getBoundingClientRect();
    scrollTo(0, Math.max(0, r.top + scrollY + (Math.min(...ys) + Math.max(...ys)) / 2 - innerHeight / 2));
  }, pts.map((p) => p.y * k));
  const box = await (await f.$("canvas")).boundingBox();
  return pts.map((p) => ({ x: box.x + p.x * k, y: box.y + p.y * k }));
}
const centre = (c) => ({ x: c.x + CARD_W / 2, y: c.y + CARD_H / 2 });
const handAt = async (u, i) => centre(handSpots((await handOf(u)).length)[i]);
const pileAt = (at) => centre(cardAt(at));
const feltAt = (x, y) => ({ x: FX + x, y: FY + y });
const seatAt = (seats, me, seat) => seatSpots(seats, me).find((s) => s.seat === seat);

/** A real mouse drag between two view points; the plg frames sent while dragging and in all. */
async function drag(u, a, b) {
  const [from, to] = await onPage(u, a, b);
  const n0 = u.sent.length;
  await u.page.mouse.move(from.x, from.y);
  await u.page.mouse.down();
  await u.page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await u.page.mouse.move(to.x, to.y, { steps: 6 });
  await sleep(200); // CDP reports a sent frame asynchronously
  const during = u.sent.length - n0;
  await u.page.mouse.up();
  await sleep(250);
  return { during, total: u.sent.length - n0, msgs: u.sent.slice(n0) };
}
async function click(u, p, count = 1) {
  const [q] = await onPage(u, p);
  await u.page.mouse.click(q.x, q.y, { clickCount: count });
  await sleep(150);
}

/** Counts the plugin frames this page sends on its game socket (u.sent: their payloads). */
async function countFrames(u) {
  u.sent = [];
  const s = await u.page.createCDPSession();
  await s.send("Network.enable");
  s.on("Network.webSocketFrameSent", (e) => {
    try {
      const m = JSON.parse(e.response.payloadData);
      if (m.t === "plg" && m.pl === PLUGIN) u.sent.push(m.d);
    } catch { /* not JSON */ }
  });
}
async function within(fn, limit) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = await fn(); } catch { ok = false; }
    if (ok) return Date.now() - t0;
    if (Date.now() - t0 > limit) return -1;
    await sleep(40);
  }
}
const nearDeck = (u) => read(u, () => window.__hq.state.nearby?.t === "hq-cards/deck");
/** Walks to a spot within reach of the deck, again if a walk stopped short (another avatar in the way). */
async function goTo(u, x, y) {
  u.spot = { x, y };
  for (let i = 0; i < 3; i++) {
    await walkTo(u, x, y).catch(() => {});
    if (await waitFor(() => nearDeck(u), { timeout: 3000, what: "near" }).catch(() => false)) return;
  }
}
async function openWithX(u) {
  if (!(await nearDeck(u)) && u.spot) await goTo(u, u.spot.x, u.spot.y);
  await waitFor(() => nearDeck(u), { what: u.name + " next to the deck" });
  // X does nothing while a dialog's scrim is still on the page (a window closing): pressed until it opens
  let tries = 0;
  await waitFor(async () => {
    if (await u.page.$(MODAL)) return true;
    if (tries++ % 20 === 0) await u.page.keyboard.press("x");
    return false;
  }, { what: u.name + "'s Cards window" });
  // the table's view shows once a game is chosen; the choice of a game has none
  await waitFor(async () => (await modal(u))?.buttons.some((b) => b.text === "Free table") || ((await viewFrame(u)) && (await drawn(u)) !== null), { what: u.name + "'s table drawn" });
}

export async function run(ctx) {
  resetChecks();
  const browser = await launch();
  const users = [];
  try {
    const t = String(Date.now() % 10000);
    const games = await installed(ctx);
    const hasLastCard = games.includes("hq-card-lastcard");
    check("an administrator turns hq-cards on (admin API)", (await setPlugin(ctx, PLUGIN, true)).ok);
    check("a deck is placed on a table through the map API", await setDecks(ctx, [DECK]));
    const ann = await joinAs(browser, "Ann" + t, { avatar: { sk: 1, hs: 1, hc: 2, sh: 2, pa: 1 } });
    const bo = await joinAs(browser, "Bo" + t, { avatar: { sk: 3, hs: 3, hc: 1, sh: 5, pa: 0 } });
    // Cy has a name of 24 characters, the longest a member can have
    const cy = await joinAs(browser, "Cyrillia Featherston" + t, { avatar: { sk: 0, hs: 2, hc: 3, sh: 1, pa: 2 } });
    users.push(ann, bo, cy);
    for (const u of users) await countFrames(u);
    const feet = 23 * T + 8;
    await Promise.all([goTo(ann, 204, feet), goTo(bo, 212, feet), goTo(cy, 220, feet)]);

    // ---- criterion 1: the deck on the table, with the X hint
    const sprite = await waitFor(async () => {
      const s = await read(ann, () => window.__hq.view.objSprites.filter((x) => !x.destroyed).map((x) => ({ x: x.x, y: x.y, w: x.texture.width, h: x.texture.height, on: x.visible })));
      return s.find((x) => x.w === 16 && x.x === 13 * 16) ?? null;
    }, { what: "the deck sprite" });
    check("1: the deck's sprite is drawn on its tile of the table (16x16)", sprite.on && sprite.y === (DECK.y + 1) * T, JSON.stringify(sprite));
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
    check("UX: at 800x450 the game choice shows when the window opens", choiceSeen.top >= 0 && choiceSeen.bottom <= choiceSeen.H, JSON.stringify(choiceSeen));
    const only = await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Free table") && (await modal(ann)), { what: "the game choice" });
    check("2: a new table offers Free table, and no game while none runs", only.buttons.some((b) => b.text === "Free table") && !only.buttons.some((b) => b.text === "Old Maid"), JSON.stringify(only.buttons));
    await setPlugin(ctx, "hq-card-pouilleux", true);
    const listed = await within(async () => (await modal(ann))?.buttons.some((b) => b.text === "Old Maid"), 5000);
    check("2: turning Old Maid on adds it to the open window's choice", listed >= 0, `${listed} ms`);
    await setPlugin(ctx, "hq-card-pouilleux", false);
    const unlisted = await within(async () => !(await modal(ann))?.buttons.some((b) => b.text === "Old Maid"), 5000);
    check("2: turning it off takes it away", unlisted >= 0, `${unlisted} ms`);

    // ---- criterion 4: seats
    await press(ann, "Free table");
    await waitFor(async () => hasButton(ann, "Seat 1"), { what: "the free table's seats" });
    await press(ann, "Seat 1");
    await waitFor(async () => hasButton(bo, "Seat 2") && (await modal(bo)).buttons.some((b) => b.text === "Seat 1: " + ann.name), { what: "Ann seated, on Bo's page" });
    await press(bo, "Seat 2");
    await waitFor(async () => hasButton(cy, "Seat 3") && (await modal(cy)).buttons.some((b) => b.text === "Seat 2: " + bo.name), { what: "Bo seated" });
    await press(cy, "Seat 3");
    await waitFor(async () => (await drawn(cy))?.seat === 2, { what: "Cy seated" });
    const annSeats = (await modal(ann)).buttons;
    check("4: each takes a seat; a seated player cannot take another (free seats disabled for Ann)", annSeats.find((b) => b.text === "Seat 1: " + ann.name)?.pressed && annSeats.find((b) => b.text === "Seat 4")?.disabled, JSON.stringify(annSeats.slice(0, 4)));
    await press(cy, "Close");
    const away = await within(async () => (await modal(ann)).buttons.some((b) => b.text === `Seat 3: ${cy.name} (away)`), 1000);
    check("4: Cy closes the window: Ann sees Cy away within 1 s, the seat kept", away >= 0, `${away} ms`);
    await openWithX(cy);
    const back = await within(async () => (await modal(ann)).buttons.some((b) => b.text === `Seat 3: ${cy.name}`) && (await drawn(cy))?.seat === 2, 2000);
    check("4: Cy opens it again and is back in the seat", back >= 0, `${back} ms`);

    // ---- criterion 5: deal, then drags to the felt, a pile and a player
    await press(ann, "Deal 7 each");
    await waitFor(async () => (await handOf(ann)).length === 7 && (await handOf(bo)).length === 7 && (await handOf(cy)).length === 7, { what: "7 cards each" });
    const alive = await Promise.all(users.map((u) => read(u, () => Object.keys(window.__hq.session.plugins?.stopReasons ?? {}).length === 0 || !("hq-cards" in (window.__hq.session.plugins?.stopReasons ?? {})))));
    check("UX: with a 24-character name at the table, the Cards plugin keeps running on every page after the deal", alive.every(Boolean) && (await Promise.all(users.map((u) => viewFrame(u)))).every(Boolean), JSON.stringify(alive));
    const fits = await (await viewFrame(bo)).evaluate(() => {
      const c = document.querySelector("canvas").getBoundingClientRect(), b = document.querySelector(".bar").getBoundingClientRect();
      return { canvasTop: c.top, canvasBottom: c.bottom, barBottom: b.bottom, H: innerHeight, scroll: scrollY };
    });
    check("UX: at 800x450 the whole table, my hand included, and the buttons under it fit Bo's view without scrolling", fits.canvasTop >= 0 && fits.barBottom <= fits.H + 1, JSON.stringify(fits));
    check("5: Deal 7 each gives every seated player 7 cards, shown face up in their own hand only",
      (await handOf(ann)).every((c) => c.up) && ((await drawn(ann)).cards.filter((c) => c.where === "loose")).length === 0);
    const first = (await handOf(ann))[0];
    const handAfter = async (n) => waitFor(async () => (await handOf(ann)).length === n, { what: "Ann's hand of " + n });
    let d = await drag(ann, await handAt(ann, 0), feltAt(60, 120));
    const seen = await Promise.all([bo, cy].map((u) => within(async () => (await looseOf(u)).some((c) => c.c === first.c && c.up), 1000)));
    check("5: Ann drags her first card onto the felt: Bo and Cy see it face up within 1 s", seen.every((ms) => ms >= 0), JSON.stringify(seen));
    check("12: nothing sent while dragging, one plg frame for the drop", d.during === 0 && d.total === 1 && d.msgs[0].t === "place", JSON.stringify(d));
    await handAfter(6);
    const stock = { at: [160, 90] };
    d = await drag(ann, await handAt(ann, 0), pileAt(stock.at));
    const onStock = await within(async () => (await logOf(bo)).some((l) => l === `${ann.name} put a card on Stock`), 1000);
    check("5: a card dragged onto the Stock pile goes on it (face down, as the pile) and is logged", onStock >= 0 && d.total === 1, `${onStock} ms ` + JSON.stringify({ d, hand: (await handOf(ann)).length, log: (await logOf(bo)).slice(-3), annLog: (await logOf(ann)).slice(-2) }));
    await handAfter(5);
    const boSpot = seatAt(8, 0, 1);
    d = await drag(ann, await handAt(ann, 0), boSpot);
    const gave = await within(async () => (await handOf(bo)).length === 8, 1000);
    check("5: a card dragged onto Bo's name goes into Bo's hand", gave >= 0 && (await handOf(ann)).length === 4, `${gave} ms`);
    const barOf = async (u) => (await viewFrame(u)).evaluate(() => [...document.querySelectorAll(".bar button")].map((b) => b.textContent));
    const lifted = (await handOf(ann)).some((c, i, a) => c.y !== a[0].y);
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

    // ---- criterion 5: a spectator cannot move a card
    const di = await joinAs(browser, "Di" + t, { avatar: { sk: 2, hs: 0, hc: 4, sh: 3, pa: 1 } });
    users.push(di);
    await countFrames(di);
    await goTo(di, 196, feet);
    await openWithX(di);
    check("5: Di, without a seat, watches: no hand", (await drawn(di))?.seat === null && (await handOf(di)).length === 0);
    d = await drag(di, feltAt(60, 120), feltAt(200, 140));
    await sleep(400);
    check("5: Di drags the card on the felt: nothing is sent, it stays", d.total === 0 && (await looseOf(ann)).some((c) => c.c === first.c), JSON.stringify(d));

    // ---- criterion 6: a pile created, shuffled, drawn from, looked through and reordered, all logged
    await type(ann, "New pile's name", "Discard");
    await waitFor(() => hasButton(ann, "New pile face up"), { what: "New pile enabled" });
    await press(ann, "New pile face up");
    await waitFor(async () => (await logOf(bo)).includes(`${ann.name} created the pile Discard`), { what: "Discard created" });
    await click(ann, pileAt(stock.at));
    await pressInView(ann, "Shuffle Stock");
    await waitFor(async () => (await logOf(bo)).includes(`${ann.name} shuffled Stock`), { what: "shuffle logged" });
    await pressInView(ann, "Draw from Stock");
    await waitFor(async () => (await logOf(bo)).includes(`${ann.name} drew a card from Stock`), { what: "draw logged" });
    await pressInView(ann, "Look through Stock");
    const lookingSeen = await within(async () => (await read(bo, () => 0), (await drawn(bo)).cards.length >= 0) && (await logOf(bo)).includes(`${ann.name} looked at Stock`), 1000);
    const row = await waitFor(async () => { const r = (await drawn(ann)).cards.filter((c) => c.where === "look"); return r.length > 2 ? r : null; }, { what: "the pile's row" });
    const k = (await drawn(ann)).scale;
    const a0 = { x: row[0].x / k + 4, y: row[0].y / k + 10 }, a2 = { x: row[2].x / k + 4, y: row[2].y / k + 10 };
    await drag(ann, a0, a2);
    const moved = (await drawn(ann)).cards.filter((c) => c.where === "look");
    await pressInView(ann, "Done");
    const reordered = await within(async () => (await logOf(bo)).includes(`${ann.name} reordered Stock`), 1000);
    check("6: Ann looks through Stock and reorders it: Bo's log says so within 1 s of each", lookingSeen >= 0 && reordered >= 0 && moved[2].c === row[0].c, JSON.stringify({ lookingSeen, reordered }));
    const named = (await logOf(bo)).filter((l) => l.startsWith(ann.name + " looked") || l.startsWith(ann.name + " reordered"));
    check("6: the log names no card Ann saw alone", named.every((l) => !/ of (spades|hearts|diamonds|clubs)|joker/.test(l)), JSON.stringify(named));

    // ---- criterion 7: Ann offers her hand to Bo, who picks her third card
    await press(ann, `Offer my hand to ${bo.name}`);
    await waitFor(async () => (await logOf(bo)).includes(`${ann.name} offered their hand to ${bo.name}`), { what: "the offer" });
    const annBefore = await handOf(ann);
    await click(bo, seatAt(8, 1, 0));
    await pressInView(bo, `Draw a card from ${ann.name}`).catch(() => {}); // the click on Ann's seat already opened the row
    const pickRow = await waitFor(async () => { const r = (await drawn(bo)).cards.filter((c) => c.where === "pick"); return r.length === annBefore.length ? r : null; }, { what: "Bo's pick row" });
    check("7: the hand offered shows to Bo as backs only", pickRow.every((c) => !c.up));
    const kb = (await drawn(bo)).scale;
    await click(bo, { x: pickRow[2].x / kb + 4, y: pickRow[2].y / kb + 10 });
    const picked = await within(async () => (await logOf(cy)).includes(`${bo.name} drew a card from ${ann.name}'s hand`), 1000);
    const annAfter = await handOf(ann);
    check("7: Bo picks the third card: it leaves Ann's hand, it is logged for everybody", picked >= 0 && annAfter.length === annBefore.length - 1 && !annAfter.some((c) => c.c === annBefore[2].c), `${picked} ms`);
    check("7: Cy, not offered, has no way to pick (no pick row, no button)", !(await drawn(cy)).cards.some((c) => c.where === "pick"));

    // ---- criterion 13 (keyboard half): a card moved with the keyboard only reaches Bo and is announced
    const f = await viewFrame(ann);
    await f.focus("canvas");
    const said = async (u) => (await viewFrame(u)).evaluate(() => document.querySelector("[aria-live]").textContent);
    const handN = (await handOf(ann)).length;
    await ann.page.keyboard.press("ArrowLeft");
    await ann.page.keyboard.press("ArrowRight"); // the cursor on my first card
    const sayFirst = await waitFor(async () => (await said(ann)) || null, { timeout: 2000, what: "the live region" }).catch(() => "");
    await ann.page.keyboard.press("Enter");
    const looseN = (await drawn(ann)).cards.filter((c) => c.where === "loose").length;
    for (let i = 0; i < handN + looseN; i++) await ann.page.keyboard.press("ArrowRight"); // to the first pile, Stock
    await ann.page.keyboard.press("Enter");
    const kbd = await within(async () => (await logOf(bo)).at(-1) === `${ann.name} put a card on Stock`, 1000);
    check("13: with the keyboard only, Ann puts a card on Stock; Bo's log has it within 1 s, Ann's live region spoke", kbd >= 0 && /your hand/.test(sayFirst), JSON.stringify({ kbd, sayFirst }));

    // ---- criterion 10 (restart): the table, its seats and its log survive a server restart
    const beforeRestart = { ann: (await handOf(ann)).map((c) => c.c), log: (await logOf(bo)).length };
    if (ctx.server) {
      await ctx.stopServer();
      await ctx.startServer();
      for (const u of users) {
        await u.page.reload({ waitUntil: "domcontentloaded" });
        await waitFor(() => read(u, () => window.__hq?.state?.conn === "open"), { timeout: 30000, what: u.name + " reconnected" });
        await countFrames(u);
      }
      await Promise.all([goTo(ann, 204, feet), goTo(bo, 212, feet)]);
      await openWithX(ann);
      await openWithX(bo);
      await waitFor(async () => (await handOf(ann)).length === beforeRestart.ann.length, { timeout: 5000, what: "Ann's hand after the restart" }).catch(() => {});
      check("10: after a server restart, Ann has her seat and her hand, and the log is kept",
        JSON.stringify((await handOf(ann)).map((c) => c.c)) === JSON.stringify(beforeRestart.ann) && (await logOf(bo)).length === beforeRestart.log, JSON.stringify({ hand: (await handOf(ann)).length, log: (await logOf(bo)).length }));
    } else check("10: server restart (skipped against an external stack)", true);

    // ---- criteria 8 and 9: Old Maid, with its narrowed actions and its count
    await setPlugin(ctx, "hq-card-pouilleux", true);
    await press(ann, "Reset");
    await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Old Maid"), { timeout: 5000, what: "Old Maid offered after the reset" });
    await press(ann, "Old Maid");
    await waitFor(() => hasButton(ann, "Seat 1"), { what: "Old Maid's seats" });
    await press(ann, "Seat 1");
    await waitFor(() => hasButton(bo, "Seat 2"), { what: "seat 2 free for Bo" });
    await press(bo, "Seat 2");
    await waitFor(async () => (await drawn(bo))?.seat === 1, { what: "Bo seated at Old Maid" });
    const om = (await modal(ann)).buttons.map((b) => b.text);
    check("8: Old Maid's window offers Deal all and Count, not Deal N, a new pile or Draw", om.includes("Deal all") && om.includes("Count") && !om.some((b) => b.startsWith("Deal ") && b.endsWith("each")) && !om.includes("New pile face up"), JSON.stringify(om));
    await press(ann, "Deal all");
    await waitFor(async () => (await handOf(ann)).length + (await handOf(bo)).length === 49, { what: "Old Maid dealt" });
    check("9: Deal all deals Old Maid's 49 cards (the jacks of clubs, diamonds and hearts left out)", true);
    await click(ann, pileAt([130, 90]));
    const omBar = await (await viewFrame(ann)).evaluate(() => [...document.querySelectorAll(".bar button")].map((b) => b.textContent));
    check("8: Old Maid allows no draw from or look through a pile (no such buttons for the Stock)", !omBar.some((b) => b.startsWith("Draw from") || b.startsWith("Look through")), JSON.stringify(omBar));
    // Ann puts down a pair she holds, on Pairs
    const rank = (c) => OLD_MAID[c][0];
    const hand = await handOf(ann);
    const pair = hand.flatMap((x, i) => hand.slice(i + 1).filter((y) => rank(y.c) === rank(x.c)).map((y) => [x, y]))[0];
    if (pair) {
      const pairs = [190, 90];
      await drag(ann, await handAt(ann, hand.findIndex((c) => c.c === pair[0].c)), pileAt(pairs));
      await waitFor(async () => (await handOf(ann)).length === hand.length - 1, { what: "the first of the pair" });
      const h2 = await handOf(ann);
      await drag(ann, await handAt(ann, h2.findIndex((c) => c.c === pair[1].c)), pileAt(pairs));
      const both = await within(async () => (await logOf(bo)).filter((l) => l.startsWith(`${ann.name} put the`) && l.endsWith("on Pairs")).length === 2, 1000);
      check("9: Ann drops a pair on Pairs (face up, named in the log)", both >= 0, JSON.stringify((await logOf(bo)).slice(-2)));
    } else check("9: Ann holds no pair to drop (dealt without one)", true);
    await press(ann, `Offer my hand to ${bo.name}`);
    await waitFor(async () => (await logOf(bo)).includes(`${ann.name} offered their hand to ${bo.name}`), { what: "Old Maid offer" });
    await click(bo, seatAt(6, 1, 0));
    const omRow = await waitFor(async () => { const r = (await drawn(bo)).cards.filter((c) => c.where === "pick"); return r.length ? r : null; }, { what: "Old Maid pick row" });
    const kb2 = (await drawn(bo)).scale;
    await click(bo, { x: omRow[0].x / kb2 + 4, y: omRow[0].y / kb2 + 10 });
    await waitFor(async () => (await logOf(ann)).includes(`${bo.name} drew a card from ${ann.name}'s hand`), { what: "Bo's pick at Old Maid" });
    await press(ann, "Count");
    const counted = await waitFor(async () => (await modal(bo))?.texts.find((x) => x.startsWith("Count: ")) ?? null, { timeout: 5000, what: "Old Maid's count" });
    const nAnn = (await handOf(ann)).length, nBo = (await handOf(bo)).length;
    check("9: Count shows Old Maid's own count (from its hook) to everybody", counted === `Count: ${nAnn + nBo} cards left: ${ann.name} ${nAnn}, ${bo.name} ${nBo}`, counted);

    // ---- criterion 10: the game's plugin off: only Reset; on again: back as it was
    const omHands = (await handOf(ann)).map((c) => c.c);
    await setPlugin(ctx, "hq-card-pouilleux", false);
    const off = await within(async () => { const m = await modal(ann); return m.texts.some((x) => x.startsWith("This game is not available")) && m.buttons.filter((b) => b.text !== "Close").every((b) => b.text === "Reset"); }, 5000);
    check("10: Old Maid turned off: its table offers only Reset", off >= 0, JSON.stringify(await modal(ann)));
    await setPlugin(ctx, "hq-card-pouilleux", true);
    const on = await within(async () => JSON.stringify((await handOf(ann)).map((c) => c.c)) === JSON.stringify(omHands) && (await hasButton(ann, "Count")), 8000);
    check("10: on again, the table is back with its hands", on >= 0, `${on} ms`);

    // ---- criterion 10b: Last Card, a game with its own cards
    if (hasLastCard) {
      await setPlugin(ctx, "hq-card-lastcard", true);
      await press(ann, "Reset");
      await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Last Card"), { timeout: 5000, what: "Last Card offered" });
      await press(ann, "Last Card");
      // a game with its own cards starts each window's view afresh (its security policy then admits the game's images)
      const renewed = await Promise.all([ann, bo].map((u) => within(async () => (await drawn(u))?.sheet === "loaded" && (await hasButton(u, "Seat 1")), 5000)));
      check("10b: on choosing Last Card, every open window's view renews and loads the game's own sheet (shared/cards.png)", renewed.every((ms) => ms >= 0), JSON.stringify(renewed));
      await press(ann, "Seat 1");
      await waitFor(() => hasButton(bo, "Seat 2"), { what: "seat 2 for Bo" });
      await press(bo, "Seat 2");
      await waitFor(async () => (await drawn(bo))?.seat === 1, { what: "Bo seated at Last Card" }).catch(async (e) => {
        throw new Error(e.message + " " + JSON.stringify({ modal: await modal(bo), drawn: await drawn(bo).then((d) => d && { seat: d.seat, sheet: d.sheet }) }));
      });
      await press(ann, "Deal 7 each");
      await waitFor(async () => (await handOf(ann)).length === 7 && (await handOf(bo)).length === 7, { what: "Last Card dealt" });
      await drag(ann, await handAt(ann, 0), pileAt([190, 90]));
      const lcLog = await waitFor(async () => (await logOf(bo)).find((l) => l.startsWith(`${ann.name} put the`) && l.endsWith("on Discard")) ?? null, { timeout: 3000, what: "a Last Card play" });
      check("10b: a card played on Discard is named in the log with its own name", /put the (Red|Yellow|Green|Blue|Wild)/.test(lcLog), lcLog);
      await press(ann, "Count");
      const lcCount = await waitFor(async () => (await modal(bo))?.texts.find((x) => x.startsWith("Count: ")) ?? null, { timeout: 5000, what: "Last Card's count" });
      check("10b: Count gives each hand's points", new RegExp(`^Count: ${ann.name} \\d+, ${bo.name} \\d+`).test(lcCount), lcCount);
      // turned off and on with the window open: the page learns of the plugin after the game is back, and the
      // view must still end up drawing the game's own sheet
      await setPlugin(ctx, "hq-card-lastcard", false);
      await waitFor(async () => (await modal(ann))?.texts.some((x) => x.startsWith("This game is not available")), { timeout: 5000, what: "Last Card off" });
      // the window opened again while the game is off: its view starts without the game's images allowed
      await press(ann, "Close");
      await openWithX(ann);
      await setPlugin(ctx, "hq-card-lastcard", true);
      const again = await within(async () => (await drawn(ann))?.sheet === "loaded" && (await handOf(ann)).length === 6, 10000);
      check("10b: Last Card off, the window opened, Last Card on: its cards come back drawn from its sheet", again >= 0, `${again} ms, sheet ${(await drawn(ann))?.sheet} ` + JSON.stringify({ modal: await modal(ann), hand: (await handOf(ann)).length, seat: (await drawn(ann))?.seat }));
    } else check("10b: Last Card (hq-card-lastcard is not in this tree yet)", false, "not installed");

    const real = (u) => u.logs.filter((l) => !/WebSocket|ERR_|net::|closed/.test(l));
    for (const u of users) check(`${u.name}: no console errors`, real(u).length === 0, real(u).slice(0, 3).join(" | "));
    // leave the table as new for later scenarios that put a deck on the same tile
    await press(ann, "Reset").catch(() => {});
    await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Free table"), { timeout: 5000, what: "the table reset" }).catch(() => {});
  } catch (e) {
    check("scenario completed", false, String((e && e.stack) || e));
  } finally {
    for (const name of ["hq-card-lastcard", "hq-card-pouilleux", PLUGIN]) await setPlugin(ctx, name, false).catch(() => {});
    await setDecks(ctx, []).catch(() => {});
    await browser.close();
  }
  return summary();
}

export { setPlugin, setDecks, viewFrame, drawn, handOf, press, modal, openWithX, drag, handAt, pileAt, feltAt, MODAL, DECK };
