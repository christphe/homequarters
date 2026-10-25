// hq-chess's board view: the script plugin.json's "views" names, run by Home Quarters in a sandboxed iframe
// of the Chess window. It only talks to the plugin's client code (public/client.ts) through hqView: it
// gets { s, me } (the board's state and my member id) and sends { t: "move", from, to }, one per drop.
//
// A canvas of 8 x 8 squares of 16 px, scaled by a whole number (pixel art stays crisp), flipped for the
// Black player. Pointer: drag one of your pieces and drop it on a square (outside the board it goes back),
// or click it, then click a square. Keyboard: the arrows move a cursor, Enter or Space picks up and drops,
// Escape cancels; a live region says the square under the cursor and every move.
import { START, seatOf, squareName, sideOf, type Side } from "./game";
import type { ViewIn, ViewOut } from "./messages";
import { PIECE_NAMES, paintPiece } from "./pieces";

const SQ = 16;
const SIZE = SQ * 8;
const COLOURS = {
  light: "#f1e2c0",
  dark: "#8c6a52",
  from: "#e8c35a", // the square a piece was picked up from
  to: "#6fb7d9", // the square it would land on
  cursor: "#d9473b",
  bg: "#3a2a24",
};

let synced = false; // a first state came: later changes are moves to announce
let shown = START; // what the canvas draws: the server's position, or my move until it confirms it
let server = START; // the last position the server sent
let unconfirmed = 0; // timer: my move was not answered by a state yet
const CONFIRM_MS = 1000; // a move lost on the way (a budget, a full queue) is undone after this
let mine: Side | null = null;
let flipped = false;
// held: a piece picked up (pointer or keyboard); drag: where the pointer is while dragging, in board pixels
let held: { from: number; by: "drag" | "click" | "key" } | null = null;
let drag: { x: number; y: number; moved: boolean; startX: number; startY: number } | null = null;
let cursor = 52; // e2
let cursorShown = false; // the cursor is drawn only once the keyboard is used

const style = document.createElement("style");
style.textContent = `
  html, body { height: 100%; margin: 0; background: transparent; overflow: hidden; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; }
  canvas { image-rendering: pixelated; touch-action: none; outline: none; }
  canvas:focus-visible { box-shadow: 0 0 0 3px #3b7dd8; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;
document.head.appendChild(style);

const canvas = document.createElement("canvas");
canvas.width = SIZE;
canvas.height = SIZE;
canvas.tabIndex = 0;
canvas.setAttribute("role", "application");
canvas.setAttribute("aria-label", "Chessboard: arrow keys move, Enter picks up and drops a piece, Escape cancels");
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
function pieceName(piece: string): string {
  const s = sideOf(piece);
  return s ? `${s === "w" ? "white" : "black"} ${PIECE_NAMES[piece.toLowerCase()]}` : "empty";
}

// screen cell (column, row from the top) <-> square (0 = a8 ... 63 = h1)
const squareAt = (col: number, row: number) => (flipped ? 63 - (row * 8 + col) : row * 8 + col);
const cellOf = (sq: number) => {
  const i = flipped ? 63 - sq : sq;
  return { col: i % 8, row: Math.floor(i / 8) };
};

function fit(): void {
  const room = Math.min(window.innerWidth, window.innerHeight) - 8;
  const k = Math.max(1, Math.floor(room / SIZE));
  const px = room >= SIZE ? SIZE * k : Math.max(64, room); // under 128 px: a smooth fraction rather than nothing
  canvas.style.width = canvas.style.height = px + "px";
}
window.addEventListener("resize", fit);
fit();

function draw(): void {
  ctx.fillStyle = COLOURS.bg;
  ctx.fillRect(0, 0, SIZE, SIZE);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const sq = squareAt(col, row);
      ctx.fillStyle = (row + col) % 2 === 0 ? COLOURS.light : COLOURS.dark;
      if (held && sq === held.from) ctx.fillStyle = COLOURS.from;
      ctx.fillRect(col * SQ, row * SQ, SQ, SQ);
    }
  }
  const target = held && drag?.moved ? squareUnder(drag.x, drag.y) : held && held.by === "key" ? cursor : null;
  if (target !== null && held && target !== held.from) frame(target, COLOURS.to);
  if (cursorShown) frame(cursor, COLOURS.cursor);
  const set = (x: number, y: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, 1, 1);
  };
  for (let sq = 0; sq < 64; sq++) {
    const piece = shown[sq];
    if (piece === "." || (held && sq === held.from && (drag?.moved || held.by === "key"))) continue;
    const { col, row } = cellOf(sq);
    paintPiece(piece, col * SQ + 2, row * SQ + 2, set);
  }
  if (held) {
    const piece = shown[held.from];
    if (drag?.moved) paintPiece(piece, Math.round(drag.x) - 5, Math.round(drag.y) - 8, set);
    else if (held.by === "key") {
      const { col, row } = cellOf(cursor);
      paintPiece(piece, col * SQ + 2, row * SQ, set); // lifted 2 px over the cursor
    }
  }
}

function frame(sq: number, colour: string): void {
  const { col, row } = cellOf(sq);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.strokeRect(col * SQ + 0.5, row * SQ + 0.5, SQ - 1, SQ - 1);
}

/** The square under board pixel (x, y), or null outside the board. */
function squareUnder(x: number, y: number): number | null {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return null;
  return squareAt(Math.floor(x / SQ), Math.floor(y / SQ));
}

function boardXY(ev: PointerEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: ((ev.clientX - r.left) / r.width) * SIZE, y: ((ev.clientY - r.top) / r.height) * SIZE };
}

const canHold = (sq: number) => mine !== null && sideOf(shown[sq]) === mine;

/** Plays my move on the canvas at once and sends it; the next state confirms or corrects it. */
function play(from: number, to: number): void {
  const piece = shown[from];
  const a = shown.split("");
  a[to] = piece;
  a[from] = ".";
  shown = a.join("");
  const out: ViewOut = { t: "move", from, to };
  hqView.send(out);
  // the server answers every move of mine with a state, applied or refused; without one, the move was lost
  clearTimeout(unconfirmed);
  unconfirmed = setTimeout(() => {
    if (shown === server) return;
    shown = server;
    say("Move not received: the board shows the last position again");
    draw();
  }, CONFIRM_MS);
  say(`${sideName(mine!)}: ${PIECE_NAMES[piece.toLowerCase()]} ${squareName(from)} to ${squareName(to)}`);
}

function drop(to: number | null): void {
  if (held && to !== null && to !== held.from && canHold(held.from)) play(held.from, to);
  held = null;
  drag = null;
  draw();
}

canvas.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0) return;
  const { x, y } = boardXY(ev);
  const sq = squareUnder(x, y);
  if (sq === null) return;
  cursorShown = false;
  if (held && held.by === "click") {
    // the second click: another of my pieces takes the selection, the same one lets it go, any other square is the move
    if (sq === held.from) {
      held = null;
      draw();
    } else if (canHold(sq)) {
      held = { from: sq, by: "click" };
      drag = { x, y, moved: false, startX: x, startY: y };
      canvas.setPointerCapture(ev.pointerId);
      draw();
    } else drop(sq);
    return;
  }
  if (!canHold(sq)) return;
  held = { from: sq, by: "drag" };
  drag = { x, y, moved: false, startX: x, startY: y };
  canvas.setPointerCapture(ev.pointerId);
  draw();
});

canvas.addEventListener("pointermove", (ev) => {
  if (!drag || !held) return;
  const { x, y } = boardXY(ev);
  drag.x = x;
  drag.y = y;
  if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) > 3) drag.moved = true;
  if (drag.moved) draw(); // the canvas only: nothing is sent while dragging
});

canvas.addEventListener("pointerup", (ev) => {
  if (!drag || !held) return;
  const { x, y } = boardXY(ev);
  if (drag.moved) drop(squareUnder(x, y)); // outside the board: back to its square
  else {
    // a click without moving: the piece stays picked up until the next click
    held = { from: held.from, by: "click" };
    drag = null;
    say(`${pieceName(shown[held.from])} ${squareName(held.from)} picked up`);
    draw();
  }
});

canvas.addEventListener("pointercancel", () => {
  held = null;
  drag = null;
  draw();
});

function describe(sq: number): string {
  return `${squareName(sq)}, ${pieceName(shown[sq])}`;
}

canvas.addEventListener("keydown", (ev) => {
  const moves: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const step = moves[ev.key];
  if (step) {
    ev.preventDefault();
    if (!cursorShown) cursorShown = true;
    else {
      const { col, row } = cellOf(cursor);
      cursor = squareAt(Math.min(7, Math.max(0, col + step[0])), Math.min(7, Math.max(0, row + step[1])));
    }
    say(describe(cursor));
    draw();
  } else if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    cursorShown = true;
    if (held) {
      if (cursor === held.from) {
        held = null;
        say(`${describe(cursor)}, put back`);
      } else drop(cursor);
    } else if (canHold(cursor)) {
      held = { from: cursor, by: "key" };
      say(`${pieceName(shown[cursor])} ${squareName(cursor)} picked up`);
    } else say(mine ? `${describe(cursor)}: not one of your pieces` : `${describe(cursor)}: take a seat to play`);
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

/** The move from one position to the next, when exactly one piece moved (possibly taking another). */
function moveBetween(a: string, b: string): { from: number; to: number } | null {
  const diff: number[] = [];
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) diff.push(i);
  if (diff.length !== 2) return null;
  const [x, y] = diff;
  if (b[x] === "." && b[y] === a[x]) return { from: x, to: y };
  if (b[y] === "." && b[x] === a[y]) return { from: y, to: x };
  return null;
}

hqView.onMessage<ViewIn>((m) => {
  if (!m || typeof m !== "object" || !m.s || typeof m.s.p !== "string" || m.s.p.length !== 64) return;
  const before = shown;
  const s = m.s;
  const side = seatOf({ p: s.p, w: s.w, b: s.b }, m.me);
  if (side !== mine || flipped !== (side === "b")) {
    mine = side;
    const turn = flipped !== (side === "b");
    flipped = side === "b";
    if (turn) cursor = flipped ? 12 : 52; // my pawn in front of my king
  }
  clearTimeout(unconfirmed);
  shown = server = s.p;
  // somebody else's move (mine was said when I made it, and the server's copy matches what I show)
  if (synced && before !== shown) {
    const mv = moveBetween(before, shown);
    const piece = mv ? shown[mv.to] : "";
    const who = sideOf(piece);
    if (mv && who) say(`${sideName(who)}: ${PIECE_NAMES[piece.toLowerCase()]} ${squareName(mv.from)} to ${squareName(mv.to)}`);
    else if (shown === START) say("The board is set up for a new game");
  }
  synced = true;
  if (held && !canHold(held.from)) {
    held = null;
    drag = null;
  }
  draw();
});

draw();
