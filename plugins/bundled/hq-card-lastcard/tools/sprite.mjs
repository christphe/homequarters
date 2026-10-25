// Draws Last Card's 108 faces and its back in code and writes them as one PNG (node:zlib only, no dependency):
//   public/shared/cards.png  320 x 196, 109 cells of 20 x 28, 16 per row: frame i at column i % 16, row i / 16;
//                            frames 0-107 are the cards in the order of rules.ts, frame 108 the back
// Run from anywhere: node plugins/bundled/hq-card-lastcard/tools/sprite.mjs. Commit the PNG it writes.
// Style: docs/art-style.md (1 px dark outline, never pure black; light from the top-left; three tones).
// Original design: a coloured card with a framed dark panel, a big upright numeral or icon in it, and small
// upright indices in the top-left and bottom-right corners, so a fanned hand reads from its left edge.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { BACK, CARDS } from "../rules.ts"; // Node strips the types

const OUT = "#1a1526"; // the shared outline colour of web/src/game/art/pixel.ts
const INK = "#f6ecd2"; // numerals and icons, a warm paper white
const W = 20, H = 28, PER_ROW = 16, FRAMES = 109;

function canvas(w, h) {
  const px = new Uint8Array(w * h * 4);
  return {
    w,
    h,
    px,
    set(x, y, hex) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      px[i] = parseInt(hex.slice(1, 3), 16);
      px[i + 1] = parseInt(hex.slice(3, 5), 16);
      px[i + 2] = parseInt(hex.slice(5, 7), 16);
      px[i + 3] = 255;
    },
    rect(x, y, rw, rh, hex) {
      for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) this.set(i, j, hex);
    },
  };
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(c) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(c.h * (1 + c.w * 4));
  for (let y = 0; y < c.h; y++) {
    raw[y * (1 + c.w * 4)] = 0; // filter: none
    Buffer.from(c.px.buffer, y * c.w * 4, c.w * 4).copy(raw, y * (1 + c.w * 4) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Three tones per material (light, mid, dark), shadows drifting toward violet.
const COLOURS = {
  Red: { hi: "#ec7a5c", mid: "#c9443a", lo: "#83283e" },
  Yellow: { hi: "#f7d872", mid: "#dfa92c", lo: "#94612e" },
  Green: { hi: "#7ccb6a", mid: "#3f9a4c", lo: "#22604c" },
  Blue: { hi: "#72a0ea", mid: "#3c68c4", lo: "#2a3a84" },
};
const WILD = { hi: "#5e5478", mid: "#3a3250", lo: "#241e36" };
const BACKC = { hi: "#4c4a82", mid: "#2f2c5a", lo: "#1f1c40" };
const FOUR = [COLOURS.Red.mid, COLOURS.Yellow.mid, COLOURS.Green.mid, COLOURS.Blue.mid]; // top, right, bottom, left

// Big numerals, 6 x 8 with two-pixel strokes. All upright: a 6 and a 9 never look alike.
const BIG = {
  0: [".####.", "##..##", "##..##", "##..##", "##..##", "##..##", "##..##", ".####."],
  1: ["..##..", ".###..", "####..", "..##..", "..##..", "..##..", "..##..", "######"],
  2: [".####.", "##..##", "....##", "...##.", "..##..", ".##...", "##....", "######"],
  3: [".####.", "##..##", "....##", "..###.", "....##", "....##", "##..##", ".####."],
  4: ["...##.", "..###.", ".####.", "##.##.", "######", "...##.", "...##.", "...##."],
  5: ["######", "##....", "#####.", "....##", "....##", "....##", "##..##", ".####."],
  6: ["..###.", ".##...", "##....", "#####.", "##..##", "##..##", "##..##", ".####."],
  7: ["######", "....##", "...##.", "...##.", "..##..", "..##..", "..##..", "..##.."],
  8: [".####.", "##..##", "##..##", ".####.", "##..##", "##..##", "##..##", ".####."],
  9: [".####.", "##..##", "##..##", "##..##", ".#####", "....##", "...##.", ".###.."],
  "+": ["...", "...", ".#.", "###", ".#.", "...", "...", "..."],
};
// Corner indices, 3 x 5 (and 5 x 5 icons).
const SMALL = {
  0: ["###", "#.#", "#.#", "#.#", "###"],
  1: [".#.", "##.", ".#.", ".#.", "###"],
  2: ["##.", "..#", ".#.", "#..", "###"],
  3: ["##.", "..#", ".#.", "..#", "##."],
  4: ["#.#", "#.#", "###", "..#", "..#"],
  5: ["###", "#..", "##.", "..#", "##."],
  6: [".##", "#..", "###", "#.#", "###"],
  7: ["###", "..#", ".#.", ".#.", ".#."],
  8: ["###", "#.#", "###", "#.#", "###"],
  9: ["###", "#.#", "###", "..#", "##."],
  "+": ["...", ".#.", "###", ".#.", "..."],
  skip: [".###.", "#..##", "#.#.#", "##..#", ".###."],
  reverse: [".#...", "#####", ".....", "#####", "...#."],
};
const GAP = [".", ".", ".", ".", "."]; // a column between the plus and its digit
const join_ = (...glyphs) => glyphs[0].map((_, y) => glyphs.map((g) => g[y]).join(""));

// A bitmap in INK with a one-pixel shadow to the bottom-right (light from the top-left).
function stamp(c, x, y, rows, ink = INK, shadow = OUT) {
  rows.forEach((row, j) => [...row].forEach((ch, i) => ch === "#" && c.set(x + i + 1, y + j + 1, shadow)));
  rows.forEach((row, j) => [...row].forEach((ch, i) => ch === "#" && c.set(x + i, y + j, ink)));
}

// The card's outline with cut corners, its three-tone body and the framed panel (x 3-16, y 7-20).
// frame: the panel's inner light line, one colour or four (top, right, bottom, left).
function body(c, x0, y0, t, frame) {
  c.rect(x0 + 1, y0, W - 2, H, OUT);
  c.rect(x0, y0 + 1, W, H - 2, OUT);
  c.rect(x0 + 1, y0 + 1, W - 2, H - 2, t.mid);
  c.rect(x0 + 1, y0 + 1, W - 2, 1, t.hi);
  c.rect(x0 + 1, y0 + 1, 1, H - 2, t.hi);
  c.rect(x0 + 2, y0 + H - 2, W - 3, 1, t.lo);
  c.rect(x0 + W - 2, y0 + 2, 1, H - 3, t.lo);
  // the panel: an outline ring, a light inner frame, a dark well for the numeral
  c.rect(x0 + 3, y0 + 7, 14, 14, OUT);
  const [top, right, bottom, left] = Array.isArray(frame) ? frame : [frame, frame, frame, frame];
  c.rect(x0 + 4, y0 + 8, 12, 1, top);
  c.rect(x0 + 15, y0 + 8, 1, 12, right);
  c.rect(x0 + 4, y0 + 19, 12, 1, bottom);
  c.rect(x0 + 4, y0 + 8, 1, 12, left);
  c.rect(x0 + 5, y0 + 9, 10, 10, t.lo);
}

// Both indices: the top-left one at (2, 2), the bottom-right one ending at (17, 25); both upright.
function indices(c, x0, y0, rows, ink = INK, shadow = OUT) {
  const w = rows[0].length;
  stamp(c, x0 + 2, y0 + 2, rows, ink, shadow);
  stamp(c, x0 + 17 - w, y0 + 21, rows, ink, shadow);
}

// The panel's 10 x 10 well starts at (5, 9): a glyph of w x h plus its shadow, centred.
function centre(c, x0, y0, rows) {
  const w = rows[0].length, h = rows.length;
  stamp(c, x0 + 5 + Math.floor((10 - (w + 1)) / 2), y0 + 9 + Math.floor((10 - (h + 1)) / 2), rows);
}

// Skip: a ring crossed from the top-right to the bottom-left, 9 x 9.
const SKIP_BIG = (() => {
  const rows = [];
  for (let y = 0; y < 9; y++) {
    let r = "";
    for (let x = 0; x < 9; x++) {
      const d = Math.hypot(x - 4, y - 4);
      r += (d >= 2.9 && d <= 4.4) || (Math.abs(x + y - 8) <= 0 && d < 3.5) || (Math.abs(x + y - 8) === 1 && d < 2.5) ? "#" : ".";
    }
    rows.push(r);
  }
  return rows;
})();

// Reverse: two arrows heading opposite ways, each tail bent toward the other, 9 x 9; the lower one is the
// upper one turned half a turn.
const REVERSE_BIG = (() => {
  const g = Array.from({ length: 9 }, () => Array(9).fill("."));
  const upper = [];
  for (let x = 1; x <= 7; x++) upper.push([x, 2]); // the shaft, heading right
  upper.push([1, 3]); // the tail, bent down
  for (let y = 0; y <= 4; y++) upper.push([6, y]); // the head
  upper.push([7, 1], [7, 3], [8, 2]);
  for (const [x, y] of upper) {
    g[y][x] = "#";
    g[8 - y][8 - x] = "#";
  }
  return g.map((r) => r.join(""));
})();

// The four-colour square split along its diagonals (dark seams), size x size, at (x, y).
function split(c, x, y, size) {
  const m = (size - 1) / 2;
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const dx = i - m, dy = j - m;
      const edge = i === 0 || j === 0 || i === size - 1 || j === size - 1;
      if (edge || Math.abs(dx) === Math.abs(dy)) c.set(x + i, y + j, OUT);
      else c.set(x + i, y + j, Math.abs(dy) > Math.abs(dx) ? FOUR[dy < 0 ? 0 : 2] : FOUR[dx > 0 ? 1 : 3]);
    }
}

// Copies of the same card get 0 to 3 tiny light dots at the bottom-left, so every frame of the sheet differs.
function copyMark(c, x0, y0, copy, t) {
  for (let k = 0; k < copy; k++) c.set(x0 + 2 + k * 2, y0 + 25, t.hi);
}

function face(c, x0, y0, name, copy) {
  if (name.startsWith("Wild")) {
    body(c, x0, y0, WILD, FOUR);
    split(c, x0 + 5, y0 + 9, 10);
    if (name === "Wild") {
      // the index: a small split square
      for (const [ix, iy] of [[2, 2], [13, 21]]) split(c, x0 + ix, y0 + iy, 5);
    } else {
      // "+4" over the square, and as the index
      const four = join_(SMALL["+"], GAP, SMALL[4]);
      stamp(c, x0 + 6, y0 + 11, four);
      indices(c, x0, y0, four);
    }
    copyMark(c, x0, y0, copy, WILD);
    return;
  }
  const [colour, ...rest] = name.split(" ");
  const t = COLOURS[colour], what = rest.join(" ");
  body(c, x0, y0, t, t.hi);
  if (/^\d$/.test(what)) {
    centre(c, x0, y0, BIG[what]);
    indices(c, x0, y0, SMALL[what]);
  } else if (what === "Skip") {
    centre(c, x0, y0, SKIP_BIG);
    indices(c, x0, y0, SMALL.skip);
  } else if (what === "Reverse") {
    centre(c, x0, y0, REVERSE_BIG);
    indices(c, x0, y0, SMALL.reverse);
  } else {
    centre(c, x0, y0, join_(BIG["+"], BIG[2]));
    indices(c, x0, y0, join_(SMALL["+"], GAP, SMALL[2]));
  }
  copyMark(c, x0, y0, copy, t);
}

// The back: indigo with a woven diagonal texture inside an inner border, and a split square in the middle.
function back(c, x0, y0) {
  c.rect(x0 + 1, y0, W - 2, H, OUT);
  c.rect(x0, y0 + 1, W, H - 2, OUT);
  c.rect(x0 + 1, y0 + 1, W - 2, H - 2, BACKC.mid);
  c.rect(x0 + 1, y0 + 1, W - 2, 1, BACKC.hi);
  c.rect(x0 + 1, y0 + 1, 1, H - 2, BACKC.hi);
  c.rect(x0 + 2, y0 + H - 2, W - 3, 1, BACKC.lo);
  c.rect(x0 + W - 2, y0 + 2, 1, H - 3, BACKC.lo);
  // an inner border, and a criss-cross weave inside it
  c.rect(x0 + 3, y0 + 3, 14, 22, OUT);
  c.rect(x0 + 4, y0 + 4, 12, 20, BACKC.lo);
  for (let y = 4; y <= 23; y++)
    for (let x = 4; x <= 15; x++) if ((x + y) % 4 === 0 || (x - y + 64) % 4 === 0) c.set(x0 + x, y0 + y, BACKC.hi);
  // the middle: a split square in an outline ring
  c.rect(x0 + 4, y0 + 8, 12, 12, OUT);
  split(c, x0 + 5, y0 + 9, 10);
}

const sheet = canvas(PER_ROW * W, Math.ceil(FRAMES / PER_ROW) * H);
const seen = new Map();
CARDS.forEach(({ name }, i) => {
  const copy = seen.get(name) ?? 0;
  seen.set(name, copy + 1);
  face(sheet, (i % PER_ROW) * W, Math.floor(i / PER_ROW) * H, name, copy);
});
back(sheet, (BACK % PER_ROW) * W, Math.floor(BACK / PER_ROW) * H);

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "shared");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "cards.png"), png(sheet));
console.log(`wrote public/shared/cards.png (${sheet.w} x ${sheet.h})`);
