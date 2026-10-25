// hq-card-pouilleux (Old Maid) rules: its deck, its definition as hq-cards validates it, its count. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODES, DEFINITION, count } from "../../plugins/bundled/hq-card-pouilleux/rules.ts";
import { STANDARD, validateDefinition } from "../../plugins/bundled/hq-cards/public/games.ts";

const n = (code: string) => {
  const i = CODES.indexOf(code);
  assert.ok(i >= 0, code + " is in the deck");
  return i;
};

test("the deck is the standard one without three jacks and the jokers", () => {
  assert.equal(CODES.length, 49);
  assert.equal(new Set(CODES).size, 49);
  assert.ok(CODES.includes("JS"));
  for (const j of ["JH", "JD", "JC", "XR", "XB"]) assert.ok(!CODES.includes(j), j + " is not in the deck");
  assert.deepEqual(CODES.filter((c) => c[0] === "J"), ["JS"]);
  for (const c of CODES) assert.ok(STANDARD.includes(c), c + " is a standard code");
  assert.deepEqual(DEFINITION.deck.standard, CODES);
  // in the order of STANDARD
  assert.deepEqual(CODES, STANDARD.filter((c) => CODES.includes(c)));
});

test("hq-cards accepts the definition", () => {
  const r = validateDefinition(DEFINITION);
  assert.ok(r.ok, r.ok ? "" : r.err);
  assert.equal(DEFINITION.title, "Old Maid");
  assert.deepEqual(DEFINITION.seats, [2, 6]);
  assert.deepEqual(DEFINITION.allow, ["place", "offer", "dealAll", "shuffle", "gather", "count"]);
  assert.deepEqual(DEFINITION.piles.map((p) => [p.name, p.face]), [["Stock", "down"], ["Pairs", "up"]]);
  assert.equal(DEFINITION.count, true);
});

const piles = [{ name: "Stock", cards: [] }, { name: "Pairs", cards: [n("2S"), n("2H")] }];

test("count: the cards left in each hand", () => {
  const hands = [[n("AS"), n("JS"), n("3D")], [n("KC"), n("QH")], []];
  assert.equal(count({ seats: ["Ann", "Bo", "Cy"], hands, piles, loose: [] }), "5 cards left: Ann 3, Bo 2, Cy 0");
});

test("count: empty seats are skipped", () => {
  const hands = [[n("AS")], [], [n("KC"), n("QH")], [], []];
  assert.equal(count({ seats: ["Ann", null, "Bo", null, "Cy"], hands, piles, loose: [] }), "3 cards left: Ann 1, Bo 2, Cy 0");
});

test("count: the jack of spades alone names who keeps it", () => {
  assert.equal(count({ seats: ["Ann", "Bo", null], hands: [[], [n("JS")], []], piles, loose: [] }), "Bo keeps the jack of spades");
  // another single card is still a count
  assert.equal(count({ seats: ["Ann", "Bo"], hands: [[], [n("KC")]], piles, loose: [] }), "1 card left: Ann 0, Bo 1");
  // the jack of spades with another card is still a count
  assert.equal(count({ seats: ["Ann", "Bo"], hands: [[n("KC")], [n("JS")]], piles, loose: [] }), "2 cards left: Ann 1, Bo 1");
});

test("count: no card in any hand", () => {
  assert.equal(count({ seats: ["Ann", "Bo"], hands: [[], []], piles, loose: [n("JS")] }), "No cards in hand");
  assert.equal(count({ seats: [], hands: [], piles: [], loose: [] }), "No cards in hand");
});
