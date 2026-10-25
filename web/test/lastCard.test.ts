// hq-card-lastcard: the 108 cards and their values, the count hook, the definition hq-cards accepts in two
// parts, and the card sheet. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { BACK, CARDS, CELL, DEFINITION, SHEET, count } from "../../plugins/bundled/hq-card-lastcard/rules.ts";
import { validateCards, validateDefinition } from "../../plugins/bundled/hq-cards/public/games.ts";

const COLOURS = ["Red", "Yellow", "Green", "Blue"];

test("108 cards: 25 per colour, four Wild and four Wild Draw Four", () => {
  assert.equal(CARDS.length, 108);
  COLOURS.forEach((c, i) => {
    const mine = CARDS.slice(i * 25, i * 25 + 25).map((x) => x.name);
    assert.ok(mine.every((n) => n.startsWith(c + " ")), c);
    const n = (face: string) => mine.filter((x) => x === `${c} ${face}`).length;
    assert.equal(n("0"), 1);
    for (let d = 1; d <= 9; d++) assert.equal(n(String(d)), 2, `${c} ${d}`);
    for (const a of ["Skip", "Reverse", "Draw Two"]) assert.equal(n(a), 2, `${c} ${a}`);
  });
  assert.deepEqual(CARDS.slice(100).map((c) => c.name), [...Array(4).fill("Wild"), ...Array(4).fill("Wild Draw Four")]);
});

test("values: digits their face, Skip, Reverse and Draw Two 20, both wilds 50", () => {
  for (const c of CARDS) {
    const face = c.name.split(" ").slice(1).join(" ");
    if (/^\d$/.test(face)) assert.equal(c.value, Number(face), c.name);
    else if (c.name.startsWith("Wild")) assert.equal(c.value, 50, c.name);
    else assert.equal(c.value, 20, c.name);
  }
});

test("no card or title is named after the trademarked game", () => {
  for (const n of [DEFINITION.title, ...CARDS.map((c) => c.name)]) assert.ok(!/uno/i.test(n), n);
});

test("count: the points left in each seated hand, empty seats skipped", () => {
  const ix = (name: string) => CARDS.findIndex((c) => c.name === name);
  const args = {
    seats: ["Ann", null, "Bo", "Cy"],
    hands: [
      [ix("Red 7"), ix("Blue 5"), ix("Green Skip")], // 7 + 5 + 20
      [ix("Wild")], // an empty seat's leftovers are not counted
      [],
      [ix("Wild"), ix("Yellow Draw Two"), ix("Yellow 0")], // 50 + 20 + 0
    ],
    piles: [{ name: "Draw", cards: [1, 2, 3] }],
    loose: [4],
  };
  assert.equal(count(args), "Ann 32, Bo 0, Cy 70");
});

test("hq-cards accepts the definition with 64 cards, then the other 44", () => {
  assert.equal(SHEET, "shared/cards.png");
  assert.deepEqual(CELL, [20, 28]);
  assert.equal(BACK, 108);
  assert.equal(DEFINITION.deck.cards.length, 108);
  const first = { ...DEFINITION, deck: { ...DEFINITION.deck, cards: DEFINITION.deck.cards.slice(0, 64) } };
  const r = validateDefinition(first);
  assert.ok(r.ok, r.ok ? "" : r.err);
  const rest = validateCards(DEFINITION.deck.cards.slice(64), 64, 108);
  assert.ok(rest.ok, rest.ok ? "" : rest.err);
  // the hook's 4 KB limit on arguments
  assert.ok(JSON.stringify(first).length < 4096);
  assert.ok(JSON.stringify({ from: 64, cards: DEFINITION.deck.cards.slice(64) }).length < 4096);
});

/** The RGBA pixels of a PNG written by tools/sprite.mjs (8-bit RGBA, filter 0 on every row). */
function decode(buf: Buffer): { w: number; h: number; px: Buffer } {
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  let at = 8, w = 0, h = 0;
  const idat: Buffer[] = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), type = buf.toString("ascii", at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      assert.equal(data[8], 8);
      assert.equal(data[9], 6);
    } else if (type === "IDAT") idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * (1 + w * 4)], 0, "filter 0");
    raw.copy(px, y * w * 4, y * (1 + w * 4) + 1, (y + 1) * (1 + w * 4));
  }
  return { w, h, px };
}

test("the sheet: 109 cells of 20 x 28, 16 per row, all different", () => {
  const { w, h, px } = decode(readFileSync(new URL("../../plugins/bundled/hq-card-lastcard/public/shared/cards.png", import.meta.url)));
  assert.equal(w, 320);
  assert.equal(h, 196);
  const cells = new Set<string>();
  for (let i = 0; i <= BACK; i++) {
    const cx = (i % 16) * 20, cy = Math.floor(i / 16) * 28;
    const rows: string[] = [];
    for (let y = 0; y < 28; y++) rows.push(px.subarray(((cy + y) * w + cx) * 4, ((cy + y) * w + cx + 20) * 4).toString("hex"));
    const cell = rows.join("");
    assert.ok(/[^0]/.test(cell), `frame ${i} is drawn`);
    cells.add(cell);
  }
  assert.equal(cells.size, 109);
});
