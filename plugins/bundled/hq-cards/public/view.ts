// hq-cards's table view: the script plugin.json's "views" names, run by Home Quarters in a sandboxed iframe
// of the Cards window. It only talks to the plugin's client code (public/client.ts) through hqView: it gets
// the game, the table's state and its log (each in its own message), and sends one message per action,
// never while a card is being dragged.
//
// A canvas seen from above (public/layout.ts): the felt in the middle with its piles and loose cards, the
// other seats around it (their names and the backs of their cards), my hand fanned under it. What a member
// should not see is hidden here: other hands and face-down cards show their backs, a pile only its top,
// unless I look through it. Pointer: drag a card (from my hand, the felt or the top of a pile) and drop it
// on the felt, a pile, a player's name (to give it) or my hand; a double click turns a card over. A row of
// buttons under the canvas acts on the selected pile, card or seat. Keyboard: the arrows move a cursor over
// my hand, the felt's cards and piles and the seats; Enter picks up and drops; F turns over, L looks, D
// draws, T puts the held card on the table; Escape cancels. A live region says what is under the cursor
// and every new line of the log, which is also listed under the canvas.
import { CARD_H, CARD_W, paintBack, paintCard } from "./art.ts";
import { cardName, type ClientGame } from "./games.ts";
import { cardAt, FELT_H, FELT_W, FX, FY, handSpots, hit, SEAT_H, SEAT_W, seatSpots, VIEW_H, VIEW_W, type Spot } from "./layout.ts";
import { sentence, type LogEntry } from "./log.ts";
import type { Act, TableState, ViewIn } from "./messages.ts";
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

// a card picked up: from where, which card, and (while dragging) where the pointer is, in view pixels
let held: { src: Src; c: number; up: boolean; by: "drag" | "key"; x: number; y: number; moved: boolean } | null = null;
// looking through a pile: its cards in my order; picking from a hand offered to me
let look: { pile: string; cards: number[]; changed: boolean; grab: number | null } | null = null;
let picking = false;
let cursor = 0; // the keyboard's target, an index in targets()
let cursorShown = false;

const style = document.createElement("style");
style.textContent = `
  html, body { margin: 0; background: transparent; color: ${C.text}; font: 13px system-ui, sans-serif; }
  body { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 4px; }
  canvas { image-rendering: pixelated; touch-action: none; outline: none; flex-shrink: 0; }
  canvas:focus-visible { box-shadow: 0 0 0 3px #3b7dd8; }
  .bar { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; min-height: 28px; }
  .bar button { font: inherit; padding: 3px 10px; border-radius: 4px; border: 1px solid #1a1526; background: #f4efe2; color: #1a1526; cursor: pointer; }
  .bar button:focus-visible { outline: 3px solid #3b7dd8; outline-offset: 1px; }
  .log { width: min(100%, 640px); max-height: 120px; overflow: auto; margin: 0; padding: 4px 8px 4px 28px; background: #2b1f1b; border-radius: 4px; }
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
const logList = document.createElement("ol");
logList.className = "log";
logList.setAttribute("aria-label", "Table log");
const live = document.createElement("div");
live.className = "sr";
live.setAttribute("aria-live", "polite");
// one landmark around everything, so every part of the view belongs to a region
const main = document.createElement("main");
main.style.cssText = "display: contents";
main.append(canvas, bar, logList, live);
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

/** What a drop at view pixel (x, y) lands on. */
function dropAt(x: number, y: number): Dest | null {
  if (mySeat !== null && y >= FY + FELT_H && x >= FX && x < FX + FELT_W) return { k: "hand", seat: mySeat };
  const s = st && hit(st.t, mySeat, x, y);
  if (!s) return null;
  if (s.k === "pile") return { k: "pile", id: s.id };
  if (s.k === "seat") return { k: "hand", seat: s.seat };
  if (s.k === "hand" && mySeat !== null) return { k: "hand", seat: mySeat };
  const at: [number, number] = [Math.max(CARD_W / 2, Math.min(FELT_W - CARD_W / 2, Math.round(x - FX))), Math.max(CARD_H / 2, Math.min(FELT_H - CARD_H / 2, Math.round(y - FY)))];
  return { k: "felt", at };
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

/** The action of dropping the held card on dest, one message, or nothing when it would not change anything. */
function drop(dest: Dest | null): void {
  const h = held;
  held = null;
  if (!h || !dest || !st || mySeat === null) return draw();
  const { src } = h;
  if (dest.k === "hand" && dest.seat === mySeat) {
    if (src.k === "pile") {
      if (allowed("draw")) send({ t: "draw", pile: src.id });
    } else if (src.k === "loose") send({ t: "place", from: src, to: dest, up: false });
    else if (src.k === "hand" && h.by === "drag") {
      // rearranging my hand: the card goes where it was dropped
      const hand = [...st.t.hands[mySeat]];
      const [c] = hand.splice(src.i, 1);
      const spots = handSpots(hand.length + 1);
      let at = spots.findIndex((p) => h.x < p.x + CARD_W / 2);
      if (at < 0) at = hand.length;
      hand.splice(at, 0, c);
      if (hand.some((v, i) => v !== st!.t.hands[mySeat!][i])) send({ t: "order", hand });
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

interface Drawn { c: number; up: boolean; x: number; y: number; where: "hand" | "loose" | "pile" | "seat" | "look" | "pick" }
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

function same(a: Spot | null, b: Spot | null): boolean {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}

function draw(): void {
  canvas.width = VIEW_W * scale;
  canvas.height = VIEW_H * scale;
  canvas.style.width = VIEW_W * scale + "px";
  canvas.style.height = VIEW_H * scale + "px";
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.font = "7px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  drawn = [];
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.fillStyle = C.feltLo;
  ctx.fillRect(FX - 2, FY - 2, FELT_W + 4, FELT_H + 4);
  ctx.fillStyle = C.felt;
  ctx.fillRect(FX, FY, FELT_W, FELT_H);
  const t = st?.t;
  if (!t || !game) {
    text(st?.unavailable ? "This game is not available" : "Choose a game in the window", VIEW_W / 2, VIEW_H / 2);
    return publish();
  }
  const targets = targetList();
  const cur = cursorShown ? targets[cursor] ?? null : null;
  const hide = held && held.by === "drag" && held.moved ? held.src : null;

  // piles: their slot, their top card, their name and count
  for (const p of t.piles) {
    const { x, y } = cardAt(p.at);
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
    if (lookers.length) text(`${lookers.join(", ")} looking`, x + CARD_W / 2, y - 5, C.select);
    const s: Spot = { k: "pile", id: p.id };
    if (same(selected, s)) outline(x, y, CARD_W, CARD_H, C.select);
    if (same(cur, s)) outline(x - 1, y - 1, CARD_W + 2, CARD_H + 2, C.cursor);
  }
  // loose cards, in the order they were put down
  for (const l of t.loose) {
    const c = l.c & ~UP;
    if (hide?.k === "loose" && hide.c === c) continue;
    const { x, y } = cardAt(l.at);
    drawCard(c, !!(l.c & UP), x, y);
    drawn.push({ c, up: !!(l.c & UP), x, y, where: "loose" });
    const s: Spot = { k: "loose", c };
    if (same(selected, s)) outline(x, y, CARD_W, CARD_H, C.select);
    if (same(cur, s)) outline(x - 1, y - 1, CARD_W + 2, CARD_H + 2, C.cursor);
  }
  // the other seats: name (away when their window is closed), their cards' backs, what they are doing
  for (const sp of seatSpots(t.seats.length, mySeat)) {
    const seat = t.seats[sp.seat];
    const x0 = sp.x - SEAT_W / 2, y0 = sp.y - SEAT_H / 2;
    const s: Spot = { k: "seat", seat: sp.seat };
    if (!seat) {
      text(sp.side === "top" ? `Seat ${sp.seat + 1}: free` : `${sp.seat + 1}: free`, sp.x, sp.y, C.muted);
    } else {
      const away = !st!.here.includes(seat.id);
      text(short(seat.name, sp.side === "top" ? 14 : 8) + (away ? " (away)" : ""), sp.x, y0 + 5, away ? C.muted : C.text);
      const n = t.hands[sp.seat].length;
      const shown = Math.min(n, 6);
      for (let i = 0; i < shown; i++) drawCard(0, false, sp.x - (shown * 5) / 2 + i * 5 - 2, y0 + 10, 10);
      text(String(n), sp.x + (shown * 5) / 2 + 8, y0 + 17, C.muted);
      const tags: string[] = [];
      if (t.offer?.from === sp.seat) tags.push(t.offer.to === mySeat ? "offers you a pick" : `offers ${short(seatName(t.offer.to), 8)}`);
      if (tags.length) text(tags.join(" · "), sp.x, y0 + SEAT_H, C.select);
    }
    if (same(selected, s)) outline(x0, y0, SEAT_W, SEAT_H - 2, C.select);
    if (same(cur, s)) outline(x0 - 1, y0 - 1, SEAT_W + 2, SEAT_H, C.cursor);
  }
  // my hand
  if (mySeat !== null) {
    const hand = t.hands[mySeat];
    const spots = handSpots(hand.length);
    hand.forEach((c, i) => {
      if (hide?.k === "hand" && hide.i === i) return;
      const lift = same(selected, { k: "hand", i }) ? 4 : 0;
      drawCard(c, true, spots[i].x, spots[i].y - lift);
      drawn.push({ c, up: true, x: spots[i].x, y: spots[i].y - lift, where: "hand" });
      if (same(cur, { k: "hand", i })) outline(spots[i].x - 1, spots[i].y - lift - 1, CARD_W + 2, CARD_H + 2, C.cursor);
    });
    if (!hand.length) text("Your hand is empty", FX + FELT_W / 2, FY + FELT_H + 22, C.muted);
    if (t.offer?.from === mySeat) text(`You offer your hand to ${short(seatName(t.offer.to), 10)}`, FX + FELT_W / 2, VIEW_H - 3, C.select);
  } else text("Watching: take a seat in the window to play", FX + FELT_W / 2, FY + FELT_H + 22, C.muted);
  // overlays: looking through a pile, picking from an offered hand
  if (look) drawRow(look.cards.map((c) => ({ c: c & ~UP, up: true })), "look", look.grab);
  else if (picking && t.offer && t.offer.to === mySeat) drawRow(t.hands[t.offer.from].map((c) => ({ c, up: false })), "pick", null);
  // the card being dragged
  if (held && held.by === "drag" && held.moved) drawCard(held.c, held.up, held.x - CARD_W / 2, held.y - CARD_H / 2);
  publish();
}

/** A row of cards over the felt (a pile looked through, or a hand to pick from), several rows when long. */
function rowSpots(n: number): { x: number; y: number }[] {
  const per = Math.max(1, Math.floor((FELT_W - 8) / 14));
  return Array.from({ length: n }, (_, i) => ({ x: FX + 4 + (i % per) * 14, y: FY + 18 + Math.floor(i / per) * (CARD_H + 4) }));
}

function drawRow(cards: { c: number; up: boolean }[], where: "look" | "pick", grab: number | null): void {
  ctx.fillStyle = C.shade;
  ctx.fillRect(FX, FY, FELT_W, FELT_H);
  text(where === "look" ? "Drag to reorder, then Done" : "Pick a card", FX + FELT_W / 2, FY + 8);
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
    cards: drawn.map((d) => ({ ...d, x: d.x * scale, y: d.y * scale })),
    scale,
    seat: mySeat,
    sheet: !game || "standard" in game.deck ? null : sheet ? "loaded" : "loading",
    log: [...logList.children].map((li) => li.textContent),
  };
  toolbar();
}

// ---- the buttons under the canvas, for what is selected

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
        if (allowed("createPile") && p.mine && !p.cards.length) out.push(button(`Remove ${short(p.name, 12)}`, () => send({ t: "delPile", pile: id })));
      }
    } else if (selected.k === "loose") {
      const c = selected.c;
      if (allowed("place")) {
        out.push(button("Turn it over", () => send({ t: "flip", from: { k: "loose", c } })));
        out.push(button("Take it back", () => send({ t: "place", from: { k: "loose", c }, to: { k: "hand", seat: mySeat! }, up: false })));
      }
    } else if (selected.k === "hand") {
      const i = selected.i;
      if (allowed("place")) {
        out.push(button("Put it on the table face up", () => send({ t: "place", from: { k: "hand", i }, to: { k: "felt", at: freeSpot(t) }, up: true })));
        out.push(button("Put it on the table face down", () => send({ t: "place", from: { k: "hand", i }, to: { k: "felt", at: freeSpot(t) }, up: false })));
      }
    } else if (selected.k === "seat") {
      const s = selected.seat;
      if (t.offer?.from === s && t.offer.to === mySeat) out.push(button(`Draw a card from ${short(seatName(s), 12)}`, () => ((picking = true), draw())));
    }
  }
  const key = out.map((b) => b.textContent).join("|");
  if (key === barKey) return; // keep the focus on a button that stays
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
  return { x: ((e.clientX - r.left) / r.width) * VIEW_W, y: ((e.clientY - r.top) / r.height) * VIEW_H };
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
  const s = hit(st.t, mySeat, p.x, p.y);
  selected = s && s.k !== "felt" ? s : null;
  if (s?.k === "seat" && st.t.offer?.from === s.seat && st.t.offer.to === mySeat) picking = true;
  const src = srcOf(s);
  const card = src && cardOf(src);
  if (src && card && mySeat !== null) {
    held = { src, ...card, by: "drag", x: p.x, y: p.y, moved: false };
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

canvas.addEventListener("dblclick", (e) => {
  if (!st || mySeat === null || !allowed("place")) return;
  const p = toView(e);
  const s = hit(st.t, mySeat, p.x, p.y);
  const src = s?.k === "loose" || s?.k === "pile" ? srcOf(s) : null;
  if (src) send({ t: "flip", from: src });
});

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
  for (const s of seatSpots(t.seats.length, mySeat)) out.push({ k: "seat", seat: s.seat });
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
      held = { src, ...card, by: "key", x: 0, y: 0, moved: false };
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
  const w = window.innerWidth - 12;
  const k = w / VIEW_W;
  // whole and half steps: at 1x a 20 x 28 card is too small to read in a large window (about 700 px wide)
  const next = k >= 1 ? Math.max(1, Math.min(4, Math.floor(k * 2) / 2)) : Math.max(0.5, k);
  if (next !== scale) {
    scale = next;
    draw();
  }
}
window.addEventListener("resize", fit);

// ---- messages from the page

function setLog(entries: LogEntry[]): void {
  const before = logList.children.length;
  const lines = entries.map((e) => sentence(e, seatName, nameOf));
  logList.replaceChildren(...lines.map((s) => Object.assign(document.createElement("li"), { textContent: s })));
  logList.scrollTop = logList.scrollHeight;
  const last = lines[lines.length - 1];
  if (last && (lines.length !== before || entries !== log)) say(last);
  log = entries;
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
    logList.replaceChildren();
  }
  if (m.t === "game") {
    game = m.g;
    loadSheet();
  } else if (m.t === "state") {
    st = m.s;
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
  } else if (m.t === "log") {
    setLog(m.log);
  }
  draw();
});

fit();
draw();
