// Draws hq-cards's picture on the map in code and writes it as a PNG (node:zlib only, no dependency):
//   public/deck.png  16 x 16, a deck of cards on a table, seen from above at the office's 3/4 angle
// Run from anywhere: node plugins/bundled/hq-cards/tools/sprite.mjs. Commit the PNG it writes.
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

// The deck on the map: a squared stack of cards seen from above at the office's 3/4 angle, its back's red
// lattice on top, the edges of the cards below as a striped front, and one card slid out to the right,
// face up, so it reads as playing cards and not as a book.
function deck() {
  const c = canvas(16, 16);
  const back = { hi: "#e07a6a", mid: "#b8443a", lo: "#86302c" };
  const paper = { hi: "#ffffff", mid: "#efe9dc", lo: "#c9bfae" };
  // the card slid out, face up, under the stack's right edge
  c.rect(8, 4, 8, 10, OUT);
  c.rect(9, 5, 6, 8, paper.mid);
  c.rect(9, 5, 6, 1, paper.hi);
  c.rect(14, 6, 1, 7, paper.lo);
  c.set(12, 7, "#c8463c"); // a red pip
  c.set(11, 8, "#c8463c");
  c.set(12, 8, "#c8463c");
  c.set(13, 8, "#c8463c");
  c.set(12, 9, "#c8463c");
  // the stack: outline, its top (a back) and the cards' edges in front
  c.rect(1, 2, 10, 13, OUT);
  c.rect(2, 3, 8, 8, back.mid);
  c.rect(2, 3, 8, 1, back.hi);
  c.rect(2, 3, 1, 8, back.hi);
  for (let y = 4; y < 10; y++) for (let x = 3; x < 9; x++) if ((x + y) % 2 === 0) c.set(x, y, back.lo);
  c.rect(3, 4, 6, 1, back.hi); // the inner frame of the back
  c.rect(2, 11, 8, 1, paper.hi); // the edges of the cards below
  c.rect(2, 12, 8, 1, paper.lo);
  c.rect(2, 13, 8, 1, paper.mid);
  return c;
}

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
writeFileSync(join(pub, "deck.png"), png(deck()));
console.log("wrote public/deck.png");
