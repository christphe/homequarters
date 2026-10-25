// hq-chess's board view: the script plugin.json's "views" names, run by Home Quarters in a sandboxed iframe
// of the Chess window. It only talks to the plugin's client code (public/client.ts) through hqView: it
// gets { s, me, id } (the board's state, my member id, which board) and sends one message per action:
// { t: "move", from, to, promote? }, { t: "place", piece, to } or { t: "stash", from }.
//
// A canvas: the 8 x 8 squares of 16 px, with a reserve strip above and below (the captured pieces in 8 px
// cells, 16 a row, a second row once a side has more than 16), scaled by a whole number (pixel art stays
// crisp), flipped for the Black player. The strip next to a side's edge of the board holds that side's
// pieces. Pointer: drag one of your pieces (on the board or in a strip) and drop it on a square or on a
// strip (outside the canvas it goes back), or click it, then click where it goes. A pawn of yours dropped
// on its last rank opens a choice of queen, rook, bishop or knight (Escape or a click elsewhere keeps the
// pawn). Keyboard: the arrows move a cursor over the squares and into the strips, Enter or Space picks up
// and drops, Escape cancels; a live region says what is under the cursor and every change. The last
// action's squares are tinted (a move: where it started and where it went; a place: where it went; a stash:
// where it started). The canvas takes the largest whole scale its view allows (the window is full screen).
import { START, changeBetween, move, place, seatOf, sideOf, squareName, toReserve, PIECE_NAMES, PROMOTIONS, type Board, type Last, type Position, type Side } from "./game";
import type { Promotion, ViewIn, ViewOut } from "./messages";
import { SMALL_H, SMALL_W, paintPiece } from "./pieces";

const SQ = 16;
const BOARD = SQ * 8;
const CELL = 8; // a reserve cell: half a square
const PER_ROW = BOARD / CELL; // 16 cells a row
const PAD = 1; // above and below a strip's rows
const COLOURS = {
  light: "#f1e2c0",
  dark: "#8c6a52",
  from: "#e8c35a", // the square or cell a piece was picked up from
  to: "#6fb7d9", // where it would land
  cursor: "#d9473b",
  bg: "#3a2a24",
  strip: "#4a3830",
  choice: "#f1e2c0",
  lastLight: "#cbd88a", // the last action's squares, on a light and on a dark square
  lastDark: "#8f9a48",
};

let boardId = ""; // which board the window shows: the same view is reused for another one
let synced = false; // a first state of this board came: later changes are announced
let shown: Position = { p: START, r: "" }; // what the canvas draws: the server's position, or mine until it confirms it
let server: Position = { p: START, r: "" }; // the last position the server sent
let last: Last | null = null; // the squares tinted: the last action, the server's or my own until it confirms it
let serverLast: Last | null = null;
let unconfirmed = 0; // timer: my action was not answered by a state yet
const CONFIRM_MS = 1000; // an action lost on the way (a budget, a full queue) is undone after this
let me = 0;
let mine: Side | null = null;
let flipped = false;

// Where a piece is picked up from: a square, or index i of the reserve string.
type Src = { k: "sq"; sq: number } | { k: "res"; i: number };
// Where the pointer or the cursor is: a square, or a strip (j: its cell, null past its last piece).
type Spot = { k: "sq"; sq: number } | { k: "res"; side: Side; j: number | null };

// held: a piece picked up (pointer or keyboard); drag: where the pointer is while dragging, in canvas pixels
let held: { src: Src; by: "drag" | "click" | "key" } | null = null;
let drag: { x: number; y: number; moved: boolean; startX: number; startY: number } | null = null;
// a pawn of mine dropped on its last rank, waiting for its new piece
let chooser: { from: number; to: number; choice: number } | null = null;
let cursor: { k: "sq"; sq: number } | { k: "res"; side: Side; j: number } = { k: "sq", sq: 52 }; // e2
let cursorShown = false; // the cursor is drawn only once the keyboard is used

const style = document.createElement("style");
style.textContent = `
  html, body { height: 100%; margin: 0; background: transparent; }
  body { display: flex; flex-direction: column; align-items: center; overflow: auto; }
  /* centred while it fits; taller than the view (a short screen) it starts at the top and the view scrolls */
  canvas { margin: auto; flex-shrink: 0; image-rendering: pixelated; touch-action: none; outline: none; }
  canvas:focus-visible { box-shadow: 0 0 0 3px #3b7dd8; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;
document.head.appendChild(style);

const canvas = document.createElement("canvas");
canvas.width = BOARD;
canvas.tabIndex = 0;
canvas.setAttribute("role", "application");
canvas.setAttribute(
  "aria-label",
  "Chessboard with the reserve of captured pieces above and below: arrow keys move, Enter picks up and drops a piece, Escape cancels",
);
document.body.appendChild(canvas);
const live = document.createElement("div");
live.className = "sr";
live.setAttribute("aria-live", "polite");
document.body.appendChild(live);
const ctx = canvas.getContext("2d")!;

function say(text: string): void {
  // the same text twice in a row must be said twice: clear first
  live.textContent = "";
  requestAnimationFrame(() => (live.textContent = text));
}

const sideName = (s: Side) => (s === "w" ? "White" : "Black");
const nameOf = (piece: string) => PIECE_NAMES[piece.toLowerCase()];
function pieceName(piece: string): string {
  const s = sideOf(piece);
  return s ? `${s === "w" ? "white" : "black"} ${nameOf(piece)}` : "empty";
}

// ---- layout ----

/** The reserve indices holding a side's pieces, in capture order. */
function slots(side: Side): number[] {
  const out: number[] = [];
  for (let i = 0; i < shown.r.length; i++) if (sideOf(shown.r[i]) === side) out.push(i);
  return out;
}
/** Rows of each strip: one, or two once a side has more than 16 pieces in the reserve. */
const rows = () => Math.max(1, Math.ceil(Math.max(slots("w").length, slots("b").length) / PER_ROW));
const stripH = () => rows() * CELL + 2 * PAD;
const boardY = () => stripH();
const topSide = (): Side => (flipped ? "w" : "b");
const stripY = (side: Side) => (side === topSide() ? 0 : boardY() + BOARD);
/** The top-left corner of cell j of a side's strip. */
function cellXY(side: Side, j: number): { x: number; y: number } {
  return { x: (j % PER_ROW) * CELL, y: stripY(side) + PAD + Math.floor(j / PER_ROW) * CELL };
}

// screen cell (column, row from the top) <-> square (0 = a8 ... 63 = h1)
const squareAt = (col: number, row: number) => (flipped ? 63 - (row * 8 + col) : row * 8 + col);
const cellOf = (sq: number) => {
  const i = flipped ? 63 - sq : sq;
  return { col: i % 8, row: Math.floor(i / 8) };
};
const squareXY = (sq: number) => {
  const { col, row } = cellOf(sq);
  return { x: col * SQ, y: boardY() + row * SQ };
};

function fit(): void {
  const h = BOARD + 2 * stripH();
  if (canvas.height !== h) canvas.height = h;
  const w = window.innerWidth - 8, hh = window.innerHeight - 8;
  const kw = w / BOARD, k = Math.min(kw, hh / h);
  // the largest whole number that fits (crisp pixels); a short view keeps 2x and scrolls rather than
  // shrink the pieces under it; only a narrow one goes under 2x, and under 1x a smooth fraction
  const fits = k >= 2 ? Math.floor(k) : Math.min(2, kw);
  const scale = fits >= 1 ? Math.floor(fits) : Math.max(0.5, fits);
  canvas.style.width = BOARD * scale + "px";
  canvas.style.height = h * scale + "px";
}
window.addEventListener("resize", () => {
  fit();
  draw();
});

// ---- what is where ----

function pieceOf(src: Src): string {
  return src.k === "sq" ? shown.p[src.sq] : (shown.r[src.i] ?? ".");
}
const canHold = (src: Src) => mine !== null && sideOf(pieceOf(src)) === mine;
const sameSrc = (a: Src, b: Src) => (a.k === "sq" ? b.k === "sq" && a.sq === b.sq : b.k === "res" && a.i === b.i);
/** The piece under a spot, as a source, or null. */
function srcOf(spot: Spot): Src | null {
  if (spot.k === "sq") return { k: "sq", sq: spot.sq };
  if (spot.j === null) return null;
  const i = slots(spot.side)[spot.j];
  return i === undefined ? null : { k: "res", i };
}

/** What is at canvas pixel (x, y), or null outside the canvas. */
function spotAt(x: number, y: number): Spot | null {
  const h = BOARD + 2 * stripH();
  if (x < 0 || y < 0 || x >= BOARD || y >= h) return null;
  const by = boardY();
  if (y >= by && y < by + BOARD) return { k: "sq", sq: squareAt(Math.floor(x / SQ), Math.floor((y - by) / SQ)) };
  const side = y < by ? topSide() : topSide() === "w" ? "b" : "w";
  const row = Math.min(rows() - 1, Math.max(0, Math.floor((y - stripY(side) - PAD) / CELL)));
  const j = row * PER_ROW + Math.floor(x / CELL);
  return { k: "res", side, j: j < slots(side).length ? j : null };
}

function canvasXY(ev: PointerEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: ((ev.clientX - r.left) / r.width) * canvas.width, y: ((ev.clientY - r.top) / r.height) * canvas.height };
}

// ---- drawing ----

const set = (x: number, y: number, c: string) => {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, 1, 1);
};

function frame(x: number, y: number, w: number, h: number, colour: string): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/** The promotion choice's box: four cells of 10 px over or under the target square. */
function chooserBox(to: number): { x: number; y: number } {
  const { x, y } = squareXY(to);
  const bx = Math.min(BOARD - 42, Math.max(0, x + SQ / 2 - 21));
  const { row } = cellOf(to);
  return { x: bx, y: row < 4 ? y + SQ : y - 12 };
}

function draw(): void {
  fit();
  const lifted = held !== null && (drag?.moved === true || held.by === "key");
  ctx.fillStyle = COLOURS.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // the strips
  for (const side of ["w", "b"] as const) {
    ctx.fillStyle = COLOURS.strip;
    ctx.fillRect(0, stripY(side), BOARD, stripH());
    slots(side).forEach((i, j) => {
      const { x, y } = cellXY(side, j);
      if (held && held.src.k === "res" && held.src.i === i) {
        ctx.fillStyle = COLOURS.from;
        ctx.fillRect(x, y, CELL, CELL);
        if (lifted) return;
      }
      paintPiece(shown.r[i], x, y, set, true);
    });
  }
  // the squares
  const by = boardY();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const sq = squareAt(col, row);
      ctx.fillStyle = (row + col) % 2 === 0 ? COLOURS.light : COLOURS.dark;
      if (last && (sq === last.from || sq === last.to)) ctx.fillStyle = (row + col) % 2 === 0 ? COLOURS.lastLight : COLOURS.lastDark;
      if (held && held.src.k === "sq" && sq === held.src.sq) ctx.fillStyle = COLOURS.from;
      ctx.fillRect(col * SQ, by + row * SQ, SQ, SQ);
    }
  }
  // where the held piece would land
  const target: Spot | null = held && drag?.moved ? spotAt(drag.x, drag.y) : held?.by === "key" ? cursorSpot() : null;
  if (held && target) {
    if (target.k === "sq" && !(held.src.k === "sq" && held.src.sq === target.sq)) {
      const { x, y } = squareXY(target.sq);
      frame(x, y, SQ, SQ, COLOURS.to);
    } else if (target.k === "res" && held.src.k === "sq") frame(0, stripY(target.side), BOARD, stripH(), COLOURS.to);
  }
  if (cursorShown) {
    if (cursor.k === "sq") {
      const { x, y } = squareXY(cursor.sq);
      frame(x, y, SQ, SQ, COLOURS.cursor);
    } else {
      const { x, y } = cellXY(cursor.side, cursor.j);
      frame(x, y, CELL, CELL, COLOURS.cursor);
    }
  }
  // the pieces (a pawn waiting for its promotion already stands on its new square)
  for (let sq = 0; sq < 64; sq++) {
    const piece = shown.p[sq];
    if (piece === "." || (lifted && held!.src.k === "sq" && held!.src.sq === sq)) continue;
    if (chooser && (sq === chooser.from || sq === chooser.to)) continue;
    const { x, y } = squareXY(sq);
    paintPiece(piece, x + 2, y + 2, set);
  }
  if (chooser) {
    const { x, y } = squareXY(chooser.to);
    paintPiece(shown.p[chooser.from], x + 2, y + 2, set);
    drawChooser(chooser);
  }
  if (held && lifted) {
    const piece = pieceOf(held.src);
    if (drag?.moved) paintPiece(piece, Math.round(drag.x) - 5, Math.round(drag.y) - 8, set);
    else if (cursor.k === "sq") {
      const { x, y } = squareXY(cursor.sq);
      paintPiece(piece, x + 2, y, set); // lifted 2 px over the cursor
    } else {
      const { x, y } = cellXY(cursor.side, cursor.j);
      paintPiece(piece, x, y - 1, set, true);
    }
  }
}

function drawChooser(c: { to: number; choice: number }): void {
  const { x, y } = chooserBox(c.to);
  ctx.fillStyle = "#1a1526";
  ctx.fillRect(x, y, 42, 12);
  const white = mine === "w";
  PROMOTIONS.forEach((p, i) => {
    const cx = x + 1 + i * 10;
    ctx.fillStyle = i === c.choice ? COLOURS.from : COLOURS.choice;
    ctx.fillRect(cx, y + 1, 10, 10);
    paintPiece(white ? p.toUpperCase() : p, cx + Math.floor((10 - SMALL_W) / 2), y + 1 + Math.floor((10 - SMALL_H) / 2), set, true);
  });
}

/** The promotion choice under canvas pixel (x, y), or -1. */
function choiceAt(x: number, y: number): number {
  if (!chooser) return -1;
  const b = chooserBox(chooser.to);
  if (y < b.y + 1 || y >= b.y + 11 || x < b.x + 1 || x >= b.x + 41) return -1;
  return Math.floor((x - b.x - 1) / 10);
}

// ---- actions ----

/** Plays my action on the canvas at once and sends it; the next state confirms or corrects it. */
function act(out: ViewOut): void {
  const b: Board = { p: shown.p, r: shown.r, w: null, b: null };
  b[mine!] = { id: me, name: "" };
  const ok =
    out.t === "move" ? move(b, me, out.from, out.to, out.promote) : out.t === "place" ? place(b, me, out.piece, out.to) : toReserve(b, me, out.from);
  if (!ok) return;
  const before = shown;
  shown = { p: b.p, r: b.r };
  last = b.m ?? null;
  hqView.send(out);
  // the server answers every action of mine with a state, applied or refused; without one, it was lost
  clearTimeout(unconfirmed);
  unconfirmed = setTimeout(() => {
    if (shown.p === server.p && shown.r === server.r) return;
    shown = server;
    last = serverLast;
    say("Move not received: the board shows the last position again");
    draw();
  }, CONFIRM_MS);
  const text = changeBetween(before, shown);
  if (text) say(text);
}

const lastRank = (sq: number) => (mine === "w" ? sq < 8 : sq >= 56);

/** Drops the held piece on a spot (null: back where it was). */
function drop(to: Spot | null): void {
  const h = held;
  held = null;
  drag = null;
  if (h && to && canHold(h.src)) {
    const piece = pieceOf(h.src);
    if (h.src.k === "sq" && to.k === "sq" && to.sq !== h.src.sq) {
      if (piece.toLowerCase() === "p" && lastRank(to.sq)) {
        chooser = { from: h.src.sq, to: to.sq, choice: 0 };
        say(`${sideName(mine!)}: pawn ${squareName(h.src.sq)} to ${squareName(to.sq)}. Becomes a queen: left and right arrows choose, Enter confirms, Escape keeps the pawn`);
      } else act({ t: "move", from: h.src.sq, to: to.sq });
    } else if (h.src.k === "sq" && to.k === "res") act({ t: "stash", from: h.src.sq });
    else if (h.src.k === "res" && to.k === "sq") act({ t: "place", piece, to: to.sq });
  }
  draw();
}

/** Closes the promotion choice: a piece, or null to keep the pawn. */
function choose(p: Promotion | null): void {
  const c = chooser;
  chooser = null;
  if (c && shown.p[c.from].toLowerCase() === "p" && sideOf(shown.p[c.from]) === mine) {
    act(p ? { t: "move", from: c.from, to: c.to, promote: p } : { t: "move", from: c.from, to: c.to });
  }
  draw();
}

// ---- pointer ----

canvas.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0) return;
  const { x, y } = canvasXY(ev);
  if (chooser) {
    const i = choiceAt(x, y);
    choose(i >= 0 ? PROMOTIONS[i] : null); // a click elsewhere keeps the pawn, as Escape does
    return;
  }
  const spot = spotAt(x, y);
  if (!spot) return;
  cursorShown = false;
  const src = srcOf(spot);
  if (held && held.by === "click") {
    // the second click: the same piece lets it go, another of mine takes the selection, anywhere else is the drop
    if (src && sameSrc(src, held.src)) {
      held = null;
      draw();
    } else if (src && canHold(src)) {
      held = { src, by: "click" };
      drag = { x, y, moved: false, startX: x, startY: y };
      canvas.setPointerCapture(ev.pointerId);
      draw();
    } else drop(spot);
    return;
  }
  if (!src || !canHold(src)) return;
  held = { src, by: "drag" };
  drag = { x, y, moved: false, startX: x, startY: y };
  canvas.setPointerCapture(ev.pointerId);
  draw();
});

canvas.addEventListener("pointermove", (ev) => {
  if (!drag || !held) return;
  const { x, y } = canvasXY(ev);
  drag.x = x;
  drag.y = y;
  if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) > 3) drag.moved = true;
  if (drag.moved) draw(); // the canvas only: nothing is sent while dragging
});

canvas.addEventListener("pointerup", (ev) => {
  if (!drag || !held) return;
  const { x, y } = canvasXY(ev);
  if (drag.moved) drop(spotAt(x, y)); // outside the canvas: back where it was
  else {
    // a click without moving: the piece stays picked up until the next click
    held = { src: held.src, by: "click" };
    drag = null;
    say(`${pieceName(pieceOf(held.src))} ${where(held.src)} picked up`);
    draw();
  }
});

canvas.addEventListener("pointercancel", () => {
  held = null;
  drag = null;
  draw();
});

// ---- keyboard ----

const where = (src: Src) => (src.k === "sq" ? squareName(src.sq) : "from the reserve");

function cursorSpot(): Spot {
  return cursor.k === "sq" ? cursor : { k: "res", side: cursor.side, j: cursor.j < slots(cursor.side).length ? cursor.j : null };
}

function describeCursor(): string {
  if (cursor.k === "sq") return `${squareName(cursor.sq)}, ${pieceName(shown.p[cursor.sq])}`;
  const s = slots(cursor.side);
  const head = `${sideName(cursor.side)} reserve`;
  return cursor.j < s.length ? `${head}, ${cursor.j + 1} of ${s.length}, ${nameOf(shown.r[s[cursor.j]])}` : `${head}, empty`;
}

/** Moves the cursor one step: over the squares, and from the edge rows into the strips and back. */
function step(dx: number, dy: number): void {
  const last = (side: Side) => Math.max(0, slots(side).length - 1);
  const bottom: Side = topSide() === "w" ? "b" : "w";
  if (cursor.k === "sq") {
    const { col, row } = cellOf(cursor.sq);
    if (dy < 0 && row === 0) {
      cursor = { k: "res", side: topSide(), j: Math.min((rows() - 1) * PER_ROW + col * 2, last(topSide())) };
    } else if (dy > 0 && row === 7) {
      cursor = { k: "res", side: bottom, j: Math.min(col * 2, last(bottom)) };
    } else cursor = { k: "sq", sq: squareAt(Math.min(7, Math.max(0, col + dx)), Math.min(7, Math.max(0, row + dy))) };
    return;
  }
  const { side } = cursor;
  const j = Math.min(cursor.j, last(side));
  if (dx) cursor = { k: "res", side, j: Math.min(last(side), Math.max(0, j + dx)) };
  else {
    const next = j + dy * PER_ROW;
    const row = Math.floor(j / PER_ROW);
    const leaves = side === topSide() ? dy > 0 && row === rows() - 1 : dy < 0 && row === 0;
    if (leaves) cursor = { k: "sq", sq: squareAt(Math.floor((j % PER_ROW) / 2), side === topSide() ? 0 : 7) };
    else if (next >= 0 && next <= last(side)) cursor = { k: "res", side, j: next };
  }
}

canvas.addEventListener("keydown", (ev) => {
  if (chooser) {
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      ev.preventDefault();
      chooser.choice = (chooser.choice + (ev.key === "ArrowLeft" ? 3 : 1)) % 4;
      say(PIECE_NAMES[PROMOTIONS[chooser.choice]]);
      draw();
    } else if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      choose(PROMOTIONS[chooser.choice]);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      choose(null);
    }
    return;
  }
  const moves: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const d = moves[ev.key];
  if (d) {
    ev.preventDefault();
    if (!cursorShown) cursorShown = true;
    else step(d[0], d[1]);
    say(describeCursor());
    draw();
  } else if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    cursorShown = true;
    const spot = cursorSpot();
    const src = srcOf(spot);
    if (held) {
      if ((src && sameSrc(src, held.src)) || (spot.k === "res" && held.src.k === "res")) {
        held = null;
        say(`${describeCursor()}, put back`);
      } else drop(spot);
    } else if (src && canHold(src)) {
      held = { src, by: "key" };
      say(`${pieceName(pieceOf(src))} ${where(src)} picked up`);
    } else say(mine ? `${describeCursor()}: not one of your pieces` : `${describeCursor()}: take a seat to play`);
    draw();
  } else if (ev.key === "Escape" && held) {
    ev.preventDefault();
    held = null;
    drag = null;
    say("Cancelled");
    draw();
  }
});

canvas.addEventListener("blur", () => {
  if (held?.by === "key") held = null;
  cursorShown = false;
  draw();
});

// ---- states from the page ----

const validPos = (s: { p?: unknown; r?: unknown }) =>
  typeof s.p === "string" && s.p.length === 64 && typeof s.r === "string" && s.r.length <= 30;
const squareOrNone = (v: unknown) => v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 63);
const lastOf = (m: unknown): Last | null => {
  if (typeof m !== "object" || m === null) return null;
  const { from, to } = m as Last;
  return squareOrNone(from) && squareOrNone(to) ? { from, to } : null;
};

hqView.onMessage<ViewIn>((m) => {
  if (!m || typeof m !== "object" || !m.s || !validPos(m.s) || typeof m.id !== "string") return;
  if (m.id !== boardId) {
    // another board in the same view: nothing of the previous one carries over
    boardId = m.id;
    synced = false;
    held = null;
    drag = null;
    chooser = null;
    last = serverLast = null;
    clearTimeout(unconfirmed);
  }
  const before = shown;
  const s = m.s;
  me = m.me;
  const side = seatOf({ p: s.p, w: s.w, b: s.b, r: s.r }, m.me);
  if (side !== mine || flipped !== (side === "b")) {
    mine = side;
    const turn = flipped !== (side === "b");
    flipped = side === "b";
    if (turn) cursor = { k: "sq", sq: flipped ? 12 : 52 }; // my pawn in front of my king
  }
  clearTimeout(unconfirmed);
  shown = server = { p: s.p, r: s.r };
  last = serverLast = lastOf(s.m);
  // somebody else's action (mine was said when I made it, and the server's copy matches what I show), or an undo
  const moved = before.p !== shown.p || before.r !== shown.r;
  if (synced && moved && (s.undone === "w" || s.undone === "b")) say(`${sideName(s.undone)} undid the last move`);
  else if (synced) {
    const text = changeBetween(before, shown);
    if (text) say(text);
  }
  synced = true;
  // a held reserve piece is found by its index: any change of the reserve lets it go
  if (held && (!canHold(held.src) || (held.src.k === "res" && before.r !== shown.r))) {
    held = null;
    drag = null;
  }
  if (chooser && !(shown.p[chooser.from].toLowerCase() === "p" && sideOf(shown.p[chooser.from]) === mine)) chooser = null;
  draw();
});

draw();
