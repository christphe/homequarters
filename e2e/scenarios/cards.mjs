// Cards: the bundled hq-cards plugin (plugins/bundled/hq-cards) and its games (hq-card-pouilleux, Old Maid;
// hq-card-lastcard, Last Card), turned on by an administrator, a deck placed on a table of the map through the
// map API, then three players at the table (Ann, Bo, Cy) and a late spectator (Di). Everything a player does
// goes through the real controls: X, the window's buttons and fields, real mouse drags on the table view's
// canvas and the keyboard. What a page's view shows is read from what it drew (window.__drawn in the view:
// each card with its face, in canvas pixels) and from its live region.
// Each check names the criterion of docs/superpowers/specs/2026-10-25-plugin-cards-design.md it proves.
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, sleep, API } from "../lib.mjs";
import { CARD_W, CARD_H } from "../../plugins/bundled/hq-cards/public/art.ts";
import { FX, FY, NARROW, GRID, CASCADE, cardAt, handSpots, seatSpots } from "../../plugins/bundled/hq-cards/public/layout.ts";
import { CODES as OLD_MAID } from "../../plugins/bundled/hq-card-pouilleux/rules.ts";
import { FREE } from "../../plugins/bundled/hq-cards/public/games.ts";

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

/** The window's controls, wherever they are: its own buttons and texts (the choice of a game, Close) and,
 * with a game, the controls of the table view's panel. */
const modal = async (u) => {
  const own = await read(u, (sel) => {
    const m = document.querySelector(sel);
    if (!m) return null;
    return {
      buttons: [...m.querySelectorAll(".plugin-body button, .modal-actions button")].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, pressed: b.getAttribute("aria-pressed") === "true" })),
      texts: [...m.querySelectorAll(".plugin-body p")].map((p) => p.textContent.trim()),
    };
  }, MODAL);
  if (!own) return null;
  const f = await viewFrame(u);
  const inView = f ? await f.evaluate(() => ({
    buttons: [...document.querySelectorAll(".controls button")].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, pressed: b.getAttribute("aria-pressed") === "true" })),
    texts: [...document.querySelectorAll(".controls p")].map((p) => p.textContent.trim()),
  })).catch(() => null) : null;
  return { buttons: [...own.buttons, ...(inView?.buttons ?? [])], texts: [...own.texts, ...(inView?.texts ?? [])] };
};
const hasButton = async (u, text) => !!(await modal(u))?.buttons.find((b) => b.text === text && !b.disabled);
/** Clicks a control by its text with the real mouse: in the window, or in the table view's panel. The panel
 * is rebuilt when the table changes: a button found just before may be gone, so it is looked for again. */
async function press(u, text) {
  for (let tries = 0; ; tries++) {
    try {
      for (const h of await u.page.$$(MODAL + " button")) if ((await h.evaluate((b) => b.textContent.trim())) === text) return await h.click();
      const f = await viewFrame(u);
      if (f) for (const h of await f.$$(".controls button")) if ((await h.evaluate((b) => b.textContent.trim())) === text) {
        await h.evaluate((b) => b.scrollIntoView({ block: "center" }));
        return await h.click();
      }
      throw new Error("no button " + text + " for " + u.name);
    } catch (e) {
      if (tries >= 3 || !/detached|no button|not clickable/.test(String(e))) throw e;
      await sleep(200);
    }
  }
}
async function pressInView(u, text) {
  const f = await viewFrame(u);
  for (const h of await f.$$(".bar button")) if ((await h.evaluate((b) => b.textContent.trim())) === text) return h.click();
  throw new Error("no view button " + text + " for " + u.name);
}
/** Types into a field of the table view's panel, found by its label. */
async function type(u, label, value) {
  const f = await viewFrame(u);
  const input = await f.evaluateHandle((label) => [...document.querySelectorAll(".controls label.field")].find((l) => l.textContent.trim().startsWith(label))?.querySelector("input"), label);
  await input.click({ clickCount: 3 });
  await input.type(value);
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
/** count real clicks at a view point (Puppeteer's clickCount only labels one click: a double click is two). */
async function click(u, p, count = 1) {
  const [q] = await onPage(u, p);
  for (let i = 0; i < count; i++) {
    await u.page.mouse.click(q.x, q.y, { clickCount: i + 1 });
    if (i + 1 < count) await sleep(60);
  }
  await sleep(150);
}

/** Counts the plugin frames this page sends on its game socket (u.sent: their payloads). */
async function countFrames(u) {
  u.sent = [];
  if (u.cdp) return; // one listener per page: a page reloaded keeps its session (a second one would count every frame twice)
  const s = (u.cdp = await u.page.createCDPSession());
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
  // the choice of a game and the "not available" window have no view; a game has the table's view
  await waitFor(async () => {
    const m = await modal(u);
    return m?.buttons.some((b) => b.text === "Free table") || m?.texts.some((x) => x.startsWith("This game is not available")) || ((await viewFrame(u)) && (await drawn(u)) !== null);
  }, { what: u.name + "'s table drawn" });
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
    await press(ann, "Deal");
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
    const stock = { at: FREE.piles[0].at }; // the free table's stock, in the middle of the felt
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
    await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Old Maid"), { timeout: 5000, what: "Old Maid offered after the reset" })
      .catch(async (e) => { throw new Error(e.message + " " + JSON.stringify(await modal(ann))); });
    await press(ann, "Old Maid");
    await waitFor(() => hasButton(ann, "Seat 1"), { what: "Old Maid's seats" });
    await press(ann, "Seat 1");
    await waitFor(() => hasButton(bo, "Seat 2"), { what: "seat 2 free for Bo" });
    await press(bo, "Seat 2");
    await waitFor(async () => (await drawn(bo))?.seat === 1, { what: "Bo seated at Old Maid" }).catch(async (e) => {
      await bo.page.screenshot({ path: "C:/Users/jorsc/AppData/Local/Temp/claude/f--projects-homequarters/4c888347-707b-446e-ae7c-833980e27b8f/scratchpad/bo-seat.png" });
      throw new Error(e.message + " " + JSON.stringify({ log: (await logOf(bo)).slice(-2), vp: bo.page.viewport() }));
    });
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
      const nSeat = bo.sent.length;
      await press(bo, "Seat 2");
      await waitFor(async () => (await drawn(bo))?.seat === 1, { what: "Bo seated at Last Card" }).catch(async (e) => {
        throw new Error(e.message + " " + JSON.stringify({ sent: bo.sent.slice(nSeat), frames: (await bo.page.$$("iframe.plugin-view")).length, log: (await logOf(bo)).slice(-3), seat: (await drawn(bo))?.seat }));
      });
      await press(ann, "Deal");
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
      const again = await within(async () => (await drawn(ann))?.sheet === "loaded" && (await handOf(ann)).length === 6, 20000); // a plugin turned on under load can take seconds to register
      const inWindow = await (await (await ann.page.$('iframe.plugin-frame[data-plugin="hq-cards"]'))?.contentFrame())?.evaluate(() => globalThis.__cards?.()).catch((x) => String(x));
      check("10b: Last Card off, the window opened, Last Card on: its cards come back drawn from its sheet", again >= 0, `${again} ms, sheet ${(await drawn(ann))?.sheet} ` + JSON.stringify({ inWindow, modal: await modal(ann), hand: (await handOf(ann)).length, seat: (await drawn(ann))?.seat }));
    } else check("10b: Last Card (hq-card-lastcard is not in this tree yet)", false, "not installed");

    // ---- round 2 (R1-R7): a solitaire on the free table, Ann alone, through the real controls; Bo watches
    await press(ann, "Reset");
    await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Free table"), { timeout: 8000, what: "the choice for the solitaire" });
    await press(ann, "Free table");
    await waitFor(() => hasButton(ann, "Seat 1"), { what: "the solitaire's seats" });
    await press(ann, "Seat 1");
    await waitFor(async () => (await drawn(ann))?.seat === 0, { what: "Ann seated alone" });
    const box = await read(ann, (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), W: innerWidth, H: innerHeight }; }, MODAL);
    check("R1: with a game, the Cards window fills the screen less its margin", Math.abs(box.W - 24 - box.w) <= 2 && Math.abs(box.H - 24 - box.h) <= 2, JSON.stringify(box));
    // 1.75x and more at 1280 x 720; at the small size (800 x 450, E2E_VIEWPORT=small) the whole table still shows, under 1x
    const sc = (await drawn(ann)).scale, wide = ann.page.viewport().width >= 1280;
    check(wide ? "R2: at 1280x720 the table is drawn at 1.75x or more" : "R2: at 800x450 the whole table is drawn (0.75x or more)", sc >= (wide ? 1.75 : 0.75), String(sc));
    // R3: snapping off and on again, for everybody
    await press(ann, "Snapping: on");
    const snapOff = await within(async () => (await modal(bo))?.texts.includes("Snapping is off.") && (await logOf(bo)).at(-1) === `${ann.name} turned snapping off`, 2000);
    check("R3: Ann turns snapping off: Bo's window shows it off and the log says so", snapOff >= 0, `${snapOff} ms`);
    await press(ann, "Snapping: off");
    await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Snapping: on"), { what: "snapping on again" });
    // R7: seven columns, column k of k + 1 cards: the first near a grid point, each next one dropped on the
    // previous card's lower half (it cascades CASCADE lower); everything comes from the stock, face down
    const stockAt = pileAt(FREE.piles[0].at);
    const colX = (k) => GRID[0] / 2 + 3 * GRID[0] + k * GRID[0]; // grid columns 3..9, clear of the stock
    const top = GRID[1] / 2;
    for (let k = 0; k < 7; k++) {
      for (let i = 0; i <= k; i++) {
        const target = i === 0 ? feltAt(colX(k) + 3, top + 2) : feltAt(colX(k) + 2, top + (i - 1) * CASCADE + 9);
        const before = (await looseOf(ann)).length;
        await drag(ann, stockAt, target);
        await waitFor(async () => (await looseOf(ann)).length === before + 1, { timeout: 5000, what: `card ${i + 1} of column ${k + 1}` });
      }
    }
    const k1 = (await drawn(ann)).scale;
    const column = async (x) => (await looseOf(ann)).filter((c) => Math.round(c.x / k1) === cardAt([x, 0]).x).map((c) => Math.round(c.y / k1)).sort((a, b) => a - b);
    const cols = [];
    for (let k = 0; k < 7; k++) cols.push(await column(colX(k)));
    const cascades = cols.every((ys, k) => ys.length === k + 1 && ys.every((y, i) => y === cardAt([0, top + i * CASCADE]).y));
    check("R3, R7: with snapping, 28 cards dropped by hand make 7 cascades on the grid, each card CASCADE below the last", cascades, JSON.stringify(cols));
    // the top card of each column turned face up with a double click
    for (let k = 0; k < 7; k++) await click(ann, feltAt(colX(k), top + k * CASCADE + 6), 2);
    await waitFor(async () => (await looseOf(ann)).filter((c) => c.up).length === 7, { timeout: 5000, what: "7 cards face up" }).catch(() => {});
    check("R7: a double click turns the top of each column face up", (await looseOf(ann)).filter((c) => c.up).length === 7);
    // R4: a run: the 4th card of column 7 and the 3 on it move onto column 1's card
    // pressed in the 4th card's visible strip (6 above its centre), dropped 2 below the top: its centre lands 8 below column 1's card
    const dRun = await drag(ann, feltAt(colX(6), top + 3 * CASCADE - 6), feltAt(colX(0) + 1, top + 2));
    await waitFor(async () => (await logOf(bo)).at(-1) === `${ann.name} moved 4 cards`, { timeout: 3000, what: "the run moved" }).catch(() => {});
    const col1 = await column(colX(0));
    check("R4: picking a card in a cascade moves it and the cards on it: column 1 gets 4 more, in cascade, in one message", col1.length === 5 && col1.every((y, i) => y === cardAt([0, top + i * CASCADE]).y) && dRun.total === 1 && dRun.msgs[0].t === "moveCards", JSON.stringify({ col1, msgs: dRun.msgs }));
    // R4: column 2 moved whole by its handle (just above its bottom card) to an empty grid point
    // the card follows the hand: dropping the handle 17 above a grid point puts the bottom card on it
    const dHandle = await drag(ann, feltAt(colX(1), top - CARD_H / 2 - 3), feltAt(colX(1) + 2, top + 4 * GRID[1] - CARD_H / 2 - 2));
    await waitFor(async () => (await logOf(bo)).at(-1) === `${ann.name} moved 2 cards`, { timeout: 3000, what: "the column moved by its handle" }).catch(() => {});
    const moved2 = await column(colX(1));
    check("R4: dragging a cascade's handle moves the whole column to the grid point it is dropped on", JSON.stringify(moved2) === JSON.stringify([cardAt([0, top + 4 * GRID[1]]).y, cardAt([0, top + 4 * GRID[1] + CASCADE]).y]), JSON.stringify({ moved2, d: dHandle.msgs.map((m) => m.t) }));
    // a foundation: a card from the stock on a grid point, then the top of column 3 dropped on its upper half lands exactly on it
    const fx = GRID[0] / 2 + 11 * GRID[0], fy = top + 4 * GRID[1];
    await drag(ann, stockAt, feltAt(fx, fy));
    await waitFor(async () => (await looseOf(ann)).length === 29, { timeout: 3000, what: "a foundation card" }).catch(() => {});
    await drag(ann, feltAt(colX(2), top + 2 * CASCADE + 6), feltAt(fx + 2, fy - 7)); // pressed 6 below its centre: lands 1 above the foundation's centre
    await sleep(600);
    const onFound = await column(fx);
    check("R3: a card dropped on another's upper half lands exactly on it (a foundation)", onFound.length === 2 && onFound[0] === onFound[1], JSON.stringify(onFound));
    // R5: a pile made, moved by its handle, then removed: its card goes back to the stock
    await type(ann, "New pile", "Waste");
    await waitFor(() => hasButton(ann, "Face up"), { what: "New pile enabled" });
    await press(ann, "Face up");
    await waitFor(async () => (await logOf(bo)).includes(`${ann.name} created the pile Waste`), { what: "Waste created" });
    const wasteAt = [GRID[0] / 2, GRID[1] / 2]; // the first free place along the top of the felt
    await drag(ann, stockAt, pileAt(wasteAt));
    const wasteTo = [GRID[0] / 2 + 12 * GRID[0], GRID[1] / 2 + 5 * GRID[1]];
    await drag(ann, feltAt(wasteAt[0], wasteAt[1] - CARD_H / 2 - 3), feltAt(wasteTo[0], wasteTo[1] - CARD_H / 2 - 3));
    const pileMoved = await within(async () => (await logOf(bo)).at(-1) === `${ann.name} moved the pile Waste`, 3000);
    check("R5: a pile moves by its handle, for everybody", pileMoved >= 0, `${pileMoved} ms`);
    await click(ann, pileAt(wasteTo));
    await pressInView(ann, "Remove the pile Waste");
    const removed = await within(async () => (await logOf(bo)).at(-1) === `${ann.name} removed the pile Waste`, 3000);
    check("R5: a pile with a card in it is removed, its card back to the stock", removed >= 0, `${removed} ms`);
    // R6: the stock's top set aside: out of the game through Gather all
    await click(ann, stockAt);
    await pressInView(ann, "Set the top aside");
    await waitFor(async () => / aside$/.test((await logOf(bo)).at(-1) ?? ""), { timeout: 3000, what: "a card set aside" }).catch(() => {});
    await press(ann, "Gather all");
    await waitFor(async () => (await logOf(bo)).at(-1) === `${ann.name} gathered all the cards`, { what: "gathered" });
    await press(ann, "Count");
    const outCount = await waitFor(async () => (await modal(bo))?.texts.find((x) => x.startsWith("Count: ")) ?? null, { timeout: 5000, what: "the count" }).catch(() => "");
    check("R6: a card set aside stays out through Gather all (Count: Stock 53 and 1 set aside)", /Stock 53/.test(outCount) && /1 set aside/.test(outCount), outCount);
    // a named pile turned over as a whole: the stock, face down, comes face up (its bottom card on top)
    await click(ann, stockAt);
    await pressInView(ann, "Turn the pile over");
    const turned = await within(async () => (await logOf(bo)).at(-1) === `${ann.name} turned the pile Stock over` && (await drawn(bo)).cards.some((c) => c.where === "pile" && c.up), 3000);
    check("a named pile turns over: the log says so and its top card now shows face up on every page", turned >= 0, `${turned} ms`);
    await click(ann, stockAt);
    await pressInView(ann, "Turn the pile over"); // back face down
    // a 32-card game: the jokers, then the 2s to 6s chosen one by one, set aside from the panel
    await press(ann, "52 cards");
    await waitFor(async () => /set aside the jokers$/.test((await logOf(bo)).at(-1) ?? ""), { timeout: 3000, what: "the jokers set aside" }).catch(() => {});
    for (const r of ["2", "3", "4", "5", "6"]) await press(ann, r);
    await press(ann, "Set the chosen aside");
    const ranksOut = await within(async () => (await logOf(bo)).at(-1) === `${ann.name} set aside the 2s, 3s, 4s, 5s and 6s`, 3000);
    await press(ann, "Count");
    const deck32 = await waitFor(async () => { const x = (await modal(bo))?.texts.find((t) => t.startsWith("Count: ")); return x && x !== outCount ? x : null; }, { timeout: 5000, what: "the new count" }).catch(() => "");
    const m32 = /Stock (\d+) · (\d+) set aside/.exec(deck32 ?? "");
    check("a 32-card game from the panel: whole ranks set aside in one line of the log; at most 32 cards left, the rest set aside", ranksOut >= 0 && !!m32 && Number(m32[1]) <= 32 && Number(m32[1]) + Number(m32[2]) === 54, `${ranksOut} ms; ${deck32}`);

    const real = (u) => u.logs.filter((l) => !/WebSocket|ERR_|net::|closed/.test(l));
    for (const u of users) check(`${u.name}: no console errors`, real(u).length === 0, real(u).slice(0, 3).join(" | "));
    // leave the table as new for later scenarios that put a deck on the same tile
    await press(ann, "Reset").catch(() => {});
    await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Free table"), { timeout: 5000, what: "the table reset" }).catch(() => {});
  } catch (e) {
    // what each page showed when it failed (HQ_FAIL_SHOTS: a folder)
    if (process.env.HQ_FAIL_SHOTS) for (const u of users) await u.page.screenshot({ path: `${process.env.HQ_FAIL_SHOTS}/${u.name}.png` }).catch((x) => console.log("no shot of " + u.name + ": " + x));
    check("scenario completed", false, String((e && e.stack) || e));
  } finally {
    for (const name of ["hq-card-lastcard", "hq-card-pouilleux", PLUGIN]) await setPlugin(ctx, name, false).catch(() => {});
    await setDecks(ctx, []).catch(() => {});
    await browser.close();
  }
  return summary();
}

export { setPlugin, setDecks, viewFrame, drawn, handOf, press, modal, openWithX, drag, handAt, pileAt, feltAt, MODAL, DECK };
