// Draws hq-chess's pictures in code and writes them as PNGs (node:zlib only, no dependency):
//   public/chessboard.png  16 x 16, the board on the map, seen from above at the office's 3/4 angle
//   public/badges.png      14 x 9, two 7 x 9 cells: a white pawn and a black pawn, the playing badge
// Run from anywhere: node plugins/bundled/hq-chess/tools/sprite.mjs. Commit the PNGs it writes.
// Style: docs/art-style.md (1 px dark outline, never pure black; light from the top-left; three tones).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT = "#1a1526"; // the shared outline colour of web/src/game/art/pixel.ts

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

// The board: a wooden frame around an 8 x 8 checker of 1 px squares, a darker front edge (its thickness,
// seen at the office's angle) and two pawns standing on it, so it reads as chess and not as a tablecloth.
function chessboard() {
  const c = canvas(16, 16);
  const wood = { hi: "#d9a066", mid: "#b5773f", lo: "#8a5230", edge: "#6b3a2a" };
  const sq = { light: "#f1e2c0", dark: "#7a5a48" };
  // outline around the top face (rows 1-13) and the front edge (rows 14-15)
  c.rect(0, 1, 16, 15, OUT);
  // top face of the frame, lit from the top-left
  c.rect(1, 2, 14, 12, wood.mid);
  c.rect(1, 2, 14, 1, wood.hi);
  c.rect(1, 2, 1, 12, wood.hi);
  c.rect(14, 3, 1, 11, wood.lo);
  c.rect(2, 13, 13, 1, wood.lo);
  // front edge, the board's thickness
  c.rect(1, 14, 14, 1, wood.edge);
  // the checker: a8 (top-left) is light, as on a real board seen from White's side
  // a recess around the squares, in shadow on its top and left (the light comes from the top-left)
  c.rect(3, 3, 10, 1, wood.lo);
  c.rect(3, 3, 1, 10, wood.lo);
  c.rect(4, 12, 9, 1, wood.hi);
  c.rect(12, 4, 1, 9, wood.hi);
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) c.set(4 + f, 4 + r, (r + f) % 2 === 0 ? sq.light : sq.dark);
  // a white pawn (bottom right) and a black pawn (top left), two pixels wide, rising one pixel above their square
  const pawn = (x, y, body, shade, top) => {
    c.set(x, y - 1, OUT);
    c.set(x + 1, y - 1, OUT);
    c.set(x, y, top);
    c.set(x + 1, y, body);
    c.set(x, y + 1, body);
    c.set(x + 1, y + 1, shade);
  };
  pawn(8, 9, "#efe9dc", "#b9ae9c", "#ffffff");
  pawn(6, 5, "#4a4058", "#2c2536", "#6c5f80");
  return c;
}

// The badge: a pawn in two colours, 7 x 9, outlined. The black one keeps a lit edge so it shows on a dark floor.
const PAWN = [
  "..###..",
  ".#hmm#.",
  ".#mms#.",
  "..#m#..",
  "..#m#..",
  ".#hms#.",
  "#hmmms#",
  "#mmmss#",
  "#######",
];
function badges() {
  const c = canvas(14, 9);
  const tones = [
    { h: "#ffffff", m: "#ece6d8", s: "#b9ae9c" },
    { h: "#7a6c90", m: "#4a4058", s: "#2c2536" },
  ];
  tones.forEach((t, cell) => {
    PAWN.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        if (ch === ".") return;
        c.set(cell * 7 + x, y, ch === "#" ? OUT : t[ch]);
      }),
    );
  });
  return c;
}

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
writeFileSync(join(pub, "chessboard.png"), png(chessboard()));
writeFileSync(join(pub, "badges.png"), png(badges()));
console.log("wrote public/chessboard.png and public/badges.png");
