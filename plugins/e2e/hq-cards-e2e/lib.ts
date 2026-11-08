// What the card scenarios share: the table's scenario here (cards.ts), Old Maid's (plugins/e2e/hq-card-pouilleux-e2e)
// and Last Card's (plugins/e2e/hq-card-lastcard-e2e), each run by e2e/plugin-run.ts against the testbed. The
// game projects list this file in their test:e2e and lint inputs. Everything a player does goes through the
// real controls: X, the window's buttons and fields, real mouse drags on the table view's canvas and the
// keyboard. What a page's view shows is read from what it drew (window.__drawn in the view: each card with its
// face, in canvas pixels) and from its live region.
import { joinAs, waitFor, walkTo, sleep, API, type Browser, type CDPSession, type ElementHandle, type Frame, type RunContext, type User } from "../../../e2e/lib.ts";
import { CARD_W, CARD_H } from "../../bundled/hq-cards/public/art.ts";
import { FX, FY, cardAt, handSpots, seatSpots } from "../../bundled/hq-cards/public/layout.ts";
import type { ToServer } from "../../bundled/hq-cards/public/messages.ts";

/** A member of a scenario: the plugin frames their page sent (countFrames), its CDP session, where they stand to play. */
export type Player = User & { sent: ToServer[]; cdp?: CDPSession; spot?: { x: number; y: number } };
/** A point of the table view, in view units. */
export type Point = { x: number; y: number };
/** A card as the table view drew it (window.__drawn in public/view.ts), in canvas pixels. */
type DrawnCard = { c: number; up: boolean; x: number; y: number; w: number; where: "hand" | "loose" | "pile" | "seat" | "look" | "pick" };
/** What the table view publishes for tests (publish() in public/view.ts). */
export type Drawn = { cards: DrawnCard[]; scale: number; layout: "narrow" | "wide"; font: number; seat: number | null; sheet: "loaded" | "loading" | null; log: string[] };
/** The admin map as a scenario edits it: only the props are touched. */
type AdminMap = { props: { t: string; x: number; y: number; w: number; h: number }[] };

export const PLUGIN = "hq-cards";
export const T = 16;
export const DECK = { x: 13, y: 22 }; // bottom row of the social area's 4x2 table at (12, 21), as the chess scenario
export const MODAL = '.modal.plugin-modal[aria-label="Cards"]';
/** Where the players stand, in pixels: in front of the deck's table, three spots side by side. */
export const FEET = 23 * T + 8;
export const SPOTS = [204, 212, 220];

const admin = (ctx: RunContext, method: string, path: string, body?: object) =>
  fetch(API + path, { method, headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: body && JSON.stringify(body) });
export const setPlugin = (ctx: RunContext, name: string, enabled: boolean) => admin(ctx, "PUT", "/api/admin/plugins/" + name, { enabled });
export async function setDecks(ctx: RunContext, at: { x: number; y: number }[]) {
  const m = (await (await admin(ctx, "GET", "/api/admin/map")).json()) as AdminMap;
  m.props = m.props.filter((p) => p.t !== PLUGIN + "/deck");
  for (const d of at) m.props.push({ t: PLUGIN + "/deck", x: d.x, y: d.y, w: 1, h: 1 });
  return (await admin(ctx, "PUT", "/api/map", m)).ok;
}

export const read = <R, A>(u: User, fn: (arg: A) => R, arg?: A): Promise<Awaited<R>> => u.page.evaluate(fn as (arg: unknown) => R, arg) as Promise<Awaited<R>>;
export async function viewFrame(u: User): Promise<Frame | null> {
  const el = await u.page.$(MODAL + ' iframe.plugin-view[data-view="table"]');
  return el ? el.contentFrame() : null;
}
/** What the page's table view drew, its seat, and its log. */
export async function drawn(u: User): Promise<Drawn | null> {
  const f = await viewFrame(u);
  return f ? f.evaluate(() => (window as unknown as { __drawn?: Drawn }).__drawn ?? null) : null;
}
export const handOf = async (u: User) => ((await drawn(u))?.cards ?? []).filter((c) => c.where === "hand");
export const looseOf = async (u: User) => ((await drawn(u))?.cards ?? []).filter((c) => c.where === "loose");
export const logOf = async (u: User) => (await drawn(u))?.log ?? [];

/** The window's controls, wherever they are: its own buttons and texts (the choice of a game, Close) and,
 * with a game, the controls of the table view's panel. */
export const modal = async (u: User) => {
  const own = await read(u, (sel: string) => {
    const m = document.querySelector(sel);
    if (!m) return null;
    return {
      buttons: [...m.querySelectorAll<HTMLButtonElement>(".plugin-body button, .modal-actions button")].map((b) => ({ text: b.textContent!.trim(), disabled: b.disabled, pressed: b.getAttribute("aria-pressed") === "true" })),
      texts: [...m.querySelectorAll(".plugin-body p")].map((p) => p.textContent!.trim()),
    };
  }, MODAL);
  if (!own) return null;
  const f = await viewFrame(u);
  const inView = f ? await f.evaluate(() => ({
    buttons: [...document.querySelectorAll<HTMLButtonElement>(".controls button")].map((b) => ({ text: b.textContent!.trim(), disabled: b.disabled, pressed: b.getAttribute("aria-pressed") === "true" })),
    texts: [...document.querySelectorAll(".controls p")].map((p) => p.textContent!.trim()),
  })).catch(() => null) : null;
  return { buttons: [...own.buttons, ...(inView?.buttons ?? [])], texts: [...own.texts, ...(inView?.texts ?? [])] };
};
export const hasButton = async (u: User, text: string) => !!(await modal(u))?.buttons.find((b) => b.text === text && !b.disabled);
/** Clicks a control by its text with the real mouse: in the window, or in the table view's panel. The panel
 * is rebuilt when the table changes: a button found just before may be gone, so it is looked for again. */
export async function press(u: User, text: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      for (const h of await u.page.$$(MODAL + " button")) if ((await h.evaluate((b) => b.textContent!.trim())) === text) return await h.click();
      const f = await viewFrame(u);
      if (f) for (const h of await f.$$(".controls button")) if ((await h.evaluate((b) => b.textContent!.trim())) === text) {
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
export async function pressInView(u: User, text: string) {
  const f = (await viewFrame(u))!;
  for (const h of await f.$$(".bar button")) if ((await h.evaluate((b) => b.textContent!.trim())) === text) return h.click();
  throw new Error("no view button " + text + " for " + u.name);
}
/** Types into a field of the table view's panel, found by its label. */
export async function type(u: User, label: string, value: string) {
  const f = (await viewFrame(u))!;
  const input = await f.evaluateHandle((label) => [...document.querySelectorAll(".controls label.field")].find((l) => l.textContent!.trim().startsWith(label))?.querySelector("input"), label) as ElementHandle<HTMLInputElement>;
  await input.click({ count: 3 }); // selects what the field holds, so typing replaces it
  await input.type(value);
}

/** Page coordinates of view points (view units), the view scrolled into sight. */
async function onPage(u: User, ...pts: Point[]) {
  await u.page.evaluate((sel) => document.querySelector(sel + " iframe.plugin-view")?.scrollIntoView({ block: "center" }), MODAL);
  const f = (await viewFrame(u))!;
  const k = (await drawn(u))!.scale;
  await f.evaluate((ys) => {
    const r = document.querySelector("canvas")!.getBoundingClientRect();
    scrollTo(0, Math.max(0, r.top + scrollY + (Math.min(...ys) + Math.max(...ys)) / 2 - innerHeight / 2));
  }, pts.map((p) => p.y * k));
  const box = (await (await f.$("canvas"))!.boundingBox())!;
  return pts.map((p) => ({ x: box.x + p.x * k, y: box.y + p.y * k }));
}
const centre = (c: Point) => ({ x: c.x + CARD_W / 2, y: c.y + CARD_H / 2 });
export const handAt = async (u: User, i: number) => centre(handSpots((await handOf(u)).length)[i]);
export const pileAt = (at: [number, number]) => centre(cardAt(at));
export const feltAt = (x: number, y: number) => ({ x: FX + x, y: FY + y });
export const seatAt = (seats: number, me: number, seat: number) => seatSpots(seats, me).find((s) => s.seat === seat)!;

/** A real mouse drag between two view points; the plg frames sent while dragging and in all. */
export async function drag(u: Player, a: Point, b: Point) {
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
/** count real clicks at a view point, 60 ms apart: the view itself takes two clicks within 400 ms as a double click. */
export async function click(u: User, p: Point, count = 1) {
  const [q] = await onPage(u, p);
  for (let i = 0; i < count; i++) {
    await u.page.mouse.click(q.x, q.y);
    if (i + 1 < count) await sleep(60);
  }
  await sleep(150);
}

/** Counts the plugin frames this page sends on its game socket (u.sent: their payloads). */
export async function countFrames(u: Player) {
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
/** Milliseconds until fn holds, or -1 past the limit. */
export async function within(fn: () => Promise<unknown>, limit: number) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = !!(await fn()); } catch { ok = false; }
    if (ok) return Date.now() - t0;
    if (Date.now() - t0 > limit) return -1;
    await sleep(40);
  }
}
const nearDeck = (u: User) => read(u, () => window.__hq.state.nearby?.t === "hq-cards/deck");
/** Walks to a spot within reach of the deck, again if a walk stopped short (another avatar in the way). */
export async function goTo(u: Player, x: number, y: number) {
  u.spot = { x, y };
  for (let i = 0; i < 3; i++) {
    await walkTo(u, x, y).catch(() => {});
    if (await waitFor(() => nearDeck(u), { timeout: 3000, what: "near" }).catch(() => false)) return;
  }
}
export async function openWithX(u: Player) {
  if (!(await nearDeck(u)) && u.spot) await goTo(u, u.spot.x, u.spot.y);
  await waitFor(() => nearDeck(u), { what: u.name + " next to the deck" });
  // X does nothing while a dialog's scrim is still on the page (a window closing): pressed until it opens
  let tries = 0;
  await waitFor(async () => {
    if (await u.page.$(MODAL)) return true;
    if (tries++ % 20 === 0) await u.page.keyboard.press("x");
    return false;
  }, { what: u.name + "'s Cards window" });
  // the choice of a game and the "not available" window have no view; a game has the table's view
  await waitFor(async () => {
    const m = await modal(u);
    return m?.buttons.some((b) => b.text === "Free table") || m?.texts.some((x) => x.startsWith("This game is not available")) || ((await viewFrame(u)) && (await drawn(u)) !== null);
  }, { what: u.name + "'s table drawn" });
}

/** The console errors of a page that count (a socket closing or a failed request does not). */
export const consoleErrors = (u: User) => u.logs.filter((l) => !/WebSocket|ERR_|net::|closed/.test(l));

/** A game's scenario before its own checks: the deck on its table (hq-cards on; it fails without them), Ann and
 * Bo at the table with the Cards window open, Bo at the CI size (800x450). Throws if a step fails. */
export async function twoAtTheTable(ctx: RunContext, browser: Browser, t: string) {
  if (!(await setPlugin(ctx, PLUGIN, true)).ok) throw new Error("hq-cards could not be turned on");
  if (!(await setDecks(ctx, [DECK]))) throw new Error("no deck placed on the table");
  const ann = await joinAs(browser, "Ann" + t, { avatar: { sk: 1, hs: 1, hc: 2, sh: 2, pa: 1 } }) as Player;
  const bo = await joinAs(browser, "Bo" + t, { avatar: { sk: 3, hs: 3, hc: 1, sh: 5, pa: 0 } }) as Player;
  for (const u of [ann, bo]) await countFrames(u);
  await Promise.all([goTo(ann, SPOTS[0], FEET), goTo(bo, SPOTS[1], FEET)]);
  await bo.page.setViewport({ width: 800, height: 450 }); // Bo plays at the CI size, as in the table's scenario
  for (const u of [ann, bo]) await openWithX(u);
  return { ann, bo };
}

/** Throws with the first lines when a page logged console errors: the game scenarios end with it (outside
 * their checks, so the table's scenario keeps the per-member checks). */
export function noConsoleErrors(users: User[]) {
  const bad = users.filter((u) => consoleErrors(u).length).map((u) => `${u.name}: ${consoleErrors(u).slice(0, 3).join(" | ")}`);
  if (bad.length) throw new Error("console errors: " + bad.join("; "));
}
