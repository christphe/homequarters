// hq-cards: game definitions, the table model, the log, the art and the felt layout. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STANDARD, FREE, CLIENT_GAME_MAX, validateDefinition, validateCards, deckSize, cardName, allows, clientGame, type Game, type GameDefinition,
} from "../../plugins/bundled/hq-cards/public/games.ts";

// ---- games.ts

test("STANDARD has 54 distinct codes and cardName names them", () => {
  assert.equal(STANDARD.length, 54);
  assert.equal(new Set(STANDARD).size, 54);
  const std = { deck: { standard: [...STANDARD] } };
  assert.equal(cardName(std, STANDARD.indexOf("TH")), "10 of hearts");
  assert.equal(cardName(std, STANDARD.indexOf("AS")), "Ace of spades");
  assert.equal(cardName(std, STANDARD.indexOf("QD")), "Queen of diamonds");
  assert.equal(cardName(std, STANDARD.indexOf("XR")), "Red joker");
  assert.equal(cardName(std, STANDARD.indexOf("XB")), "Black joker");
});

const oldMaid = (): GameDefinition => ({
  title: "Old Maid",
  seats: [2, 6],
  allow: ["place", "offer", "dealAll", "shuffle", "gather", "count"],
  deck: { standard: STANDARD.filter((c) => !["JC", "JD", "JH", "XR", "XB"].includes(c)) },
  piles: [{ name: "Stock", face: "down", at: [160, 90] }, { name: "Pairs", face: "up", at: [200, 90] }],
  count: true,
});
const custom = (total: number, n: number, name = (i: number) => "Card " + i): GameDefinition => ({
  title: "Custom",
  seats: [2, 8],
  deck: { sheet: "shared/cards.png", cell: [20, 28], back: total, total, cards: Array.from({ length: n }, (_, i) => ({ name: name(i) })) },
});

test("validateDefinition refuses each broken rule", () => {
  const base = oldMaid();
  const cases: [string, unknown, string][] = [
    ["one seat", { ...base, seats: [1, 4] }, "seats"],
    ["nine seats", { ...base, seats: [2, 9] }, "seats"],
    ["min over max", { ...base, seats: [5, 3] }, "seats"],
    ["empty title", { ...base, title: "" }, "title"],
    ["long title", { ...base, title: "x".repeat(41) }, "title"],
    ["unknown action", { ...base, allow: ["cheat"] }, "allow"],
    ["unknown code", { ...base, deck: { standard: ["ZZ"] } }, "deck"],
    ["duplicate code", { ...base, deck: { standard: ["AS", "AS"] } }, "deck"],
    ["no card", { ...base, deck: { standard: [] } }, "deck"],
    ["too many cards", custom(129, 10), "deck"],
    ["sheet outside shared", { ...custom(10, 10), deck: { ...(custom(10, 10).deck as object), sheet: "cards.png" } }, "sheet"],
    ["sheet climbing out", { ...custom(10, 10), deck: { ...(custom(10, 10).deck as object), sheet: "shared/../x.png" } }, "sheet"],
    ["long card name", custom(10, 10, () => "x".repeat(25)), "name"],
    ["long pile name", { ...base, piles: [{ name: "x".repeat(17), face: "up", at: [0, 0] }] }, "pile"],
    ["17 piles", { ...base, piles: Array.from({ length: 17 }, (_, i) => ({ name: "P" + i, face: "up", at: [0, 0] })) }, "pile"],
    ["count not boolean", { ...base, count: "yes" }, "count"],
    ["not an object", "hello", "definition"],
  ];
  for (const [what, d, word] of cases) {
    const r = validateDefinition(d);
    assert.equal(r.ok, false, what);
    if (!r.ok) assert.match(r.err, new RegExp(word), what + ": " + r.err);
  }
});

test("validateDefinition accepts Old Maid's and a 108-card custom deck sent in parts", () => {
  assert.equal(validateDefinition(oldMaid()).ok, true);
  const r = validateDefinition(custom(108, 64));
  assert.equal(r.ok, true, r.ok ? "" : r.err);
  if (r.ok) assert.equal(deckSize(r.def.deck), 108);
  const more = (n: number) => Array.from({ length: n }, (_, i) => ({ name: "Card " + (64 + i) }));
  assert.equal(validateCards(more(44), 64, 108).ok, true);
  assert.equal(validateCards(more(45), 64, 108).ok, false);
  assert.equal(validateCards(more(10), 63, 108).ok, true, "from is where the next card goes, checked by the caller");
  assert.equal(validateCards([{ name: "" }], 64, 108).ok, false);
});

test("allows: no list allows everything", () => {
  assert.equal(allows(null, "draw"), true);
  assert.equal(allows({}, "draw"), true);
  assert.equal(allows({ allow: ["place"] }, "draw"), false);
  assert.equal(allows({ allow: ["place"] }, "place"), true);
});

test("clientGame of the worst case does not fit, so it is refused", () => {
  const big = validateDefinition(custom(128, 128, () => "x".repeat(24)));
  assert.equal(big.ok, false);
  if (!big.ok) assert.match(big.err, /too big/);
  // refused early, from the first part, when the names sent so far would not fit once all arrive
  assert.equal(validateDefinition(custom(128, 64, () => "x".repeat(24))).ok, false);
  const colours = ["Red", "Yellow", "Green", "Blue"];
  const ok = validateDefinition(custom(108, 108, (i) => colours[i % 4] + " Draw Two"));
  assert.equal(ok.ok, true, ok.ok ? "" : ok.err);
  if (ok.ok) {
    const g: Game = { ...ok.def, name: "hq-card-lastcard", complete: true };
    assert.ok(JSON.stringify(clientGame(g)).length <= CLIENT_GAME_MAX);
  }
});

test("FREE is the free table: a 54-card stock, 2 to 8 seats, everything allowed", () => {
  assert.equal(FREE.name, "free");
  assert.equal(FREE.title, "Free table");
  assert.deepEqual(FREE.seats, [2, 8]);
  assert.equal(deckSize(FREE.deck), 54);
  assert.equal(FREE.piles?.[0].name, "Stock");
  assert.equal(FREE.piles?.[0].face, "down");
  assert.equal(allows(FREE, "viewPile"), true);
  const cg = clientGame(FREE);
  assert.equal(cg.allow.length, 10);
});
