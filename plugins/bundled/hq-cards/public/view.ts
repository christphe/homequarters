// hq-cards's table view: the script plugin.json's "views" names, run by Home Quarters in a sandboxed iframe
// of the Cards window. It only talks to the plugin's client code (public/client.ts) through hqView: it gets
// the game, the table's state and its log (each in its own message), and sends one message per action,
// never while a card is being dragged.
//
// A canvas seen from above (public/layout.ts): the felt in the middle with its piles and loose cards, the
// other seats around it (their names and the backs of their cards), my hand fanned under it. What a member
// should not see is hidden here: other hands and face-down cards show their backs, a pile only its top,
// unless I look through it. Pointer: drag a card (from my hand, the felt or the top of a pile) and drop it
// on the felt, a pile, a player's name (to give it) or my hand; a double click turns a card over. When the
// table snaps (a setting of the table), a card lands on a grid, on another card, or just below it so its
// index shows (a cascade); a card taken from a stack or cascade takes the cards put on it, and a handle
// above a group or a pile moves it whole. A row of buttons under the canvas acts on the selected pile, card
// or seat; the table's controls and the log are in a panel (public/panel.ts). Keyboard: the arrows move a cursor over
// my hand, the felt's cards and piles and the seats; Enter picks up and drops; F turns over, L looks, D
// draws, T puts the held card on the table; Escape cancels. A live region says what is under the cursor
// and every new line of the log, which is also listed under the canvas.
import { CARD_H, CARD_W, paintBack, paintCard } from "./art.ts";
import { cardName, type ClientGame } from "./games.ts";
import { cardAt, FELT_H, FELT_W, GRID, groupFrom, groups, handSpots, hit, layoutFor, seatSpots, snapAt, WIDE, type Layout, type Spot } from "./layout.ts";
import { sentence, type LogEntry } from "./log.ts";
import type { Act, TableState, ViewIn } from "./messages.ts";
import { createPanel } from "./panel.ts";
import { UP, type Dest, type Src, type Table } from "./table.ts";

const C = {
  bg: "#3a2a24",
  felt: "#2f6b45",
  feltLo: "#245437",
  feltHi: "#3d8257",
  slot: "#7fb08f",
  text: "#f4efe2",
  muted: "#c9bfae",
  select: "#e8c35a",
  cursor: "#6fb7d9",
  shade: "rgba(20, 16, 30, 0.72)",
};

let tableId = "";
let game: ClientGame | null = null;
let st: TableState | null = null;
let log: LogEntry[] = [];
let me = 0;
let mySeat: number | null = null;
let selected: Spot | null = null;
let scale = 2;
let L: Layout = WIDE; // WIDE, or NARROW on a phone (layout.ts)

// a card picked up: from where, which card, and (while dragging) where the pointer is, in view pixels
// gx, gy: where the pointer took the card, from its centre; group: the loose cards moving with it (a stack or
// cascade taken from this card, or the whole group by its handle); pile: a pile moved by its handle
let held: { src: Src; c: number; up: boolean; by: "drag" | "key"; x: number; y: number; moved: boolean; gx: number; gy: number; group: number[]; pile: string | null } | null = null;
// looking through a pile: its cards in my order; picking from a hand offered to me
let look: { pile: string; cards: number[]; changed: boolean; grab: number | null } | null = null;
let picking = false;
let cursor = 0; // the keyboard's target, an index in targets()
let version = 0; // counts the states received: the buttons under the canvas are rebuilt for each
// a card just dropped: drawn where it was dropped (not back where it came from) until the server's state comes
let dropped: { src: Src | null; hide: number[]; pile: string | null; cards: { c: number; up: boolean; x: number; y: number }[] } | null = null;
let droppedTimer = 0;
let cursorShown = false;

const style = document.createElement("style");
style.textContent = `
  html, body { margin: 0; height: 100%; background: transparent; color: ${C.text}; font: 13px system-ui, sans-serif; }
  /* wide: the table on the left, the panel on the right, each scrolling on its own; narrow: one column that scrolls */
  main.cards { box-sizing: border-box; height: 100%; display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 300px); gap: 10px; padding: 4px; }
  main.cards.narrow { display: block; height: auto; }
  .stage { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; min-height: 0; overflow: auto; }
  canvas { image-rendering: pixelated; touch-action: none; outline: none; flex-shrink: 0; }
  canvas:focus-visible { box-shadow: 0 0 0 3px #3b7dd8; }
  .bar { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; min-height: 28px; }
  button { font: inherit; padding: 3px 10px; border-radius: 4px; border: 1px solid #1a1526; background: #f4efe2; color: #1a1526; cursor: pointer; }
  button[aria-pressed="true"] { background: #e8c35a; }
  button:disabled { opacity: .55; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 3px solid #3b7dd8; outline-offset: 1px; }
  /* the panel sits on the window's light background: dark text there; the log keeps its dark box */
  .panel { display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow: auto; color: #1a1526; }
  .panel .bar { justify-content: flex-start; }
  .panel > * { flex-shrink: 0; } /* in a column that scrolls, nothing is squeezed under another */
  main.narrow .panel { margin-top: 10px; overflow: visible; }
  /* the whole panel scrolls: its controls never shrink to nothing on a short screen */
  .controls { display: grid; gap: 6px; align-content: start; flex: none; }
  .controls h2 { margin: 0; font-size: 15px; }
  .controls p { margin: 0; }
  .controls .muted { color: #5a5470; }
  .controls .notice { color: #8a4b00; font-weight: 600; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .field { display: inline-flex; gap: 6px; align-items: center; }
  .field input { box-sizing: border-box; width: 9em; padding: 3px 6px; border-radius: 4px; border: 1px solid #1a1526; font: inherit; }
  .field input[type="number"] { width: 4.5em; }
  .log { box-sizing: border-box; flex: none; max-height: max(80px, 30vh); min-height: 60px; overflow: auto; margin: 0; padding: 4px 8px 4px 28px; background: #2b1f1b; color: ${C.text}; border-radius: 4px; }
  main.narrow .log { max-height: 160px; }
  .log li { margin: 1px 0; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;
document.head.appendChild(style);

const canvas = document.createElement("canvas");
canvas.tabIndex = 0;
canvas.setAttribute("role", "application");
canvas.setAttribute("aria-label", "Card table: arrow keys move, Enter picks up and drops a card, F turns it over, L looks through a pile, D draws, T puts the held card on the table, Escape cancels");
const bar = document.createElement("div");
bar.className = "bar";
const live = document.createElement("div");
live.className = "sr";
live.setAttribute("aria-live", "polite");
const panel = createPanel((m) => send(m), () => newPileAt());
const stage = document.createElement("div");
stage.className = "stage";
stage.append(canvas, bar);
// one landmark around everything, so every part of the view belongs to a region
const main = document.createElement("main");
main.className = "cards";
main.append(stage, panel.root, live);
document.body.append(main);
const ctx = canvas.getContext("2d")!;

function say(text: string): void {
  live.textContent = "";
  requestAnimationFrame(() => (live.textContent = text));
}

// ---- pictures

const pictures = new Map<string, HTMLCanvasElement>();
let sheet: HTMLImageElement | null = null;
let sheetFor = "";

function painted(key: string, paint: (set: (x: number, y: number, hex: string) => void) => void): HTMLCanvasElement {
  let c = pictures.get(key);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = CARD_W;
  c.height = CARD_H;
  const g = c.getContext("2d")!;
  paint((x, y, hex) => {
    g.fillStyle = hex;
    g.fillRect(x, y, 1, 1);
  });
  pictures.set(key, c);
  return c;
}

function loadSheet(): void {
  const d = game?.deck;
  if (!d || "standard" in d) return;
  const url = new URL(`/plugins/${d.plugin}/assets/${d.sheet}`, document.baseURI).href;
  if (sheetFor === url) return;
  sheetFor = url;
  const img = new Image();
  img.onload = () => {
    if (sheetFor === url) {
      sheet = img;
      draw();
    }
  };
  // refused by this view's security policy (it started before the game's plugin was known to the page):
  // the window starts a fresh view
  img.onerror = () => {
    if (sheetFor === url) hqView.send({ t: "renew" });
  };
  img.src = url;
}

/** Draws card n (its face, or its back when !up) with its top-left corner at (x, y), w wide. */
function drawCard(n: number, up: boolean, x: number, y: number, w = CARD_W): void {
  const h = (w * CARD_H) / CARD_W;
  const d = game?.deck;
  if (d && !("standard" in d)) {
    const frame = up ? d.frames[n] : d.back;
    const cols = sheet ? Math.max(1, Math.floor(sheet.width / d.cell[0])) : 1;
    if (sheet && frame !== undefined) {
      ctx.drawImage(sheet, (frame % cols) * d.cell[0], Math.floor(frame / cols) * d.cell[1], d.cell[0], d.cell[1], x, y, w, h);
    } else {
      ctx.fillStyle = C.muted;
      ctx.fillRect(x, y, w, h);
    }
    return;
  }
  const code = d && "standard" in d ? d.standard[n] : undefined;
  const pic = up && code ? painted(code, (set) => paintCard(code, set)) : painted("back", paintBack);
  ctx.drawImage(pic, x, y, w, h);
}

const nameOf = (n: number) => (game ? cardName(game, n) : "a card");
const seatName = (s: number) => st?.t.seats[s]?.name ?? `Seat ${s + 1}`;
const allowed = (a: string) => !!game && game.allow.includes(a as never);
const short = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s);

// ---- what is where

function pileById(id: string) {
  return st?.t.piles.find((p) => p.id === id);
}

/** A spot on the felt near the bottom middle with no card under it, for drops made without a pointer. */
function freeSpot(t: Table): [number, number] {
  const taken = (x: number, y: number) =>
    [...t.loose.map((l) => l.at), ...t.piles.map((p) => p.at)].some((a) => Math.abs(a[0] - x) < CARD_W && Math.abs(a[1] - y) < CARD_H);
  for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 13; k++) {
      const x = FELT_W / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (CARD_W + 4), y = FELT_H - 20 - row * (CARD_H + 4);
      if (x > CARD_W / 2 && x < FELT_W - CARD_W / 2 && !taken(x, y)) return [x, y];
    }
  }
  return [FELT_W / 2, FELT_H / 2];
}

/** Where a new pile goes: the first free place of a row along the top of the felt. */
function newPileAt(): [number, number] {
  const taken = st?.t.piles.map((p) => p.at) ?? [];
  for (let i = 0; i < 12; i++) {
    const at: [number, number] = [GRID[0] / 2 + i * GRID[0], GRID[1] / 2];
    if (!taken.some((a) => Math.abs(a[0] - at[0]) < CARD_W && Math.abs(a[1] - at[1]) < CARD_H)) return at;
  }
  return [FELT_W / 2, GRID[1] / 2];
}

function refreshPanel(): void {
  if (st && game && st.t.game !== null) panel.update({ st, game, me, log, card: nameOf });
}

/** The felt position (a card's centre) under view pixel (x, y), on the felt. */
const feltAt = (x: number, y: number): [number, number] => [Math.max(CARD_W / 2, Math.min(FELT_W - CARD_W / 2, Math.round(x - L.fx))), Math.max(CARD_H / 2, Math.min(FELT_H - CARD_H / 2, Math.round(y - L.fy)))];

/** What a drop at view pixel (x, y) lands on. */
function dropAt(x: number, y: number): Dest | null {
  if (mySeat !== null && y >= L.fy + FELT_H && x >= L.fx && x < L.fx + FELT_W) return { k: "hand", seat: mySeat };
  const s = st && hit(st.t, mySeat, x, y, L);
  if (!s) return null;
  if (s.k === "pile") return { k: "pile", id: s.id };
  if (s.k === "seat") return { k: "hand", seat: s.seat };
  if (s.k === "hand" && mySeat !== null) return { k: "hand", seat: mySeat };
  return { k: "felt", at: feltAt(x, y) };
}

function cardOf(src: Src): { c: number; up: boolean } | null {
  const t = st?.t;
  if (!t) return null;
  if (src.k === "hand") {
    const c = mySeat === null ? undefined : t.hands[mySeat][src.i];
    return c === undefined ? null : { c, up: true };
  }
  if (src.k === "loose") {
    const l = t.loose.find((x) => (x.c & ~UP) === src.c);
    return l ? { c: l.c & ~UP, up: !!(l.c & UP) } : null;
  }
  const p = pileById(src.id);
  const top = p?.cards[p.cards.length - 1];
  return top === undefined ? null : { c: top & ~UP, up: !!(top & UP) };
}

const srcOf = (s: Spot | null): Src | null => (!s ? null : s.k === "hand" ? { k: "hand", i: s.i } : s.k === "loose" ? { k: "loose", c: s.c } : s.k === "pile" ? { k: "pile", id: s.id } : null);

function send(m: Act): void {
  hqView.send(m);
}

/** Keeps what was just dropped drawn where it landed until the server's state comes (or 1.5 s: refused). */
function ghost(g: NonNullable<typeof dropped>): void {
  dropped = g;
  clearTimeout(droppedTimer);
  droppedTimer = setTimeout(() => ((dropped = null), draw()), 1500);
}

/** The action of dropping what is held on dest, one message, or nothing when it would not change anything. */
function drop(dest: Dest | null): void {
  const h = held;
  held = null;
  if (h?.by === "drag") selected = null; // the card was moved: nothing stays selected (another would slide into its place)
  if (!h || !dest || !st || mySeat === null) return draw();
  const t = st.t;
  const { src } = h;
  // where the card's centre lands on the felt: under the pointer, less where the card was taken; then snapped
  const centre = feltAt(h.x - h.gx, h.y - h.gy);
  const landing = (moving: number[]) => snapAt(t, centre, moving, t.snap);
  // a pile by its handle: only onto the felt, on the grid when the table snaps
  if (h.pile) {
    const p = pileById(h.pile);
    if (p && dest.k === "felt" && allowed("place")) {
      const at = t.snap ? snapAt({ ...t, loose: [] }, centre, [], true) : centre;
      if (at[0] !== p.at[0] || at[1] !== p.at[1]) {
        send({ t: "movePile", pile: p.id, at });
        ghost({ src: null, hide: [], pile: p.id, cards: [] });
      }
    }
    return draw();
  }
  // a stack or cascade: moved together, only onto the felt
  if (h.group.length > 1) {
    if (dest.k === "felt" && allowed("place")) {
      const first = t.loose.find((l) => (l.c & ~UP) === h.c);
      if (first) {
        const at = landing(h.group);
        const dx = at[0] - first.at[0], dy = at[1] - first.at[1];
        if (dx || dy) {
          send({ t: "moveCards", cards: h.group, dx, dy });
          const moved = t.loose.filter((l) => h.group.includes(l.c & ~UP)).map((l) => ({ c: l.c & ~UP, up: !!(l.c & UP), ...cardAt([l.at[0] + dx, l.at[1] + dy], L) }));
          ghost({ src: null, hide: h.group, pile: null, cards: moved });
        }
      }
    }
    return draw();
  }
  if (dest.k === "felt") dest = { k: "felt", at: landing(src.k === "loose" ? [h.c] : []) };
  if (h.by === "drag" && h.moved && dest.k !== "hand") {
    const at = dest.k === "felt" ? cardAt(dest.at, L) : { x: h.x - CARD_W / 2, y: h.y - CARD_H / 2 };
    ghost({ src, hide: [], pile: null, cards: [{ c: h.c, up: h.up, ...at }] });
  }
  if (dest.k === "hand" && dest.seat === mySeat) {
    if (src.k === "pile") {
      if (allowed("draw")) send({ t: "draw", pile: src.id });
    } else if (src.k === "loose") send({ t: "place", from: src, to: dest, up: false });
    else if (src.k === "hand" && h.by === "drag") {
      // rearranging my hand: the card goes where it was dropped
      const hand = [...t.hands[mySeat]];
      const [c] = hand.splice(src.i, 1);
      const spots = handSpots(hand.length + 1, L);
      let at = spots.findIndex((p) => h.x < p.x + (CARD_W * L.handK) / 2);
      if (at < 0) at = hand.length;
      hand.splice(at, 0, c);
      if (hand.some((v, i) => v !== t.hands[mySeat!][i])) send({ t: "order", hand });
    }
    return draw();
  }
  if (src.k === "pile" && dest.k === "pile" && dest.id === src.id) return draw();
  if (src.k === "loose" && dest.k === "felt") return send({ t: "place", from: src, to: dest, up: h.up }), draw();
  if (!allowed("place")) return draw();
  // face: a card from my hand goes face up on the felt, as the pile shows on a pile; a card keeps its face otherwise
  let up = h.up;
  if (src.k === "hand") up = dest.k === "pile" ? pileById(dest.id)?.face === "up" : true;
  else if (dest.k === "pile") up = pileById(dest.id)?.face === "up";
  send({ t: "place", from: src, to: dest, up });
  draw();
}

// ---- drawing

interface Drawn { c: number; up: boolean; x: number; y: number; w?: number; where: "hand" | "loose" | "pile" | "seat" | "look" | "pick" }
let drawn: Drawn[] = [];

function text(s: string, x: number, y: number, colour = C.text, align: CanvasTextAlign = "center"): void {
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
}

function outline(x: number, y: number, w: number, h: number, colour: string): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
}

/** A handle: three short lines just above a card (a pile, or a stack's or cascade's bottom card). */
const GRIP_H = 7;
function grip(x: number, y: number): void {
  ctx.fillStyle = C.slot;
  for (let k = 0; k < 3; k++) ctx.fillRect(x + 5, y - GRIP_H + k * 2, CARD_W - 10, 1);
}

/** The handle under view pixel (x, y): a group's (by its bottom card) or a pile's. */
function handleAt(x: number, y: number): { c: number; pile: string | null } | null {
  const t = st?.t;
  if (!t) return null;
  const on = (at: [number, number]) => {
    const p = cardAt(at, L);
    return x >= p.x && x < p.x + CARD_W && y >= p.y - GRIP_H - 1 && y < p.y;
  };
  for (const g of [...groups(t)].reverse()) if (on(g.at)) return { c: g.c, pile: null };
  for (const p of [...t.piles].reverse()) if (on(p.at)) return { c: -1, pile: p.id };
  return null;
}

function same(a: Spot | null, b: Spot | null): boolean {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}

function draw(): void {
  canvas.width = L.w * scale;
  canvas.height = L.h * scale;
  canvas.style.width = L.w * scale + "px";
  canvas.style.height = L.h * scale + "px";
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.font = `${L.font}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  drawn = [];
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, L.w, L.h);
  ctx.fillStyle = C.feltLo;
  ctx.fillRect(L.fx - 2, L.fy - 2, FELT_W + 4, FELT_H + 4);
  ctx.fillStyle = C.felt;
  ctx.fillRect(L.fx, L.fy, FELT_W, FELT_H);
  const t = st?.t;
  if (!t || !game) {
    text(st?.unavailable ? "This game is not available" : "Choose a game in the window", L.w / 2, L.h / 2);
    return publish();
  }
  const targets = targetList();
  const cur = cursorShown ? targets[cursor] ?? null : null;
  const dragging = held && held.by === "drag" && held.moved ? held : null;
  const hide = dragging ? dragging.src : dropped?.src ?? null;
  const hideLoose = new Set<number>([...(dragging?.group ?? []), ...(dropped?.hide ?? [])]);
  const seated = mySeat !== null && allowed("place");
  // where the grabbed card's centre is while dragging (felt units), and how far it moved from where it was
  const dragCentre = dragging ? feltAt(dragging.x - dragging.gx, dragging.y - dragging.gy) : null;
  // the grid, while dragging on a table that snaps
  if (dragging && t.snap) {
    ctx.fillStyle = C.feltHi;
    for (let gx = GRID[0] / 2; gx <= FELT_W - CARD_W / 2; gx += GRID[0]) for (let gy = GRID[1] / 2; gy <= FELT_H - CARD_H / 2; gy += GRID[1]) ctx.fillRect(L.fx + gx - 1, L.fy + gy - 1, 2, 2);
  }

  // piles: their slot, their top card, their name and count
  for (const p of t.piles) {
    const moving = dragging?.pile === p.id && dragCentre;
    const { x, y } = cardAt(moving ? dragCentre : p.at, L);
    ctx.setLineDash([2, 2]);
    outline(x, y, CARD_W, CARD_H, C.slot);
    ctx.setLineDash([]);
    let cards = p.cards;
    if (hide?.k === "pile" && hide.id === p.id) cards = cards.slice(0, -1);
    const top = cards[cards.length - 1];
    if (top !== undefined) {
      if (cards.length > 1) drawCard(0, false, x + 1, y + 1);
      drawCard(top & ~UP, !!(top & UP), x, y);
      drawn.push({ c: top & ~UP, up: !!(top & UP), x, y, where: "pile" });
    }
    text(`${short(p.name, 10)} ${p.cards.length}`, x + CARD_W / 2, y + CARD_H + 6, C.muted);
    const lookers = st!.looking.filter((l) => l.pile === p.id).map((l) => short(seatName(l.seat), 8));
    if (lookers.length) text(`${lookers.join(", ")} looking`, x + CARD_W / 2, y + CARD_H + 14, C.select);
    if (seated) grip(x, y); // the pile's handle
    const s: Spot = { k: "pile", id: p.id };
    if (same(selected, s)) outline(x, y, CARD_W, CARD_H, C.select);
    if (same(cur, s)) outline(x - 1, y - 1, CARD_W + 2, CARD_H + 2, C.cursor);
  }
  // loose cards, in the order they were put down
  for (const l of t.loose) {
    const c = l.c & ~UP;
    if ((hide?.k === "loose" && hide.c === c) || hideLoose.has(c)) continue;
    const { x, y } = cardAt(l.at, L);
    drawCard(c, !!(l.c & UP), x, y);
    drawn.push({ c, up: !!(l.c & UP), x, y, where: "loose" });
    const s: Spot = { k: "loose", c };
    if (same(selected, s)) outline(x, y, CARD_W, CARD_H, C.select);
    if (same(cur, s)) outline(x - 1, y - 1, CARD_W + 2, CARD_H + 2, C.cursor);
  }
  // the handle of each stack or cascade, above its bottom card
  if (seated) for (const g of groups(t)) if (!hideLoose.has(g.c)) grip(cardAt(g.at, L).x, cardAt(g.at, L).y);
  // the other seats: name (away when their window is closed), their cards' backs, what they are doing
  for (const sp of seatSpots(t.seats.length, mySeat, L)) {
    const seat = t.seats[sp.seat];
    const x0 = sp.x - L.seatW / 2, y0 = sp.y - L.seatH / 2;
    const s: Spot = { k: "seat", seat: sp.seat };
    if (!seat) {
      text(sp.side === "top" ? `Seat ${sp.seat + 1}: free` : `${sp.seat + 1}: free`, sp.x, sp.y, C.muted);
    } else {
      const away = !st!.here.includes(seat.id);
      const room = L.narrow ? (away ? 7 : 12) : sp.side === "top" ? 14 : 8; // characters that fit the spot
      text(short(seat.name, room) + (away ? " (away)" : ""), sp.x, y0 + 5, away ? C.muted : C.text);
      const n = t.hands[sp.seat].length;
      // the side columns are narrow: there the count goes under the backs and the tags are short
      const side = sp.side !== "top";
      const shown = Math.min(n, side ? 5 : 6);
      for (let i = 0; i < shown; i++) drawCard(0, false, sp.x - (shown * 5) / 2 + i * 5 - 2, y0 + 10, 10);
      if (side) text(String(n), sp.x, y0 + 28, C.muted);
      else text(String(n), sp.x + (shown * 5) / 2 + 8, y0 + 17, C.muted);
      if (t.offer?.from === sp.seat) {
        const tag = t.offer.to === mySeat ? (side ? "offers you" : "offers you a pick") : side ? "offering" : `offers ${short(seatName(t.offer.to), 8)}`;
        text(tag, sp.x, side ? y0 - 2 : L.narrow ? y0 + 28 : y0 + L.seatH, C.select);
      }
    }
    if (same(selected, s)) outline(x0, y0, L.seatW, L.seatH - 2, C.select);
    if (same(cur, s)) outline(x0 - 1, y0 - 1, L.seatW + 2, L.seatH, C.cursor);
  }
  // my hand
  if (mySeat !== null) {
    const hand = t.hands[mySeat];
    const spots = handSpots(hand.length, L);
    hand.forEach((c, i) => {
      if (hide?.k === "hand" && hide.i === i) return;
      const lift = same(selected, { k: "hand", i }) ? 4 : 0;
      const hw = CARD_W * L.handK; // my hand is drawn larger in the narrow layout
      drawCard(c, true, spots[i].x, spots[i].y - lift, hw);
      drawn.push({ c, up: true, x: spots[i].x, y: spots[i].y - lift, w: hw, where: "hand" });
      if (same(cur, { k: "hand", i })) outline(spots[i].x - 1, spots[i].y - lift - 1, hw + 2, CARD_H * L.handK + 2, C.cursor);
    });
    if (!hand.length) text("Your hand is empty", L.fx + FELT_W / 2, L.fy + FELT_H + 22, C.muted);
    if (t.offer?.from === mySeat) text(`You offer your hand to ${short(seatName(t.offer.to), 10)}`, L.fx + FELT_W / 2, L.h - 3, C.select);
  } else text("Watching: take a seat in the window to play", L.fx + FELT_W / 2, L.fy + FELT_H + 22, C.muted);
  // overlays: looking through a pile, picking from an offered hand
  if (look) drawRow(look.cards.map((c) => ({ c: c & ~UP, up: true })), "look", look.grab);
  else if (picking && t.offer && t.offer.to === mySeat) drawRow(t.hands[t.offer.from].map((c) => ({ c, up: false })), "pick", null);
  // what is being dragged (a card, or a stack or cascade moving together), or was just dropped
  if (dragging && dragCentre && !dragging.pile) {
    if (dragging.group.length > 1) {
      const first = t.loose.find((l) => (l.c & ~UP) === dragging.c);
      const dx = first ? dragCentre[0] - first.at[0] : 0, dy = first ? dragCentre[1] - first.at[1] : 0;
      for (const l of t.loose) if (dragging.group.includes(l.c & ~UP)) drawCard(l.c & ~UP, !!(l.c & UP), cardAt([l.at[0] + dx, l.at[1] + dy], L).x, cardAt([l.at[0] + dx, l.at[1] + dy], L).y);
    } else drawCard(dragging.c, dragging.up, dragging.x - dragging.gx - CARD_W / 2, dragging.y - dragging.gy - CARD_H / 2);
  } else if (dropped) for (const k of dropped.cards) drawCard(k.c, k.up, k.x, k.y);
  publish();
}

/** A row of cards over the felt (a pile looked through, or a hand to pick from), several rows when long. */
function rowSpots(n: number): { x: number; y: number }[] {
  const per = Math.max(1, Math.floor((FELT_W - 8) / 14));
  return Array.from({ length: n }, (_, i) => ({ x: L.fx + 4 + (i % per) * 14, y: L.fy + 18 + Math.floor(i / per) * (CARD_H + 4) }));
}

function drawRow(cards: { c: number; up: boolean }[], where: "look" | "pick", grab: number | null): void {
  ctx.fillStyle = C.shade;
  ctx.fillRect(L.fx, L.fy, FELT_W, FELT_H);
  text(where === "look" ? "Drag to reorder, then Done" : "Pick a card", L.fx + FELT_W / 2, L.fy + 8);
  const spots = rowSpots(cards.length);
  const targets = cursorShown ? targetList() : [];
  const cur = targets[cursor];
  cards.forEach((k, i) => {
    const lift = grab === i ? 4 : 0;
    drawCard(k.c, k.up, spots[i].x, spots[i].y - lift);
    drawn.push({ c: k.c, up: k.up, x: spots[i].x, y: spots[i].y - lift, where });
    if (cur && "i" in cur && cur.k === "hand" && cur.i === i) outline(spots[i].x - 1, spots[i].y - 1, CARD_W + 2, CARD_H + 2, C.cursor);
  });
}

function rowIndexAt(n: number, x: number, y: number): number | null {
  const spots = rowSpots(n);
  for (let i = n - 1; i >= 0; i--) if (x >= spots[i].x && x < spots[i].x + CARD_W && y >= spots[i].y && y < spots[i].y + CARD_H) return i;
  return null;
}

/** For tests (e2e/scenarios/cards.mjs): what the canvas shows, in canvas pixels, and the log as written. */
function publish(): void {
  (window as unknown as { __drawn: unknown }).__drawn = {
    cards: drawn.map((d) => ({ ...d, x: d.x * scale, y: d.y * scale, w: (d.w ?? CARD_W) * scale })),
    scale,
    layout: L.narrow ? "narrow" : "wide",
    font: L.font * scale, // CSS px of the canvas text
    seat: mySeat,
    sheet: !game || "standard" in game.deck ? null : sheet ? "loaded" : "loading",
    log: panel.logLines(),
  };
  toolbar();
}

// ---- the buttons under the canvas, for what is selected

/** Runs fn on the loose card selected now; clear: it leaves the felt, so nothing stays selected. */
function onLoose(fn: (c: number) => void, clear: boolean): void {
  if (selected?.k !== "loose") return;
  fn(selected.c);
  if (clear) selected = null;
  draw();
}

function button(label: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.onclick = fn;
  return b;
}

let barKey = "";
function toolbar(): void {
  const t = st?.t;
  const out: HTMLButtonElement[] = [];
  const seated = mySeat !== null;
  if (look) {
    out.push(button("Done", finishLook), button("Cancel", cancelLook));
  } else if (picking) {
    out.push(button("Cancel", () => ((picking = false), draw())));
  } else if (t && seated && selected) {
    if (selected.k === "pile") {
      const p = pileById(selected.id);
      if (p) {
        const id = p.id;
        if (allowed("draw") && p.cards.length) out.push(button(`Draw from ${short(p.name, 12)}`, () => send({ t: "draw", pile: id })));
        if (allowed("viewPile") && p.cards.length) out.push(button(`Look through ${short(p.name, 12)}`, () => startLook(id)));
        if (allowed("shuffle") && p.cards.length > 1) out.push(button(`Shuffle ${short(p.name, 12)}`, () => send({ t: "shuffle", pile: id })));
        if (allowed("place") && p.cards.length) out.push(button("Turn the top over", () => send({ t: "flip", from: { k: "pile", id } })));
        if (allowed("remove") && p.cards.length) out.push(button("Set the top aside", () => send({ t: "setAside", from: { k: "pile", id } })));
        // any pile but the stock: its cards go back to the stock
        if (allowed("createPile") && p !== t.piles[0]) out.push(button(`Remove the pile ${short(p.name, 12)}`, () => ((selected = null), send({ t: "delPile", pile: id }))));
      }
    } else if (selected.k === "loose") {
      if (allowed("place")) {
        // each button reads the selection and the table when pressed, never as they were when it was made
        out.push(button("Turn it over", () => onLoose((c) => send({ t: "flip", from: { k: "loose", c } }), false)));
        out.push(button("Take it back", () => onLoose((c) => send({ t: "place", from: { k: "loose", c }, to: { k: "hand", seat: mySeat! }, up: false }), true)));
      }
      if (allowed("remove")) out.push(button("Set it aside", () => onLoose((c) => send({ t: "setAside", from: { k: "loose", c } }), true)));
    } else if (selected.k === "hand") {
      if (allowed("place")) {
        const put = (up: boolean) => () => {
          if (selected?.k !== "hand" || !st || mySeat === null) return;
          send({ t: "place", from: { k: "hand", i: selected.i }, to: { k: "felt", at: freeSpot(st.t) }, up });
          selected = null; // the card left the hand
          draw();
        };
        out.push(button("Put it on the table face up", put(true)));
        out.push(button("Put it on the table face down", put(false)));
      }
      if (allowed("remove")) {
        out.push(button("Set it aside", () => {
          if (selected?.k !== "hand") return;
          send({ t: "setAside", from: { k: "hand", i: selected.i } });
          selected = null;
          draw();
        }));
      }
    } else if (selected.k === "seat") {
      const s = selected.seat;
      if (t.offer?.from === s && t.offer.to === mySeat) out.push(button(`Draw a card from ${short(seatName(s), 12)}`, () => ((picking = true), draw())));
    }
  }
  // rebuilt when what it acts on may have changed; kept otherwise, so the focus stays on its button
  const key = `${version}|${JSON.stringify(selected)}|${out.map((b) => b.textContent).join("|")}`;
  if (key === barKey) return;
  barKey = key;
  bar.replaceChildren(...out);
}

// ---- looking through a pile

function startLook(id: string): void {
  const p = pileById(id);
  if (!p || !allowed("viewPile")) return;
  look = { pile: id, cards: [...p.cards], changed: false, grab: null };
  picking = false;
  cursor = 0;
  send({ t: "look", pile: id });
  say(`Looking through ${p.name}: ${p.cards.length} cards, the top last. ${p.cards.map((c) => nameOf(c & ~UP)).join(", ")}`);
  draw();
}

function finishLook(): void {
  if (!look) return;
  if (look.changed) send({ t: "reorder", pile: look.pile, cards: look.cards });
  send({ t: "unlook" });
  look = null;
  draw();
  canvas.focus({ preventScroll: true });
}

function cancelLook(): void {
  if (!look) return;
  send({ t: "unlook" });
  look = null;
  draw();
  canvas.focus({ preventScroll: true });
}

function moveInLook(from: number, to: number): void {
  if (!look || from === to) return;
  const [c] = look.cards.splice(from, 1);
  look.cards.splice(to, 0, c);
  look.changed = true;
}

// ---- pointer

function toView(e: PointerEvent | MouseEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * L.w, y: ((e.clientY - r.top) / r.height) * L.h };
}

let lookDrag: { from: number; x: number; y: number } | null = null;

canvas.addEventListener("pointerdown", (e) => {
  if (!st || !game) return;
  const p = toView(e);
  canvas.focus({ preventScroll: true }); // scrolling now would move the canvas from under the pointer
  cursorShown = false;
  if (look) {
    const i = rowIndexAt(look.cards.length, p.x, p.y);
    if (i !== null) {
      lookDrag = { from: i, ...p };
      canvas.setPointerCapture(e.pointerId);
    }
    return;
  }
  if (picking) {
    const o = st.t.offer;
    const i = o ? rowIndexAt(st.t.hands[o.from].length, p.x, p.y) : null;
    if (i !== null) {
      send({ t: "pick", i });
      picking = false;
    }
    return draw();
  }
  const t = st.t;
  // a handle first: a whole stack or cascade, or a pile
  const handle = mySeat !== null && allowed("place") ? handleAt(p.x, p.y) : null;
  if (handle) {
    const at = handle.pile ? pileById(handle.pile)!.at : t.loose.find((l) => (l.c & ~UP) === handle.c)!.at;
    const centre = cardAt(at, L);
    held = {
      src: handle.pile ? { k: "pile", id: handle.pile } : { k: "loose", c: handle.c }, c: handle.c, up: false, by: "drag", x: p.x, y: p.y, moved: false,
      gx: p.x - (centre.x + CARD_W / 2), gy: p.y - (centre.y + CARD_H / 2), group: handle.pile ? [] : groupFrom(t, handle.c), pile: handle.pile,
    };
    selected = null;
    canvas.setPointerCapture(e.pointerId);
    return draw();
  }
  const s = hit(t, mySeat, p.x, p.y, L);
  selected = s && s.k !== "felt" ? s : null;
  if (s?.k === "seat" && t.offer?.from === s.seat && t.offer.to === mySeat) picking = true;
  const src = srcOf(s);
  const card = src && cardOf(src);
  if (src && card && mySeat !== null) {
    // where the pointer took it, from the card's centre (a hand card is drawn larger in the narrow layout)
    let cx = p.x, cy = p.y;
    if (src.k === "loose" || src.k === "pile") {
      const at = src.k === "pile" ? pileById(src.id)!.at : t.loose.find((l) => (l.c & ~UP) === src.c)!.at;
      cx = cardAt(at, L).x + CARD_W / 2;
      cy = cardAt(at, L).y + CARD_H / 2;
    }
    // a card taken from a stack or cascade takes the cards put on it
    const group = src.k === "loose" ? groupFrom(t, src.c) : [];
    held = { src, ...card, by: "drag", x: p.x, y: p.y, moved: false, gx: p.x - cx, gy: p.y - cy, group, pile: null };
    canvas.setPointerCapture(e.pointerId);
  }
  draw();
});

canvas.addEventListener("pointermove", (e) => {
  const p = toView(e);
  if (lookDrag) {
    lookDrag.x = p.x;
    lookDrag.y = p.y;
    return;
  }
  if (!held || held.by !== "drag") return;
  if (!held.moved && Math.hypot(p.x - held.x, p.y - held.y) < 3) return;
  held.moved = true;
  held.x = p.x;
  held.y = p.y;
  draw(); // nothing is sent while dragging
});

canvas.addEventListener("pointerup", (e) => {
  const p = toView(e);
  if (lookDrag && look) {
    const to = rowIndexAt(look.cards.length, p.x, p.y) ?? look.cards.length - 1;
    moveInLook(lookDrag.from, to);
    lookDrag = null;
    return draw();
  }
  if (!held || held.by !== "drag") return;
  if (!held.moved) {
    held = null;
    clicked(p);
    return draw(); // a click: the card stays selected
  }
  held.x = p.x;
  held.y = p.y;
  drop(dropAt(p.x, p.y));
});

canvas.addEventListener("pointercancel", () => {
  held = null;
  lookDrag = null;
  draw();
});

// a second click on the same card within 400 ms turns it over (detected here: a canvas that captures the
// pointer on every press does not always get the browser's dblclick)
let lastClick: { x: number; y: number; at: number } | null = null;
function clicked(p: { x: number; y: number }): void {
  const now = performance.now();
  const second = lastClick && now - lastClick.at < 400 && Math.hypot(p.x - lastClick.x, p.y - lastClick.y) < 4;
  lastClick = second ? null : { ...p, at: now };
  if (!second || !st || mySeat === null || !allowed("place")) return;
  const s = hit(st.t, mySeat, p.x, p.y, L);
  const src = s?.k === "loose" || s?.k === "pile" ? srcOf(s) : null;
  if (src) send({ t: "flip", from: src });
}

// ---- keyboard

/** What the cursor visits, in order: my hand, the felt's loose cards, the piles, the seats (or a row's cards). */
function targetList(): Spot[] {
  const t = st?.t;
  if (!t) return [];
  if (look) return look.cards.map((_, i) => ({ k: "hand", i }));
  if (picking && t.offer) return t.hands[t.offer.from].map((_, i) => ({ k: "hand", i }));
  const out: Spot[] = [];
  if (mySeat !== null) t.hands[mySeat].forEach((_, i) => out.push({ k: "hand", i }));
  for (const l of t.loose) out.push({ k: "loose", c: l.c & ~UP });
  for (const p of t.piles) out.push({ k: "pile", id: p.id });
  for (const s of seatSpots(t.seats.length, mySeat, L)) out.push({ k: "seat", seat: s.seat });
  return out;
}

function describe(s: Spot | undefined): string {
  const t = st?.t;
  if (!s || !t) return "nothing";
  if (look) return `${nameOf(look.cards[(s as { i: number }).i] & ~UP)}, ${(s as { i: number }).i + 1} of ${look.cards.length}${look.grab === (s as { i: number }).i ? ", held" : ""}`;
  if (picking) return `card ${(s as { i: number }).i + 1} of ${targetList().length}, face down`;
  if (s.k === "hand") return `your hand, ${nameOf(t.hands[mySeat!][s.i])}, ${s.i + 1} of ${t.hands[mySeat!].length}`;
  if (s.k === "loose") {
    const l = t.loose.find((x) => (x.c & ~UP) === s.c);
    return l && l.c & UP ? `on the table, ${nameOf(s.c)}` : "on the table, a card face down";
  }
  if (s.k === "pile") {
    const p = pileById(s.id);
    if (!p) return "nothing";
    const top = p.cards[p.cards.length - 1];
    const what = top === undefined ? "empty" : top & UP ? `${p.cards.length} cards, ${nameOf(top & ~UP)} on top` : `${p.cards.length} cards, face down`;
    return `pile ${p.name}, ${what}`;
  }
  if (s.k === "seat") {
    const seat = t.seats[s.seat];
    if (!seat) return `seat ${s.seat + 1}, free`;
    const offer = t.offer?.from === s.seat && t.offer.to === mySeat ? ", offers you a pick: press Enter" : "";
    return `${seat.name}${st!.here.includes(seat.id) ? "" : " (away)"}, ${t.hands[s.seat].length} cards${offer}`;
  }
  return "the table";
}

function announce(): void {
  const s = targetList()[cursor];
  say((held ? `holding ${held.up ? nameOf(held.c) : "a card"}; ` : "") + describe(s));
}

canvas.addEventListener("keydown", (e) => {
  if (!st || !game) return;
  const targets = targetList();
  const k = e.key;
  if (k.startsWith("Arrow")) {
    e.preventDefault();
    if (!targets.length) return say("nothing here");
    cursorShown = true;
    cursor = (cursor + (k === "ArrowRight" || k === "ArrowDown" ? 1 : -1) + targets.length) % targets.length;
    if (look && look.grab !== null) {
      moveInLook(look.grab, cursor);
      look.grab = cursor;
    }
    draw();
    return announce();
  }
  const cur = targets[cursor];
  if (k === "Escape") {
    if (look) cancelLook();
    else if (picking) picking = false;
    else if (held) {
      held = null;
      say("put back");
    }
    return draw();
  }
  if (k === "Enter" || k === " ") {
    e.preventDefault();
    if (look) {
      look.grab = look.grab === null ? cursor : null;
      draw();
      return announce();
    }
    if (picking) {
      send({ t: "pick", i: cursor });
      picking = false;
      return draw();
    }
    if (!cur) return;
    if (held) {
      const dest: Dest | null =
        cur.k === "pile" ? { k: "pile", id: cur.id } : cur.k === "seat" ? { k: "hand", seat: cur.seat } : cur.k === "hand" && mySeat !== null ? { k: "hand", seat: mySeat } : cur.k === "loose" ? { k: "felt", at: freeSpot(st.t) } : null;
      drop(dest);
      return;
    }
    if (cur.k === "seat") {
      selected = cur;
      if (st.t.offer?.from === cur.seat && st.t.offer.to === mySeat) {
        picking = true;
        cursor = 0;
        draw();
        return say(`Pick one of ${st.t.hands[cur.seat].length} cards with the arrows and Enter`);
      }
      return draw();
    }
    const src = srcOf(cur);
    const card = src && cardOf(src);
    if (src && card && mySeat !== null) {
      held = { src, ...card, by: "key", x: 0, y: 0, moved: false, gx: 0, gy: 0, group: [], pile: null };
      selected = cur;
      draw();
      return say(`picked up ${card.up ? nameOf(card.c) : "a card"}: move to where it goes and press Enter, or T for the table`);
    }
    return;
  }
  const letter = k.toLowerCase();
  if (letter === "t" && held) return drop({ k: "felt", at: freeSpot(st.t) });
  if (!cur || mySeat === null) return;
  if (letter === "f" && (cur.k === "loose" || cur.k === "pile") && allowed("place")) send({ t: "flip", from: srcOf(cur)! });
  else if (letter === "l" && cur.k === "pile") startLook(cur.id);
  else if (letter === "d" && cur.k === "pile" && allowed("draw")) send({ t: "draw", pile: cur.id });
});

// ---- size

function fit(): void {
  // wide: the table beside the panel, as large as the stage allows (its width, and the window's height less
  // the bar); narrow (a phone): one column, the table as wide as the window, the panel under it
  const wide = window.innerWidth >= WIDE.w + 240 + 30; // the table at 1x or more beside a panel of 240 px
  main.classList.toggle("narrow", !wide);
  // the buttons for the selected card: at the top of the panel beside the table (the table keeps the
  // height), under the table in one column
  if (wide && bar.parentElement !== panel.root) panel.root.prepend(bar);
  if (!wide && bar.parentElement !== stage) stage.append(bar);
  const w = (wide ? stage.clientWidth : window.innerWidth) - 12;
  const layout = wide ? WIDE : layoutFor(w);
  const k = wide ? Math.min(w / layout.w, (window.innerHeight - 12) / layout.h) : w / layout.w;
  // quarter steps from 1x: as large as the space allows (a card reads well from about 1.75x) with pixels
  // that stay nearly even
  const next = k >= 1 ? Math.max(1, Math.min(4, Math.floor(k * 4) / 4)) : Math.max(0.5, k);
  if (next !== scale || layout !== L) {
    scale = next;
    L = layout;
    draw();
  }
}
window.addEventListener("resize", fit);

// ---- messages from the page

function setLog(entries: LogEntry[]): void {
  const before = log.length;
  log = entries;
  refreshPanel();
  const last = entries[entries.length - 1];
  if (last && entries.length !== before) say(sentence(last, seatName, nameOf));
}

hqView.onMessage<ViewIn>((m) => {
  if (!m || typeof m !== "object" || typeof m.id !== "string") return;
  if (m.id !== tableId) {
    // another table in the same view: nothing of the previous one carries over
    tableId = m.id;
    selected = null;
    held = null;
    look = null;
    picking = false;
    cursor = 0;
    log = [];
  }
  if (m.t === "game") {
    game = m.g;
    loadSheet();
  } else if (m.t === "state") {
    st = m.s;
    version++;
    dropped = null;
    me = m.me;
    const i = st.t.seats.findIndex((s) => s?.id === me);
    mySeat = i < 0 ? null : i;
    // what I held or selected may be gone
    if (held && !cardOf(held.src)) held = null;
    if (selected && selected.k !== "seat" && !srcOf(selected)) selected = null;
    if (selected && selected.k === "hand" && (mySeat === null || selected.i >= st.t.hands[mySeat].length)) selected = null;
    if (selected && selected.k === "loose" && !st.t.loose.some((l) => (l.c & ~UP) === (selected as { c: number }).c)) selected = null;
    if (selected && selected.k === "pile" && !pileById(selected.id)) selected = null;
    if (look && !pileById(look.pile)) look = null;
    if (picking && st.t.offer?.to !== mySeat) picking = false;
    cursor = Math.min(cursor, Math.max(0, targetList().length - 1));
    refreshPanel();
  } else if (m.t === "log") {
    setLog(m.log);
  }
  if (m.t === "game") refreshPanel();
  draw();
});

new ResizeObserver(fit).observe(stage); // the stage's width changes with the window and the panel
fit();
draw();
