// Chess: the bundled hq-chess plugin (plugins/bundled/hq-chess), turned on by an administrator, a chessboard
// placed on a table of the map through the map API, then three members at the table (Ann, Bo, Cy) and a late
// one (Di). Everything a player does goes through the real controls: X or the hint button, the modal's
// buttons, real mouse drags and the keyboard on the board view. What a page shows is read from the view's
// canvas pixels (each piece's drawing is matched against public/pieces.ts) and its live region.
// Each check names the criterion of docs/superpowers/specs/2026-10-25-plugin-objects-chess-design.md it proves.
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, sleep, API } from "../lib.mjs";
import { paintPiece, TONES, PIECE_W, PIECE_H, SMALL_W, SMALL_H } from "../../plugins/bundled/hq-chess/public/pieces.ts";
import { START, move as playMove, place as playPlace } from "../../plugins/bundled/hq-chess/public/game.ts";

const PLUGIN = "hq-chess";
const T = 16;
const BOARD = { x: 13, y: 22 }; // bottom row of the social area's 4x2 table at (12, 21)
const BOARD2 = { x: 14, y: 22 }; // a second board on the same table, for the board switch
const sq = (name) => (8 - Number(name[1])) * 8 + "abcdefgh".indexOf(name[0]);

// ---- reading a board view: each square's 11x13 drawing (and each reserve cell's 7x8) matched against the pieces' art
const COLOURS = { [TONES.w["#"]]: "#", [TONES.w.h]: "h", [TONES.w.o]: "o", [TONES.w.s]: "s", [TONES.b.h]: "H", [TONES.b.o]: "O", [TONES.b.s]: "S" };
function masks(small) {
  const out = {};
  const [w, h] = small ? [SMALL_W, SMALL_H] : [PIECE_W, PIECE_H];
  for (const piece of "KQRBNPkqrbnp") {
    const grid = Array.from({ length: h }, () => Array(w).fill("."));
    paintPiece(piece, 0, 0, (x, y, c) => { grid[y][x] = COLOURS[c] ?? "?"; }, small);
    out[grid.map((r) => r.join("")).join("")] = piece;
  }
  return out;
}
const ART = { big: masks(false), small: masks(true), colours: COLOURS };
// the last action's tint on a light and on a dark square (public/board.ts)
const LAST = ["#cbd88a", "#8f9a48"];

const setPlugin = (ctx, enabled) => fetch(API + "/api/admin/plugins/" + PLUGIN, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify({ enabled }) });
const adminMap = (ctx) => fetch(API + "/api/admin/map", { headers: { Cookie: "hq_session=" + ctx.adminCookie } }).then((r) => r.json());
const putMap = (ctx, m) => fetch(API + "/api/map", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify(m) });
/** Puts chessboards at these tiles (and removes every other one). */
async function setBoards(ctx, at) {
  const m = await adminMap(ctx);
  m.props = m.props.filter((p) => p.t !== PLUGIN + "/chessboard");
  for (const b of at) m.props.push({ t: PLUGIN + "/chessboard", x: b.x, y: b.y, w: 1, h: 1 });
  return (await putMap(ctx, m)).ok;
}

const read = (u, fn, arg) => u.page.evaluate(fn, arg);
const MODAL = '.modal.plugin-modal[aria-label="Chess"]';
const modalOpen = async (u) => !!(await u.page.$(MODAL));
async function viewFrame(u) {
  const el = await u.page.$(MODAL + ' iframe.plugin-view[data-view="board"]');
  return el ? el.contentFrame() : null;
}
const chessFrame = async (u) => (await u.page.$(`iframe.plugin-frame[data-plugin="${PLUGIN}"]`))?.contentFrame();

/** The board a page's view draws: p (64 letters, a8..h1, "." empty, "?" unknown), the reserve of each side, and the live region. */
async function board(u) {
  const f = await viewFrame(u);
  if (!f) return null;
  return f.evaluate(({ big, small, colours, flip, lastTint }) => {
    const c = document.querySelector("canvas");
    if (!c) return null;
    const W = c.width, H = c.height;
    const d = c.getContext("2d").getImageData(0, 0, W, H).data;
    const at = (x, y) => {
      const i = (y * W + x) * 4;
      return colours["#" + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")] ?? ".";
    };
    const mask = (x, y, w, h) => {
      let s = "";
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) s += at(x + i, y + j);
      return s;
    };
    const empty = (m) => /^\.+$/.test(m);
    const hex = (x, y) => { const i = (y * W + x) * 4; return "#" + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join(""); };
    const strip = (H - 128) / 2;
    let p = "";
    const last = []; // the squares tinted as the last action's, a8 = 0
    for (let sq = 0; sq < 64; sq++) {
      const i = flip ? 63 - sq : sq;
      const m = mask((i % 8) * 16 + 2, strip + Math.floor(i / 8) * 16 + 2, 11, 13);
      p += empty(m) ? "." : (big[m] ?? "?");
      // a square's pixel (1, 1): clear of the pieces (drawn from 2, 2) and of the 1 px frames on its edge
      if (lastTint.includes(hex((i % 8) * 16 + 1, strip + Math.floor(i / 8) * 16 + 1))) last.push(sq);
    }
    const cells = (y0) => {
      let s = "";
      for (let j = 0; j < ((strip - 2) / 8) * 16; j++) {
        const m = mask((j % 16) * 8, y0 + 1 + Math.floor(j / 16) * 8, 7, 8);
        if (empty(m)) break;
        s += small[m] ?? "?";
      }
      return s;
    };
    const top = cells(0), bottom = cells(strip + 128);
    return { p, last, w: flip ? top : bottom, b: flip ? bottom : top, live: document.querySelector("[aria-live]")?.textContent ?? "" };
  }, { ...ART, flip: u.flip, lastTint: LAST });
}

const canvasSize = async (u) => (await viewFrame(u)).evaluate(() => ({ w: document.querySelector("canvas").width, h: document.querySelector("canvas").height }));
/** A square's centre in canvas pixels on that member's view (Black's view is turned around). */
async function squareAt(u, s) {
  const strip = ((await canvasSize(u)).h - 128) / 2;
  const i = u.flip ? 63 - s : s;
  return { cx: (i % 8) * 16 + 8, cy: strip + Math.floor(i / 8) * 16 + 8 };
}
/** Cell j of a side's reserve strip, in canvas pixels. */
async function cellAt(u, side, j) {
  const strip = ((await canvasSize(u)).h - 128) / 2;
  const y0 = side === (u.flip ? "w" : "b") ? 0 : strip + 128;
  return { cx: (j % 16) * 8 + 4, cy: y0 + 1 + Math.floor(j / 16) * 8 + 4 };
}
/**
 * Page coordinates of canvas points. On a short screen (CI's 800x450) the window scrolls and so does the view
 * (the board keeps 2x): the view is brought into the window's sight, then scrolled to centre the points.
 */
async function onPage(u, ...pts) {
  await u.page.evaluate((sel) => document.querySelector(sel + " iframe.plugin-view")?.scrollIntoView({ block: "center" }), MODAL);
  const f = await viewFrame(u);
  await f.evaluate((ys) => {
    const c = document.querySelector("canvas"), r = c.getBoundingClientRect(), k = r.width / c.width;
    const mid = r.top + scrollY + ((Math.min(...ys) + Math.max(...ys)) / 2) * k;
    scrollTo(0, Math.max(0, mid - innerHeight / 2));
  }, pts.map((p) => p.cy));
  const box = await (await f.$("canvas")).boundingBox();
  const k = box.width / (await canvasSize(u)).w;
  return pts.map((p) => ({ x: box.x + p.cx * k, y: box.y + p.cy * k }));
}
const downs = async (u) => (await (await viewFrame(u))?.evaluate(() => window.__downs ?? 0)) ?? 0;
/** A real mouse drag between two canvas points (pointer down, several moves, up); returns the plg frames sent while dragging and in all,
 * and whether the press reached the board. */
async function drag(u, fromAt, toAt) {
  const [from, to] = await onPage(u, fromAt, toAt);
  const n0 = u.sent.length, d0 = await downs(u);
  await u.page.mouse.move(from.x, from.y);
  await u.page.mouse.down();
  await u.page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await u.page.mouse.move(to.x, to.y, { steps: 6 });
  await sleep(200); // CDP reports a sent frame asynchronously: let any frame sent while dragging arrive
  const during = u.sent.length - n0;
  await u.page.mouse.up();
  await sleep(250);
  return { during, total: u.sent.length - n0, msgs: u.sent.slice(n0), reached: (await downs(u)) > d0 };
}
const dragSq = async (u, a, b) => drag(u, await squareAt(u, sq(a)), await squareAt(u, sq(b)));

/** The modal's buttons and its muted line naming the seat holders. */
const modalState = (u) => read(u, (sel) => {
  const m = document.querySelector(sel);
  if (!m) return null;
  return {
    buttons: [...m.querySelectorAll(".plugin-body button")].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, pressed: b.getAttribute("aria-pressed") === "true" })),
    holders: m.querySelector(".plugin-body p.muted")?.textContent ?? "",
  };
}, MODAL);
const button = async (u, text) => (await modalState(u))?.buttons.find((b) => b.text === text || b.text.startsWith(text + ":"));
/** Clicks a modal button with the real mouse. */
async function press(u, text) {
  const handles = await u.page.$$(MODAL + " button");
  for (const h of handles) if ((await h.evaluate((b) => b.textContent.trim())) === text) return h.click();
  throw new Error("no button " + text + " for " + u.name);
}
/** Opens the board within reach with the X key, as a player does. */
async function openWithX(u) {
  await waitFor(() => read(u, () => window.__hq.state.nearby?.t === "hq-chess/chessboard"), { what: u.name + " next to a chessboard" });
  await u.page.keyboard.press("x");
  await waitFor(() => viewFrame(u), { what: u.name + "'s chess window" });
  await waitFor(async () => !(await board(u))?.p.includes("?") && (await board(u)) !== null, { what: u.name + "'s board drawn" });
  await listen(u);
}
/** Records everything the view's live region says (window.__said). */
async function listen(u) {
  const f = await viewFrame(u);
  await f.evaluate(() => {
    if (window.__said) return;
    window.__said = [];
    window.__downs = 0; // pointer presses that reached the board: a refused drag is only proof if it got there
    document.querySelector("canvas").addEventListener("pointerdown", () => window.__downs++);
    const live = document.querySelector("[aria-live]");
    new MutationObserver(() => { if (live.textContent) window.__said.push(live.textContent); }).observe(live, { childList: true, characterData: true, subtree: true });
  });
}
const said = async (u) => (await (await viewFrame(u))?.evaluate(() => window.__said ?? [])) ?? [];
/** Counts the plugin frames this page sends on its game socket (u.sent: their payloads). */
async function countFrames(u) {
  u.sent = [];
  u.sentAt = []; // when each was seen (Date.now())
  const s = await u.page.createCDPSession();
  await s.send("Network.enable");
  s.on("Network.webSocketFrameSent", (e) => {
    try {
      const m = JSON.parse(e.response.payloadData);
      if (m.t === "plg" && m.pl === PLUGIN) { u.sent.push(m.d); u.sentAt.push(Date.now()); }
      if (m.t === "use") u.usedAt = Date.now(); // X on an object
    } catch { /* not JSON */ }
  });
}
/** Whether fn() comes to hold within ms (another page catching up): waits, never samples once. */
const until = (fn, ms = 5000, what = "condition") => waitFor(fn, { timeout: ms, what }).then(() => true, () => false);
/** How long until fn() holds, in ms, or -1 past limit. */
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
const badgeOf = (u, id) => read(u, (id) => {
  const b = (window.__hq.session.plugins?.debug("hq-chess") ?? []).find((c) => c.id === "badge-" + id) ?? null;
  const e = window.__hq.view.ents.get(id);
  return { badge: b, ent: e ? { x: e.x, y: e.y, on: e.spr.visible } : null };
}, id);
/** The badge sits above that member's head on that page, in their colour. */
const badgeAbove = (s, side) => !!s.badge && s.badge.visible && s.badge.anim === side && !!s.ent && Math.abs(s.badge.x - s.ent.x) < 0.5 && s.badge.y < s.ent.y - 20 && s.badge.y > s.ent.y - 60;

export async function run(ctx) {
  resetChecks();
  const browser = await launch();
  let ann, bo, cy, di;
  try {
    const t = String(Date.now() % 10000);
    // ---- set up: the plugin on, a board (and a second one beside it) on the social area's table
    check("an administrator turns hq-chess on (admin API)", (await setPlugin(ctx, true)).ok);
    check("a chessboard is placed on the bottom row of a table through the map API", await setBoards(ctx, [BOARD, BOARD2]));
    ann = await joinAs(browser, "Ann" + t, { avatar: { sk: 1, hs: 1, hc: 2, sh: 2, pa: 1 } });
    bo = await joinAs(browser, "Bo" + t, { avatar: { sk: 3, hs: 3, hc: 1, sh: 5, pa: 0 } });
    cy = await joinAs(browser, "Cy" + t, { avatar: { sk: 0, hs: 2, hc: 3, sh: 1, pa: 2 } });
    for (const u of [ann, bo, cy]) { u.flip = false; await countFrames(u); }
    // south of the board, within reach of it (20 px) and nearer to it than to the second board
    const feet = 23 * T + 8;
    await Promise.all([walkTo(ann, 204, feet), walkTo(bo, 212, feet), walkTo(cy, 220, feet)]);

    // ---- criterion 4: the board on the table, and the X hint
    const sprites = await waitFor(async () => {
      const s = await read(ann, () => window.__hq.view.objSprites.filter((x) => !x.destroyed).map((x) => ({ x: x.x, y: x.y, w: x.texture.width, h: x.texture.height, z: x.zIndex, on: x.visible })));
      return s.some((x) => x.w === 16) ? s : null;
    }, { what: "the chessboard sprite" });
    const sprite = sprites.find((s) => s.x === BOARD.x * T);
    check("4: the board's sprite is drawn on its tile of the table (16x16, bottom on the table's bottom edge)", !!sprite && sprite.w === 16 && sprite.h === 16 && sprite.y === (BOARD.y + 1) * T && sprite.on, JSON.stringify(sprites));
    const hint = await waitFor(() => read(ann, () => document.querySelector(".interaction-hint")?.textContent ?? ""), { what: "the X hint" });
    check("4: standing beside it, the X hint names it", hint.includes("Chessboard") && hint.includes("X"), JSON.stringify(hint));

    // ---- X opens the window (Ann and Bo with the key, Cy with the hint button)
    await openWithX(ann);
    await openWithX(bo);
    await waitFor(() => read(cy, () => { const b = document.querySelector(".interaction-hint"); b?.click(); return !!b; }), { what: "Cy's hint button" });
    await waitFor(() => viewFrame(cy), { what: "Cy's chess window" });
    await waitFor(async () => (await board(cy))?.p === START, { what: "Cy's board" });
    await listen(cy);
    const viewTitle = await read(ann, (sel) => document.querySelector(sel + " iframe.plugin-view")?.title, MODAL);
    check("X opens the Chess window with the board view (iframe titled Chessboard)", (await modalOpen(ann)) && viewTitle === "Chessboard" && (await board(ann)).p === START, viewTitle);

    // ---- the window fits a 1280x720 screen without scrolling: seats, the board with both strips, Close
    const small = ann.page.viewport();
    await ann.page.setViewport({ width: 1280, height: 720 });
    await sleep(500);
    const fitAt = async () => {
      const f = await viewFrame(ann);
      const inner = await f.evaluate(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width, scroll: document.documentElement.scrollHeight > innerHeight }; });
      return read(ann, ({ sel, inner }) => {
        const m = document.querySelector(sel), H = innerHeight;
        const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
        const btn = (text) => [...m.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
        const frame = m.querySelector("iframe.plugin-view").getBoundingClientRect();
        const parts = { title: rect(m.querySelector("h2") ?? m), seats: rect(btn("White").parentElement), holders: rect(m.querySelector(".plugin-body p.muted")), undo: rect(btn("Undo") ?? m), reset: rect(btn("Reset")), boardTop: Math.round(frame.top + inner.top), stripBottom: Math.round(frame.top + inner.bottom), close: rect(btn("Close")) };
        const inside = (r) => r.top >= 0 && r.bottom <= H;
        const body = m.querySelector(".plugin-body"), mr = m.getBoundingClientRect();
        return { H, parts, scale: inner.width / 128, modal: { w: Math.round(mr.width), h: Math.round(mr.height) }, undo: !!btn("Undo"),
          modalScrolls: m.scrollHeight > m.clientHeight || body.scrollHeight > body.clientHeight, viewScrolls: inner.scroll, pageScrolls: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
          ok: inside(parts.title) && inside(parts.seats) && inside(parts.holders) && inside(parts.undo) && inside(parts.reset) && parts.boardTop >= 0 && parts.stripBottom <= H && inside(parts.close) };
      }, { sel: MODAL, inner });
    };
    const fit720 = await fitAt();
    check("at 1280x720 the Chess window takes the screen (1256 x 696) and all of it shows without scrolling: title, seats, holders, Undo, Reset, the board with its bottom strip, Close", fit720.ok && fit720.undo && fit720.modal.w === 1256 && fit720.modal.h === 696 && !fit720.modalScrolls && !fit720.viewScrolls && !fit720.pageScrolls, JSON.stringify(fit720));
    check("at 1280x720 the pieces are drawn at a whole scale of at least 3x (2x before the window was full screen)", fit720.scale >= 3 && Number.isInteger(fit720.scale), String(fit720.scale));
    await ann.page.setViewport(small);
    await sleep(500);
    const order = await read(ann, (sel) => {
      const m = document.querySelector(sel);
      const seats = [...m.querySelectorAll("button")].find((b) => b.textContent.trim() === "White");
      return !!(seats.compareDocumentPosition(m.querySelector("iframe.plugin-view")) & Node.DOCUMENT_POSITION_FOLLOWING);
    }, MODAL);
    check("the seat buttons come before the board in reading order (a small screen scrolls to the board)", order);
    // the plugin's two frames declare their language and have a title (the host's srcdoc)
    const docs = { view: await (await viewFrame(ann)).evaluate(() => [document.documentElement.lang, document.title]), hidden: await (await chessFrame(ann)).evaluate(() => [document.documentElement.lang, document.title]) };
    check("the view's document and the plugin's hidden frame have lang=en and a title (Chessboard, Chess)", JSON.stringify(docs) === JSON.stringify({ view: ["en", "Chessboard"], hidden: ["en", "Chess"] }), JSON.stringify(docs));

    // ---- criterion 5: seats
    await press(ann, "White");
    await waitFor(async () => (await button(ann, "White"))?.text === "White: " + ann.name, { what: "Ann seated" });
    await waitFor(async () => (await button(bo, "Black"))?.disabled === false, { what: "Black free on Bo's page" });
    await press(bo, "Black");
    bo.flip = true;
    await waitFor(async () => (await button(cy, "Black"))?.text === "Black: " + bo.name, { what: "Bo seated, on Cy's page" });
    const annSeats = await modalState(ann), cySeats = await modalState(cy);
    const b = (s, text) => s.buttons.find((x) => x.text === text || x.text.startsWith(text + ":"));
    check("5: Ann takes White and Bo Black; every page names them", b(cySeats, "White").text === "White: " + ann.name && b(cySeats, "Black").text === "Black: " + bo.name && cySeats.holders === `White: ${ann.name} (here) · Black: ${bo.name} (here)`, JSON.stringify(cySeats));
    check("5: Cy, without a seat, just watches (neither White nor Black pressed; both seats taken)", !b(cySeats, "White").pressed && !b(cySeats, "Black").pressed && b(cySeats, "White").disabled && b(cySeats, "Black").disabled, JSON.stringify(cySeats.buttons));
    check("7: a seated player cannot change side (Ann's White pressed and disabled, Black disabled)", b(annSeats, "White").pressed && b(annSeats, "White").disabled && b(annSeats, "Black").disabled, JSON.stringify(annSeats.buttons));
    await waitFor(async () => (await board(bo))?.p === START, { what: "Bo's board turned for Black" });

    // ---- criterion 13: the playing badges on Cy's page
    const badgesUp = await waitFor(async () => {
      const a = await badgeOf(cy, ann.id), o = await badgeOf(cy, bo.id);
      return badgeAbove(a, "w") && badgeAbove(o, "b") ? { a, o } : null;
    }, { timeout: 5000, what: "badges on Cy's page" }).catch(() => null);
    check("13: Cy's page shows a white badge above Ann and a black one above Bo", !!badgesUp, JSON.stringify([await badgeOf(cy, ann.id), await badgeOf(cy, bo.id)]));
    const spectatorBadge = [];
    for (let i = 0; i < 5; i++) { spectatorBadge.push(!!(await badgeOf(ann, cy.id)).badge); await sleep(100); }
    check("13: no badge over a spectator (sampled for 500 ms)", spectatorBadge.every((x) => !x), JSON.stringify(spectatorBadge));

    // ---- criterion 5: a spectator cannot move, White cannot move a black piece
    let expected = { p: START, r: "", w: { id: ann.id, name: "" }, b: { id: bo.id, name: "" } };
    const cyTry = await dragSq(cy, "e2", "e4");
    await sleep(600);
    check("5: Cy (spectator) cannot pick a piece up: his press reaches the board, nothing sent, every board unchanged", cyTry.reached && cyTry.total === 0 && (await board(cy)).p === START && (await board(ann)).p === START, JSON.stringify(cyTry));
    const annBlack = await dragSq(ann, "e7", "e5");
    await sleep(600);
    check("5: Ann (White) cannot move a black piece: her press reaches the board, nothing sent, every board unchanged", annBlack.reached && annBlack.total === 0 && (await board(ann)).p === START && (await board(bo)).p === START, JSON.stringify(annBlack));

    // ---- criteria 6 and 10: e2-e4 dragged by Ann, seen by Bo and Cy within 1 s; one frame per drop
    playMove(expected, ann.id, sq("e2"), sq("e4"));
    const n0 = ann.sent.length;
    const [from, to] = await onPage(ann, await squareAt(ann, sq("e2")), await squareAt(ann, sq("e4")));
    await ann.page.mouse.move(from.x, from.y);
    await ann.page.mouse.down();
    await ann.page.mouse.move(from.x, (from.y + to.y) / 2, { steps: 10 });
    await ann.page.mouse.move(to.x, to.y, { steps: 10 });
    await sleep(200); // CDP reports a sent frame asynchronously: let any frame sent while dragging arrive
    const whileDragging = ann.sent.length - n0;
    await ann.page.mouse.up();
    const [boMs, cyMs] = await Promise.all([bo, cy].map((u) => within(async () => (await board(u))?.p === expected.p, 1000)));
    check("6: a drag e2-e4 by White shows on Bo's and Cy's boards within 1 s", boMs >= 0 && cyMs >= 0, `Bo ${boMs} ms, Cy ${cyMs} ms`);
    await sleep(300);
    const sentDrop = ann.sent.slice(n0);
    check("10: none sent while dragging (20 pointer moves), exactly one plg frame for the drop", whileDragging === 0 && sentDrop.length === 1 && sentDrop[0].t === "move" && sentDrop[0].from === sq("e2") && sentDrop[0].to === sq("e4"), JSON.stringify({ whileDragging, sentDrop }));
    check("6: Ann's own board shows the move", (await board(ann)).p === expected.p);

    // ---- the board switch: Cy opens the second board in the same window; a fresh board one move away
    // from the first must not be announced as a move (e4 back to e2)
    const cySaid0 = (await said(cy)).length;
    await walkTo(cy, BOARD2.x * T + 24, feet);
    await waitFor(() => read(cy, (x) => window.__hq.state.nearby?.x === x, BOARD2.x), { what: "Cy next to the second board" });
    // X is ignored while a window is open and the hint button is under the dialog's scrim: a player cannot
    // reach this path through the UI; the page's interact() (what X calls) stands in for it
    await read(cy, () => window.__hq.view.interact());
    await waitFor(async () => (await board(cy))?.p === START, { what: "Cy's window on the second board" });
    await sleep(1200);
    const switchSaid = (await said(cy)).slice(cySaid0);
    check("a viewer who opens a second board in the same window hears no false move", !switchSaid.some((s) => /pawn|to reserve|from reserve/.test(s)), JSON.stringify(switchSaid));
    await walkTo(cy, 220, feet);
    await waitFor(() => read(cy, (x) => window.__hq.state.nearby?.x === x, BOARD.x), { what: "Cy back at the first board" });
    await read(cy, () => window.__hq.view.interact());
    await waitFor(async () => (await board(cy))?.p === expected.p, { what: "Cy's window back on the first board" });
    await sleep(800);
    const backSaid = (await said(cy)).slice(cySaid0);
    check("and back on the first board, nothing is announced either", !backSaid.some((s) => /pawn|to reserve|from reserve/.test(s)), JSON.stringify(backSaid));
    check("back on the first board, the window shows its players again", (await modalState(cy)).holders.startsWith("White: " + ann.name), (await modalState(cy)).holders);
    await setBoards(ctx, [BOARD]); // the second board's job is done
    await waitFor(() => read(ann, () => window.__hq.view.objSprites.filter((x) => !x.destroyed).length === 1), { what: "second board removed" });

    // ---- criterion 6: a drop outside the board puts the piece back; click-then-click
    const outside = await squareAt(ann, sq("d2"));
    const out = await drag(ann, outside, { cx: -30, cy: outside.cy }); // left of the canvas
    check("6: a drop outside the board puts the piece back (pressed on the board, nothing sent, board unchanged)", out.reached && out.total === 0 && (await board(ann)).p === expected.p, JSON.stringify(out));
    const nClick = ann.sent.length;
    const [g1, f3] = await onPage(ann, await squareAt(ann, sq("g1")), await squareAt(ann, sq("f3")));
    await ann.page.mouse.click(g1.x, g1.y);
    await sleep(200);
    const afterFirst = ann.sent.length - nClick;
    await ann.page.mouse.click(f3.x, f3.y);
    playMove(expected, ann.id, sq("g1"), sq("f3"));
    const clickMs = await within(async () => (await board(bo))?.p === expected.p, 1000);
    check("6: click-then-click moves a piece (Ng1-f3 reaches Bo), one frame, sent on the second click", afterFirst === 0 && clickMs >= 0 && ann.sent.length - nClick === 1, `Bo ${clickMs} ms, frames ${ann.sent.length - nClick}`);

    // ---- the last action highlighted, and the undo through the real Undo button
    const g1f3 = [sq("f3"), sq("g1")].sort((a, z) => a - z).join();
    const lit = await Promise.all([ann, bo, cy].map((u) => until(async () => (await board(u))?.last.join() === g1f3, 2000)));
    check("the last move's two squares (g1, f3) are tinted on every page, Black's turned board included", lit.every(Boolean), JSON.stringify(await Promise.all([ann, bo, cy].map(async (u) => (await board(u))?.last))));
    const undoable = await until(async () => (await button(bo, "Undo"))?.disabled === false && (await button(ann, "Undo"))?.disabled === false && (await button(cy, "Undo"))?.disabled === true);
    check("Undo is enabled for both seated players and disabled for the spectator", undoable, JSON.stringify([await button(ann, "Undo"), await button(bo, "Undo"), await button(cy, "Undo")]));
    if (undoable) {
      const annSaidU = (await said(ann)).length, nUndo = bo.sent.length;
      const beforeUndo = expected.p;
      expected.p = expected.p.slice(0, sq("f3")) + "." + expected.p.slice(sq("f3") + 1, sq("g1")) + "N" + expected.p.slice(sq("g1") + 1);
      await press(bo, "Undo"); // Bo undoes Ann's move
      const undoSeen = await Promise.all([ann, bo, cy].map((u) => within(async () => { const s = await board(u); return s?.p === expected.p && s.last.length === 0; }, 1000)));
      check("Bo presses Undo: Ann's Ng1-f3 is undone on all three pages within 1 s, no square tinted", expected.p !== beforeUndo && undoSeen.every((ms) => ms >= 0), JSON.stringify(undoSeen));
      check("one frame for the undo ({t: undo})", bo.sent.length - nUndo === 1 && bo.sent[nUndo]?.t === "undo", JSON.stringify(bo.sent.slice(nUndo)));
      const undoHeard = await waitFor(async () => (await said(ann)).slice(annSaidU).find((s) => s === "Black undid the last move"), { timeout: 2000, what: "the undo announced" }).catch(() => null);
      check("Ann's live region announces it: Black undid the last move", !!undoHeard, JSON.stringify((await said(ann)).slice(annSaidU)));
      const oneLevel = await until(async () => (await button(bo, "Undo"))?.disabled === true && (await button(ann, "Undo"))?.disabled === true);
      check("one level only: after the undo, Undo is disabled for both players", oneLevel, JSON.stringify([await button(ann, "Undo"), await button(bo, "Undo")]));
    }

    // ---- criterion 11: a keyboard-only move by Bo reaches Ann and is announced there
    const annSaid0 = (await said(ann)).length;
    const boView = await viewFrame(bo);
    let focused = false;
    for (let i = 0; i < 25 && !focused; i++) {
      await bo.page.keyboard.press("Tab");
      focused = await boView.evaluate(() => document.hasFocus() && document.activeElement === document.querySelector("canvas"));
    }
    check("11: Tab reaches the board view's canvas", focused);
    await bo.page.keyboard.press("ArrowUp"); // shows the cursor, on e7 for Black
    await sleep(150);
    const cursorSays = (await board(bo)).live;
    await bo.page.keyboard.press("Enter");
    await bo.page.keyboard.press("ArrowUp");
    await bo.page.keyboard.press("ArrowUp");
    await bo.page.keyboard.press("Enter");
    playMove(expected, bo.id, sq("e7"), sq("e5"));
    const keyMs = await within(async () => (await board(ann))?.p === expected.p, 1000);
    check("11: arrows and Enter only: Bo's e7-e5 reaches Ann's board within 1 s", keyMs >= 0 && cursorSays.startsWith("e7, black pawn"), `${keyMs} ms; cursor said ${JSON.stringify(cursorSays)}`);
    const annHeard = await waitFor(async () => (await said(ann)).slice(annSaid0).find((s) => s === "Black: pawn e7 to e5"), { timeout: 2000, what: "the announcement" }).catch(() => null);
    check("11: Ann's live region announces it", !!annHeard, JSON.stringify((await said(ann)).slice(annSaid0)));

    // ---- a move lost on the way is undone after 1 s. The page drops the plugin's next message to the server
    // as a spent send budget does (test hook: deterministic, where flooding the budget raced its refill)
    await read(ann, (pl) => window.__hq.session.plugins.dropNext(pl, 1), PLUGIN);
    const nLost = ann.sent.length;
    const lostSaid0 = (await said(ann)).length;
    await dragSq(ann, "d2", "d4");
    const optimistic = (await board(ann)).p;
    const revertMs = await within(async () => (await board(ann))?.p === expected.p, 2500);
    await read(ann, (pl) => window.__hq.session.plugins.dropNext(pl, 0), PLUGIN); // nothing left to drop
    const lostSent = ann.sent.slice(nLost);
    check("a move dropped at the page (over the send budget) never left it", lostSent.length === 0, JSON.stringify(lostSent));
    // the live region is filled on the next animation frame
    const told = await waitFor(async () => (await said(ann)).slice(lostSaid0).some((s) => s.startsWith("Move not received")), { timeout: 1000, what: "the lost move announced" }).catch(() => false);
    // revertMs counts from after the drop's own 250 ms pause (drag()): the view's timer is 1 s from the drop
    check("the view showed it at once, then went back to the server's position about 1 s after the drop, and says so", optimistic[sq("d4")] === "P" && revertMs >= 500 && revertMs <= 1500 && told, `${revertMs} ms after the drop's pause, ${JSON.stringify((await said(ann)).slice(lostSaid0))}`);
    check("nobody else saw the lost move", (await board(bo)).p === expected.p && (await board(cy)).p === expected.p);

    // ---- criteria 6 and 14: captures go to the reserve on every page; a reserve piece back on the board; promotion
    await dragSq(bo, "d7", "d5");
    playMove(expected, bo.id, sq("d7"), sq("d5"));
    await waitFor(async () => (await board(ann))?.p === expected.p, { timeout: 3000, what: "d7-d5 on Ann's board" });
    const cap = await dragSq(ann, "e4", "d5");
    playMove(expected, ann.id, sq("e4"), sq("d5"));
    const capSeen = await Promise.all([ann, bo, cy].map((u) => within(async () => { const s = await board(u); return s.p === expected.p && s.b === "p" && s.w === ""; }, 1000)));
    check("6, 10: dropping on an occupied square removes the piece there (exd5); nothing sent while dragging, one frame", cap.during === 0 && cap.total === 1 && capSeen.every((ms) => ms >= 0), JSON.stringify(capSeen));
    check("14: the captured black pawn shows in Black's reserve strip on all three pages", capSeen.every((ms) => ms >= 0), JSON.stringify(await Promise.all([ann, bo, cy].map(board))));
    await dragSq(bo, "d8", "d5");
    playMove(expected, bo.id, sq("d8"), sq("d5"));
    await waitFor(async () => { const s = await board(ann); return s.p === expected.p && s.w === "P"; }, { timeout: 3000, what: "Qxd5 on Ann's board" });
    const place = await drag(ann, await cellAt(ann, "w", 0), await squareAt(ann, sq("e3")));
    playPlace(expected, ann.id, "P", sq("e3"));
    const placeSeen = await Promise.all([ann, bo, cy].map((u) => within(async () => { const s = await board(u); return s.p === expected.p && s.w === "" && s.b === "p"; }, 1000)));
    check("14: Ann drags her captured pawn from the reserve back onto e3, seen on every page", place.during === 0 && place.total === 1 && place.msgs[0].t === "place" && placeSeen.every((ms) => ms >= 0), JSON.stringify({ place: place.msgs, placeSeen }));
    const placeLit = await until(async () => (await board(bo))?.last.join() === String(sq("e3")) && (await board(ann))?.last.join() === String(sq("e3")), 2000);
    check("a pawn placed from the reserve: only its square (e3) is tinted, on Ann's page and on Bo's turned board", placeLit, JSON.stringify([(await board(ann)).last, (await board(bo)).last]));
    // a white pawn dropped on e8: the choice opens, Queen is clicked
    const nPromo = ann.sent.length;
    const promoDrop = await dragSq(ann, "a2", "e8");
    const choiceOpen = promoDrop.during === 0 && promoDrop.total === 0 && (await board(ann)).live.includes("Becomes a queen");
    // the choice's box: four 10 px cells under e8 (row 0), from x = 51; the queen is the first
    const strip8 = ((await canvasSize(ann)).h - 128) / 2;
    const [queenCell] = await onPage(ann, { cx: 57, cy: strip8 + 16 + 6 });
    await ann.page.mouse.click(queenCell.x, queenCell.y);
    playMove(expected, ann.id, sq("a2"), sq("e8"), "q");
    const promoSeen = await Promise.all([ann, bo, cy].map((u) => within(async () => (await board(u))?.p === expected.p, 1000)));
    const queens = [...(await board(cy)).p].filter((c) => c === "Q").length;
    check("14: a white pawn dropped on e8 opens the choice; Queen makes a second white queen on every page", choiceOpen && queens === 2 && promoSeen.every((ms) => ms >= 0) && ann.sent.length - nPromo === 1 && ann.sent[nPromo]?.promote === "q", JSON.stringify({ choiceOpen, queens, promoSeen, sent: ann.sent.slice(nPromo) }));
    check("14: the black king it landed on went to the reserve", (await board(bo)).b === "pk", (await board(bo)).b);

    // ---- criterion 13: the badge follows Ann as she walks (Cy's page), drawn over her name tag every frame
    const follow = ann.page.evaluate(async () => {
      const v = window.__hq.view, wait = (ms) => new Promise((r) => setTimeout(r, ms));
      v.setDirection(-1, 0); await wait(900);
      v.setDirection(0, 0); await wait(300);
      v.setDirection(1, 0); await wait(900);
      v.setDirection(0, 0);
    });
    const samples = [];
    for (let i = 0; i < 12; i++) { samples.push(await badgeOf(cy, ann.id)); await sleep(150); }
    await follow;
    const xs = samples.map((s) => s.ent?.x ?? 0);
    check("13: the badge follows Ann as she walks, above her head in every sample", samples.every((s) => badgeAbove(s, "w")) && Math.max(...xs) - Math.min(...xs) > 30, JSON.stringify(samples.map((s) => [s.badge?.x, s.ent?.x])));
    await walkTo(ann, 204, feet);

    // ---- onJoin: a member arriving while a game is on gets the badges; they are hidden while off screen
    di = await joinAs(browser, "Di" + t, { avatar: { sk: 2, hs: 0, hc: 4, sh: 3, pa: 1 } });
    const late = await waitFor(async () => { const a = await badgeOf(di, ann.id), o = await badgeOf(di, bo.id); return a.badge && o.badge ? { a, o } : null; }, { timeout: 5000, what: "badges on Di's page" }).catch(() => null);
    check("onJoin: Di, arriving during the game, gets both badges (white for Ann, black for Bo)", !!late && late.a.badge.anim === "w" && late.o.badge.anim === "b", JSON.stringify(late));
    check("13: at the entrance, far from the table, Ann is off Di's screen and so is her badge", !!late && !late.a.badge.visible && !(late.a.ent?.on ?? false), JSON.stringify(late?.a));
    await walkTo(di, BOARD.x * T + 8, 20 * T + 8); // north of the table
    const near = await waitFor(async () => { const a = await badgeOf(di, ann.id); return badgeAbove(a, "w") ? a : null; }, { timeout: 5000, what: "Ann's badge on Di's screen" }).catch(() => null);
    check("13: once Ann is on Di's screen, her badge shows above her", !!near, JSON.stringify(await badgeOf(di, ann.id)));

    // ---- criterion 7: away, back in the seat, reset
    // Bo reloads. The server keeps a member through a reload (reconnect grace), so the plugin learns of it
    // when the reloaded page starts the plugin and says hello: that is when "away" can start, and the 1 s is
    // measured from there. The time from the reload itself is reported (it includes loading the page).
    const firstTrue = async (fn) => { for (const t0 = Date.now(); Date.now() - t0 < 15000; await sleep(40)) { try { if (await fn()) return Date.now(); } catch { /* reloading */ } } return NaN; };
    // the clocks below start only once the precondition holds: Bo here on Ann's page, his badge on Cy's
    const preReload = await until(async () => (await modalState(ann)).holders.endsWith(`Black: ${bo.name} (here)`) && badgeAbove(await badgeOf(cy, bo.id), "b"));
    check("before Bo reloads: Ann sees him here and Cy's page shows his badge", preReload);
    const nBo = bo.sent.length, reloadAt = Date.now();
    const awayAt = firstTrue(async () => (await modalState(ann)).holders === `White: ${ann.name} (here) · Black: ${bo.name} (away)`);
    const badgeAt = firstTrue(async () => !(await badgeOf(cy, bo.id)).badge);
    await bo.page.reload({ waitUntil: "domcontentloaded" });
    const helloAt = await waitFor(() => { const i = bo.sent.findIndex((d, j) => j >= nBo && d.t === "hello"); return i >= 0 ? bo.sentAt[i] : null; }, { timeout: 15000, what: "the reloaded page's hello" });
    const [away, badgeGone] = await Promise.all([awayAt, badgeAt]);
    const timing = `hello ${helloAt - reloadAt} ms after the reload began; away ${away - reloadAt} ms, badge gone ${badgeGone - reloadAt} ms after it`;
    check("7: Bo reloads: Ann sees him away within 1 s of his reloaded page starting the plugin", away - helloAt <= 1000, `${away - helloAt} ms; ${timing}`);
    check("13: and his badge disappears from Cy's page within 1 s of it", badgeGone - helloAt <= 1000, `${badgeGone - helloAt} ms; ${timing}`);
    await waitFor(() => read(bo, () => window.__hq?.state?.conn === "open"), { timeout: 30000, what: "Bo back" });
    await walkTo(bo, 212, feet);
    await openWithX(bo);
    const boBackOk = await until(async () => {
      const x = await button(bo, "Black");
      return x?.text === "Black: " + bo.name && x.pressed && (await board(bo))?.p === expected.p && (await modalState(ann)).holders.endsWith(`Black: ${bo.name} (here)`);
    });
    check("7: reopening, Bo is back in his seat (Black: his name, pressed) with the game as it was", boBackOk, JSON.stringify(await button(bo, "Black")));
    // Bo closes his window: away within 1 s
    await press(bo, "Close");
    const closeMs = await within(async () => (await modalState(ann)).holders.endsWith(`Black: ${bo.name} (away)`), 1000);
    check("7: Bo closes the window: Ann sees him away within 1 s", closeMs >= 0, `${closeMs} ms`);
    check("7: while Ann (seated) is present, the spectator's Reset is disabled", (await button(cy, "Reset")).disabled === true);
    check("7: the present seated player's Reset is enabled", (await button(ann, "Reset")).disabled === false);
    // Ann closes: her badge goes from Cy's page within 1 s; now nobody seated is present, Cy may reset
    const preClose = await until(async () => badgeAbove(await badgeOf(cy, ann.id), "w"));
    check("before Ann closes: Cy's page shows her badge", preClose);
    await press(ann, "Close");
    const annBadgeMs = await within(async () => !(await badgeOf(cy, ann.id)).badge, 1000);
    check("13: Ann closes the window: her badge disappears from Cy's page within 1 s", annBadgeMs >= 0, `${annBadgeMs} ms`);
    const cyMayReset = await until(async () => (await button(cy, "Reset"))?.disabled === false);
    check("7: with neither seated player present, the spectator's Reset is enabled", cyMayReset, (await modalState(cy)).holders);
    await press(cy, "Reset");
    const resetOk = await until(async () => {
      const m = await modalState(cy), c = await board(cy);
      return c?.p === START && c.w === "" && c.b === "" && m.holders === "White: free · Black: free" && !b(m, "White").disabled && !b(m, "Black").disabled;
    });
    check("7: Reset puts the start position back, empties the reserve and frees both seats", resetOk, JSON.stringify({ afterReset: await modalState(cy), cyBoard: await board(cy) }));
    check("a reset clears the highlight and the undo", (await board(cy)).last.length === 0 && (await button(cy, "Undo"))?.disabled === true, JSON.stringify({ last: (await board(cy)).last, undo: await button(cy, "Undo") }));
    await press(cy, "White");
    const cySeated = await until(async () => { const x = await button(cy, "White"); return x?.text === "White: " + cy.name && x.pressed; });
    check("7: anyone can then take a seat (Cy takes White)", cySeated, JSON.stringify(await button(cy, "White")));
    await press(cy, "Reset"); // a present seated player resets: seats free again
    const freed = await until(async () => (await modalState(cy)).holders === "White: free · Black: free");
    check("7: a present seated player can reset (Cy frees the seats again)", freed, (await modalState(cy)).holders);
    await press(cy, "Close");

    // ---- criterion 8: a server restart keeps the position and the seats
    await openWithX(ann);
    await openWithX(bo);
    await press(ann, "White");
    await waitFor(async () => (await button(bo, "Black"))?.disabled === false && (await button(bo, "White"))?.text === "White: " + ann.name, { what: "Ann seated again" });
    await press(bo, "Black");
    await waitFor(async () => (await button(ann, "Black"))?.text === "Black: " + bo.name, { what: "Bo seated again" });
    expected = { p: START, r: "", w: { id: ann.id, name: "" }, b: { id: bo.id, name: "" } };
    await dragSq(ann, "e2", "e4");
    playMove(expected, ann.id, sq("e2"), sq("e4"));
    await waitFor(async () => (await board(bo))?.p === expected.p, { timeout: 3000, what: "e4 before the restart" });
    if (ctx.server) {
      await ctx.stopServer();
      await ctx.startServer();
      for (const u of [ann, bo, cy, di]) {
        await u.page.reload({ waitUntil: "domcontentloaded" });
        await waitFor(() => read(u, () => window.__hq?.state?.conn === "open"), { timeout: 30000, what: u.name + " reconnected" });
      }
      await walkTo(ann, 204, feet);
      await walkTo(bo, 212, feet);
      await openWithX(ann);
      await openWithX(bo);
      const restored = await until(async () => {
        const r = await modalState(ann);
        return (await board(ann))?.p === expected.p && (await board(bo))?.p === expected.p && b(r, "White").text === "White: " + ann.name && b(r, "White").pressed && r.holders === `White: ${ann.name} (here) · Black: ${bo.name} (here)`;
      });
      check("8: after a server restart the board has its position and both players their seats", restored, JSON.stringify(await modalState(ann)));
    } else check("8: server restart (skipped against an external stack)", true);

    // ---- criteria 4 and 8: plugin off: the sprite goes and X does nothing; on: back with its game
    await press(ann, "Close");
    await press(bo, "Close");
    await setPlugin(ctx, false);
    const gone = await waitFor(() => read(ann, () => window.__hq.view.objSprites.length === 0 && !document.querySelector(".interaction-hint")), { what: "board gone" }).catch(() => false);
    check("4: plugin off: the board's sprite and the X hint are gone", gone === true);
    await ann.page.keyboard.press("x");
    await sleep(1000);
    check("4: plugin off: X next to where the board was does nothing", !(await ann.page.$(".modal")) && (await read(ann, () => window.__hq.state.nearby)) === null);
    // Bo's page gets the plugin's browser code 2.5 s late, so he presses X before the plugin runs on his page
    // (as on a slow machine): the window it then opens must count as open, whatever the page's hello says
    const slowClient = (r) => { if (r.isInterceptResolutionHandled()) return; if (r.url().endsWith(`/plugins/${PLUGIN}/client.js`)) setTimeout(() => r.continue().catch(() => {}), 2500); else r.continue().catch(() => {}); };
    await bo.page.setRequestInterception(true);
    bo.page.on("request", slowClient);
    const boHelloFrom = bo.sent.length;
    await setPlugin(ctx, true);
    await waitFor(() => read(ann, () => window.__hq.view.objSprites.some((x) => !x.destroyed && x.texture.width === 16)), { timeout: 15000, what: "board back" });
    await openWithX(bo);
    bo.page.off("request", slowClient);
    await bo.page.setRequestInterception(false);
    const helloIdx = bo.sent.findIndex((d, j) => j >= boHelloFrom && d.t === "hello");
    const xFirst = helloIdx >= 0 && bo.usedAt < bo.sentAt[helloIdx];
    await openWithX(ann);
    const bothHere = `White: ${ann.name} (here) · Black: ${bo.name} (here)`;
    const backOn = await waitFor(async () => (await board(ann))?.p === expected.p && (await modalState(ann)).holders === bothHere, { timeout: 5000, what: "seats after off/on" }).catch(() => false);
    check("4, 8: plugin on again: the board is back, X opens it, with its game and its players", backOn === true, (await modalState(ann)).holders);
    check("a window opened before the plugin ran on that page stays open (the page's late hello does not close it)", xFirst && backOn === true, JSON.stringify({ xFirst, holders: (await modalState(ann)).holders }));
    // criterion 13, the reset half: both badges are up on Cy's page, and a reset takes them down within 1 s
    const upBeforeReset = await waitFor(async () => badgeAbove(await badgeOf(cy, ann.id), "w") && badgeAbove(await badgeOf(cy, bo.id), "b"), { timeout: 5000, what: "badges before the reset" }).catch(() => false);
    check("13: with Ann and Bo seated and present, Cy's page shows both badges", upBeforeReset === true, JSON.stringify([await badgeOf(cy, ann.id), await badgeOf(cy, bo.id)]));
    await press(ann, "Reset"); // also leaves the board as new
    const resetGoneMs = await within(async () => !(await badgeOf(cy, ann.id)).badge && !(await badgeOf(cy, bo.id)).badge, 1000);
    check("13: a reset takes both badges down on Cy's page within 1 s", resetGoneMs >= 0, `${resetGoneMs} ms`);
    await waitFor(async () => (await board(ann))?.p === START, { timeout: 3000, what: "final reset" }).catch(() => {});

    // The plugin is turned off on purpose above, while a page may still be loading its code or pictures
    // (a page reloaded by the restart starts the plugin again just before): the server answers such a
    // request 404 once the plugin stopped, before the page hears it did, and the browser logs that; the
    // page drops the load (the checks of criterion 4 show nothing of the plugin stays). Only a 404 of this
    // plugin's own files is let through, so any other failed load still fails the check.
    const offRace = new RegExp(`^Failed to load resource: the server responded with a status of 404 \\(Not Found\\) \\S*/plugins/${PLUGIN}/(client\\.js|assets/)`);
    const real = (u) => u.logs.filter((l) => !/WebSocket|ERR_|net::|closed/.test(l) && !offRace.test(l));
    for (const u of [ann, bo, cy, di]) check(`${u.name}: no console errors`, real(u).length === 0, real(u).slice(0, 3).join(" | "));
  } catch (e) {
    check("scenario completed", false, String(e && e.stack || e));
  } finally {
    await setPlugin(ctx, false).catch(() => {});
    await setBoards(ctx, []).catch(() => {});
    await browser.close();
  }
  return summary();
}

// shared with capture-chess.mjs
export { ART, setPlugin, setBoards, board, viewFrame, squareAt, onPage, dragSq, drag, press, button, modalState, openWithX, countFrames, sq, MODAL, BOARD };
