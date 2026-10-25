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
  assert.equal(cg.allow.length, 11);
});

// ---- log.ts
import { append, parseLog, sentence, LOG_MAX, type LogEntry } from "../../plugins/bundled/hq-cards/public/log.ts";

const names = ["Ann", "Bo", "Cy"];
const say = (e: LogEntry) => sentence(e, (s) => names[s] ?? "Seat " + (s + 1), (c) => (c === 7 ? "8 of spades" : "card " + c)); // cardName gives "8 of spades", "Red 7"

test("sentence says each action", () => {
  const cases: [LogEntry, string][] = [
    [{ s: 0, v: "chose", text: "Old Maid" }, "Ann chose Old Maid"],
    [{ s: 1, v: "took" }, "Bo took seat 2"],
    [{ s: 0, v: "looked", p: "Discard" }, "Ann looked at Discard"],
    [{ s: 0, v: "reordered", p: "Discard" }, "Ann reordered Discard"],
    [{ s: 1, v: "picked", to: 0 }, "Bo drew a card from Ann's hand"],
    [{ s: 2, v: "placed", c: 7, p: "Pairs" }, "Cy put the 8 of spades on Pairs"],
    [{ s: 2, v: "placed", p: "Stock" }, "Cy put a card on Stock"],
    [{ s: 2, v: "placed", c: 7 }, "Cy put the 8 of spades on the table"],
    [{ s: 2, v: "placed" }, "Cy put a card on the table"],
    [{ s: 2, v: "gave", to: 1 }, "Cy gave a card to Bo"],
    [{ s: 2, v: "took back" }, "Cy took a card back"],
    [{ s: 0, v: "flipped", c: 7 }, "Ann turned the 8 of spades face up"],
    [{ s: 0, v: "flipped" }, "Ann turned a card face down"],
    [{ s: 0, v: "offered", to: 1 }, "Ann offered their hand to Bo"],
    [{ s: 0, v: "withdrew" }, "Ann withdrew the offer"],
    [{ s: 0, v: "dealt", n: 7 }, "Ann dealt 7 cards each"],
    [{ s: 0, v: "dealt" }, "Ann dealt all the cards"],
    [{ s: 0, v: "shuffled", p: "Stock" }, "Ann shuffled Stock"],
    [{ s: 0, v: "gathered" }, "Ann gathered all the cards"],
    [{ s: 0, v: "counted", text: "Bo keeps the jack of spades" }, "Ann counted: Bo keeps the jack of spades"],
    [{ s: 0, v: "created", p: "Tricks" }, "Ann created the pile Tricks"],
    [{ s: 0, v: "removed", p: "Tricks" }, "Ann removed the pile Tricks"],
    [{ s: 1, v: "drew", p: "Stock" }, "Bo drew a card from Stock"],
  ];
  for (const [e, want] of cases) assert.equal(say(e), want);
});

test("append keeps the newest entries under LOG_MAX", () => {
  let log: LogEntry[] = [];
  for (let i = 0; i < 500; i++) log = append(log, { s: i % 3, v: "drew", p: "Pile " + i });
  assert.ok(JSON.stringify(log).length <= LOG_MAX);
  assert.equal(log[log.length - 1].p, "Pile 499");
  assert.ok(log.length > 20, "a useful history: " + log.length);
});

test("parseLog survives broken storage", () => {
  assert.deepEqual(parseLog(null), []);
  assert.deepEqual(parseLog("{"), []);
  assert.deepEqual(parseLog('{"a":1}'), []);
  assert.deepEqual(parseLog('[{"s":0,"v":"drew","p":"Stock"},{"s":"x"}]'), [{ s: 0, v: "drew", p: "Stock" }]);
});

// ---- table.ts
import {
  UP, TABLE_MAX, newTable, parseTable, choose, seatOf, take, place, flip, order, offer, pick, dealAll, deal, shuffle, gather,
  createPile, removePile, reorderPile, draw, counted, defaultCount, canReset, reset, encodedSize, type Table,
} from "../../plugins/bundled/hq-cards/public/table.ts";

function lcg(seed = 7) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}
const ANN = { id: 1, name: "Ann" }, BO = { id: 2, name: "Bo" }, CY = { id: 3, name: "Cy" };
function free3(): Table {
  const t = newTable();
  choose(t, FREE, lcg());
  for (const [i, who] of [ANN, BO, CY].entries()) assert.equal(take(t, i, who).ok, true);
  return t;
}
const stock = (t: Table) => t.piles[0];
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
const all = (t: Table) => sorted([...t.hands.flat(), ...t.piles.flatMap((p) => p.cards.map((c) => c & ~UP)), ...t.loose.map((l) => l.c & ~UP)]);
const deck54 = Array.from({ length: 54 }, (_, i) => i);

test("choose sets up the free table", () => {
  const t = newTable();
  assert.equal(t.game, null);
  choose(t, FREE, lcg());
  assert.equal(t.game, "free");
  assert.equal(t.seats.length, 8);
  assert.ok(t.seats.every((s) => s === null));
  assert.equal(stock(t).name, "Stock");
  assert.equal(stock(t).face, "down");
  assert.equal(stock(t).cards.length, 54);
  assert.ok(stock(t).cards.every((c) => c < UP), "face down");
  assert.deepEqual(all(t), deck54);
  assert.notDeepEqual(stock(t).cards, deck54, "shuffled");
});

test("take: one seat per member, a taken or missing seat refused", () => {
  const t = newTable();
  assert.equal(take(t, 0, ANN).ok, false, "no game yet");
  choose(t, FREE, lcg());
  assert.equal(take(t, 0, ANN).ok, true);
  assert.equal(take(t, 0, BO).ok, false);
  assert.equal(take(t, 1, ANN).ok, false);
  assert.equal(take(t, 8, BO).ok, false);
  assert.equal(take(t, -1, BO).ok, false);
  assert.equal(take(t, 1.5, BO).ok, false);
  assert.equal(seatOf(t, 1), 0);
  assert.equal(seatOf(t, 2), null);
});

test("dealAll deals round the seats after the dealer", () => {
  const t = free3();
  const r = dealAll(t, 0, "p0", FREE);
  assert.equal(r.ok, true);
  assert.deepEqual(t.hands.slice(0, 3).map((h) => h.length), [18, 18, 18]);
  assert.equal(stock(t).cards.length, 0);
  assert.deepEqual(all(t), deck54);
  if (r.ok) assert.deepEqual(r.log, { s: 0, v: "dealt" });

  const t2 = free3();
  const top = stock(t2).cards.at(-1);
  stock(t2).cards.splice(0, 52); // two cards left
  assert.equal(dealAll(t2, 0, "p0", FREE).ok, true);
  assert.deepEqual(t2.hands.slice(0, 3).map((h) => h.length), [0, 1, 1]);
  assert.equal(t2.hands[1][0], top, "the first card goes to the seat after the dealer");

  const t3 = newTable();
  choose(t3, FREE, lcg());
  assert.equal(dealAll(t3, 0, "p0", FREE).ok, false, "nobody seated");
  assert.equal(dealAll(free3(), 5, "p0", FREE).ok, false, "an empty seat cannot deal");
  assert.equal(dealAll(free3(), null, "p0", FREE).ok, false, "a spectator cannot deal");
  assert.equal(dealAll(free3(), 0, "nope", FREE).ok, false);
});

test("deal N stops when the pile runs out", () => {
  const t = free3();
  stock(t).cards.splice(0, 44); // ten left
  const r = deal(t, 0, "p0", 4, FREE);
  assert.equal(r.ok, true);
  assert.deepEqual(t.hands.slice(0, 3).map((h) => h.length), [3, 4, 3]);
  if (r.ok) assert.deepEqual(r.log, { s: 0, v: "dealt", n: 4 });
  assert.equal(deal(free3(), 0, "p0", 0, FREE).ok, false);
  assert.equal(deal(free3(), 0, "p0", 53, FREE).ok, false);
  assert.equal(deal(free3(), 0, "p0", 2.5, FREE).ok, false);
});

test("place moves a card between hands, the felt and piles", () => {
  const t = free3();
  deal(t, 0, "p0", 5, FREE);
  const mine = t.hands[0][0];
  let r = place(t, 0, { k: "hand", i: 0 }, { k: "felt", at: [40, 50] }, true, FREE);
  assert.equal(r.ok, true);
  assert.deepEqual(t.loose, [{ c: mine | UP, at: [40, 50] }]);
  if (r.ok) assert.deepEqual(r.log, { s: 0, v: "placed", c: mine });
  assert.equal(t.hands[0].length, 4);

  r = place(t, 1, { k: "loose", c: mine }, { k: "pile", id: "p0" }, false, FREE);
  assert.equal(r.ok, true, "anybody seated moves a loose card");
  assert.equal(stock(t).cards.at(-1), mine);
  assert.deepEqual(t.loose, []);
  if (r.ok) assert.deepEqual(r.log, { s: 1, v: "placed", p: "Stock" });

  r = place(t, 2, { k: "pile", id: "p0" }, { k: "hand", seat: 1 }, false, FREE);
  assert.equal(r.ok, true);
  assert.equal(t.hands[1].at(-1), mine);
  if (r.ok) assert.deepEqual(r.log, { s: 2, v: "gave", to: 1 });

  const bo = t.hands[1][0];
  r = place(t, 1, { k: "hand", i: 0 }, { k: "hand", seat: 2 }, false, FREE);
  assert.equal(r.ok, true);
  assert.equal(t.hands[2].at(-1), bo);

  assert.equal(place(t, 0, { k: "pile", id: "p0" }, { k: "hand", seat: 0 }, false, FREE).ok, false, "that is draw");
  assert.equal(place(t, 0, { k: "hand", i: 99 }, { k: "felt", at: [1, 1] }, true, FREE).ok, false, "not in my hand");
  assert.equal(place(t, null, { k: "pile", id: "p0" }, { k: "felt", at: [1, 1] }, true, FREE).ok, false, "a spectator");
  assert.equal(place(t, 0, { k: "hand", i: 0 }, { k: "felt", at: [999, 1] }, true, FREE).ok, false, "off the felt");
  assert.equal(place(t, 0, { k: "hand", i: 0 }, { k: "hand", seat: 0 }, true, FREE).ok, false, "my hand into my hand");
  assert.equal(place(t, 0, { k: "hand", i: 0 }, { k: "hand", seat: 5 }, true, FREE).ok, false, "an empty seat");
  assert.equal(place(t, 0, { k: "pile", id: "p0" }, { k: "pile", id: "p0" }, true, FREE).ok, false, "onto its own pile");
  assert.equal(place(t, 0, { k: "hand", i: 0 }, { k: "felt", at: [1, 1] }, true, { ...FREE, allow: ["draw"] }).ok, false, "not allowed");
});

test("a loose card moved twice at once: the second is refused once it is gone", () => {
  const t = free3();
  deal(t, 0, "p0", 1, FREE);
  const c = t.hands[0][0];
  place(t, 0, { k: "hand", i: 0 }, { k: "felt", at: [10, 10] }, true, FREE);
  assert.equal(place(t, 1, { k: "loose", c }, { k: "felt", at: [20, 20] }, true, FREE).ok, true);
  place(t, 1, { k: "loose", c }, { k: "hand", seat: 1 }, false, FREE);
  assert.equal(place(t, 2, { k: "loose", c }, { k: "felt", at: [30, 30] }, true, FREE).ok, false, "gone from the felt");
  assert.equal(t.hands[1].at(-1), c);
});

test("a loose card goes back into my hand", () => {
  const t = free3();
  deal(t, 0, "p0", 1, FREE);
  const c = t.hands[0][0];
  place(t, 0, { k: "hand", i: 0 }, { k: "felt", at: [10, 10] }, false, FREE);
  const r = place(t, 0, { k: "loose", c }, { k: "hand", seat: 0 }, false, FREE);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.log, { s: 0, v: "took back" });
  assert.deepEqual(t.hands[0], [c]);
});

test("flip turns a loose card or a pile's top over", () => {
  const t = free3();
  const top = stock(t).cards.at(-1)!;
  let r = flip(t, 0, { k: "pile", id: "p0" }, FREE);
  assert.equal(r.ok, true);
  assert.equal(stock(t).cards.at(-1), top | UP);
  if (r.ok) assert.deepEqual(r.log, { s: 0, v: "flipped", c: top });
  r = flip(t, 0, { k: "pile", id: "p0" }, FREE);
  if (r.ok) assert.deepEqual(r.log, { s: 0, v: "flipped" });
  assert.equal(stock(t).cards.at(-1), top);
  assert.equal(flip(t, 0, { k: "hand", i: 0 }, FREE).ok, false);
});

test("order rearranges my hand with the same cards, unlogged", () => {
  const t = free3();
  deal(t, 0, "p0", 3, FREE);
  const h = [...t.hands[0]];
  assert.deepEqual(order(t, 0, [h[2], h[0], h[1]]), { ok: true });
  assert.deepEqual(t.hands[0], [h[2], h[0], h[1]]);
  assert.equal(order(t, 0, [h[0], h[0], h[1]]).ok, false);
  assert.equal(order(t, 0, [h[0], h[1]]).ok, false);
  assert.equal(order(t, null, h).ok, false);
});

test("offer and pick", () => {
  const t = free3();
  deal(t, 0, "p0", 4, FREE);
  assert.equal(offer(t, 0, 0, FREE).ok, false, "to myself");
  assert.equal(offer(t, 0, 5, FREE).ok, false, "to an empty seat");
  let r = offer(t, 0, 1, FREE);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.log, { s: 0, v: "offered", to: 1 });
  assert.deepEqual(t.offer, { from: 0, to: 1 });
  assert.equal(pick(t, 2, 0, FREE).ok, false, "only the one offered");
  assert.equal(pick(t, 1, 9, FREE).ok, false);
  const third = t.hands[0][2];
  r = pick(t, 1, 2, FREE);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.log, { s: 1, v: "picked", to: 0 });
  assert.equal(t.hands[1].at(-1), third);
  assert.equal(t.hands[0].length, 3);
  assert.equal(t.offer, null);

  offer(t, 0, 1, FREE);
  r = offer(t, 0, null, FREE);
  if (r.ok) assert.deepEqual(r.log, { s: 0, v: "withdrew" });
  assert.equal(pick(t, 1, 0, FREE).ok, false, "withdrawn");
  assert.equal(offer(t, 0, null, FREE).ok, false, "nothing to withdraw");
  assert.equal(offer(t, 0, 1, { ...FREE, allow: ["place"] }).ok, false);
});

test("gather puts every card back face down and removes the players' piles", () => {
  const t = free3();
  dealAll(t, 0, "p0", FREE);
  createPile(t, 1, "Tricks", "down", [20, 20], FREE);
  place(t, 0, { k: "hand", i: 0 }, { k: "pile", id: "p1" }, true, FREE);
  place(t, 0, { k: "hand", i: 0 }, { k: "felt", at: [5, 5] }, true, FREE);
  offer(t, 0, 1, FREE);
  assert.equal(gather(t, 2, FREE).ok, true);
  assert.equal(t.piles.length, 1);
  assert.equal(stock(t).cards.length, 54);
  assert.ok(stock(t).cards.every((c) => c < UP));
  assert.deepEqual(t.loose, []);
  assert.ok(t.hands.every((h) => h.length === 0));
  assert.equal(t.offer, null);
});

test("createPile and removePile", () => {
  const t = free3();
  let r = createPile(t, 0, "Discard", "up", [100, 100], FREE);
  assert.equal(r.ok, true);
  assert.equal(t.piles[1].id, "p1");
  assert.equal(t.piles[1].mine, true);
  if (r.ok) assert.deepEqual(r.log, { s: 0, v: "created", p: "Discard" });
  assert.equal(createPile(t, 0, "x".repeat(17), "up", [1, 1], FREE).ok, false);
  assert.equal(createPile(t, 0, " ", "up", [1, 1], FREE).ok, false);
  assert.equal(createPile(t, 0, "A", "sideways" as "up", [1, 1], FREE).ok, false);
  for (let i = 2; i < 16; i++) assert.equal(createPile(t, 0, "P" + i, "up", [1, 1], FREE).ok, true);
  assert.equal(createPile(t, 0, "P16", "up", [1, 1], FREE).ok, false, "16 piles at most");
  assert.equal(removePile(t, 0, "p0", FREE).ok, false, "the stock stays");
  place(t, 0, { k: "pile", id: "p0" }, { k: "pile", id: "p1" }, true, FREE);
  assert.equal(removePile(t, 0, "p1", FREE).ok, true, "a pile with cards goes, its cards back to the stock");
  assert.equal(t.piles[0].cards.length, 54);
  r = removePile(t, 1, "p2", FREE);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.log, { s: 1, v: "removed", p: "P2" });
});

test("draw and reorderPile", () => {
  const t = free3();
  const top = stock(t).cards.at(-1);
  let r = draw(t, 1, "p0", FREE);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.log, { s: 1, v: "drew", p: "Stock" });
  assert.deepEqual(t.hands[1], [top]);
  const before = [...stock(t).cards];
  const turned = [...before].reverse();
  r = reorderPile(t, 0, "p0", turned, FREE);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.log, { s: 0, v: "reordered", p: "Stock" });
  assert.deepEqual(stock(t).cards, turned);
  assert.equal(reorderPile(t, 0, "p0", [...turned.slice(1), turned[1]], FREE).ok, false, "other cards");
  const onlyPlace = { ...FREE, allow: ["place" as const] };
  assert.equal(draw(t, 1, "p0", onlyPlace).ok, false);
  assert.equal(reorderPile(t, 0, "p0", before, onlyPlace).ok, false);
  const empty = free3();
  empty.piles[0].cards = [];
  assert.equal(draw(empty, 0, "p0", FREE).ok, false);
});

test("shuffle: an empty pile is a no-op without a log entry", () => {
  const t = free3();
  const before = [...stock(t).cards];
  const r = shuffle(t, 0, "p0", FREE, lcg(3));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.log, { s: 0, v: "shuffled", p: "Stock" });
  assert.notDeepEqual(stock(t).cards, before);
  assert.deepEqual(sorted(stock(t).cards), sorted(before));
  stock(t).cards = [];
  assert.deepEqual(shuffle(t, 0, "p0", FREE), { ok: true });
});

test("counted keeps the text, cut to 200 characters, and logs it", () => {
  const t = free3();
  const r = counted(t, 0, "x".repeat(300), FREE);
  assert.equal(t.count.length, 200);
  if (r.ok) assert.equal(r.log?.v, "counted");
  assert.equal(counted(t, 0, "n", { ...FREE, allow: ["place"] }).ok, false);
});

test("defaultCount", () => {
  const t = free3();
  deal(t, 0, "p0", 5, FREE);
  createPile(t, 0, "Pairs", "up", [1, 1], FREE);
  place(t, 0, { k: "hand", i: 0 }, { k: "felt", at: [1, 1] }, true, FREE);
  assert.equal(defaultCount(t), "Ann 4, Bo 5, Cy 5 · Stock 39, Pairs 0 · 1 on the table");
});

test("the worst case stays under TABLE_MAX, and an action that would not fit is refused", () => {
  const def = validateDefinition(custom(108, 108));
  assert.ok(def.ok);
  if (!def.ok) return;
  const g: Game = { ...def.def, name: "big", complete: true };
  const t = newTable();
  choose(t, g, lcg());
  for (let i = 0; i < 8; i++) take(t, i, { id: 100 + i, name: "N".repeat(24) });
  for (let i = 1; i < 16; i++) createPile(t, 0, "x".repeat(16), "up", [319, 179], g);
  deal(t, 0, "p0", 5, g);
  let i = 0;
  while (t.piles[0].cards.length) {
    const to = i % 3 ? { k: "pile" as const, id: "p" + (1 + (i % 15)) } : { k: "felt" as const, at: [300 + (i % 19), 170 + (i % 9)] as [number, number] };
    if (!place(t, 0, { k: "pile", id: "p0" }, to, true, g).ok) break;
    i++;
  }
  assert.ok(encodedSize(t) <= TABLE_MAX, "size " + encodedSize(t));
  if (t.piles[0].cards.length) {
    const snapshot = JSON.stringify(t);
    assert.equal(place(t, 0, { k: "pile", id: "p0" }, { k: "felt", at: [301, 171] }, true, g).ok, false);
    assert.equal(JSON.stringify(t), snapshot, "a refused action changes nothing");
  }
});

test("malformed sources and destinations are refused without throwing", () => {
  const t = free3();
  deal(t, 0, "p0", 2, FREE);
  const snapshot = JSON.stringify(t);
  const bad: [unknown, unknown][] = [
    [{ k: "hand", i: 0 }, { k: "zzz" }],
    [{ k: "zzz" }, { k: "felt", at: [1, 1] }],
    [{ k: "hand", i: 0 }, null],
    [null, { k: "felt", at: [1, 1] }],
    [{ k: "hand", i: "0" }, { k: "felt", at: [1, 1] }],
    [{ k: "hand", i: 0 }, { k: "felt", at: "1,1" }],
    [{ k: "hand", i: 0 }, { k: "pile", id: 5 }],
    [{ k: "hand", i: 0 }, { k: "hand", seat: "1" }],
  ];
  for (const [from, to] of bad) assert.equal(place(t, 0, from as never, to as never, true, FREE).ok, false, JSON.stringify([from, to]));
  assert.equal(flip(t, 0, { k: "zzz" } as never, FREE).ok, false);
  assert.equal(flip(t, 0, null as never, FREE).ok, false);
  assert.equal(order(t, 0, "x" as never).ok, false);
  assert.equal(JSON.stringify(t), snapshot);
});

test("a table at TABLE_MAX still fits a 4 KB state message with 8 seats here and looking", () => {
  const room = 4096 - TABLE_MAX;
  const extra = JSON.stringify({ t: "state", x: 99999, y: 99999, s: { t: null, here: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => 2 ** 31 + i), looking: Array.from({ length: 8 }, (_, i) => ({ seat: i, pile: "p15" })), unavailable: false } });
  assert.ok(extra.length < room, `the wrapping takes ${extra.length} bytes, TABLE_MAX leaves ${room}`);
});

// ---- art.ts and layout.ts
import { CARD_W, CARD_H, PALETTE, paintCard, paintBack } from "../../plugins/bundled/hq-cards/public/art.ts";
import { FELT_W, FELT_H, VIEW_W, VIEW_H, FX, FY, seatSpots, handSpots, cardAt, hit } from "../../plugins/bundled/hq-cards/public/layout.ts";

function picture(paint: (set: (x: number, y: number, hex: string) => void) => void): { key: string; outside: number; colours: Set<string> } {
  const px: string[] = Array(CARD_W * CARD_H).fill(".");
  let outside = 0;
  const colours = new Set<string>();
  paint((x, y, hex) => {
    if (x < 0 || y < 0 || x >= CARD_W || y >= CARD_H || !Number.isInteger(x) || !Number.isInteger(y)) return void outside++;
    px[y * CARD_W + x] = hex;
    colours.add(hex);
  });
  return { key: px.join(","), outside, colours };
}

test("every standard card paints a distinct picture in the palette, inside its cell", () => {
  const keys = new Set<string>();
  for (const code of STANDARD) {
    const p = picture((set) => paintCard(code, set));
    assert.equal(p.outside, 0, code);
    for (const c of p.colours) assert.ok(PALETTE.includes(c), `${code}: ${c} not in the palette`);
    assert.ok(p.colours.has("#1a1526"), code + " has the outline");
    keys.add(p.key);
  }
  assert.equal(keys.size, 54);
  const back = picture(paintBack);
  assert.equal(back.outside, 0);
  assert.ok(!keys.has(back.key));
  for (const c of back.colours) assert.ok(PALETTE.includes(c), "back: " + c);
});

test("seatSpots puts everybody but me around the felt, never on it", () => {
  for (const [n, me, want] of [[8, 0, 7], [4, null, 4], [2, 1, 1], [3, 0, 2]] as const) {
    const spots = seatSpots(n, me);
    assert.equal(spots.length, want, `${n} seats, me ${me}`);
    assert.ok(!spots.some((s) => s.seat === me));
    for (const s of spots) {
      assert.ok(s.x >= 0 && s.x <= VIEW_W && s.y >= 0 && s.y <= VIEW_H, JSON.stringify(s));
      const onFelt = s.x > FX && s.x < FX + FELT_W && s.y > FY && s.y < FY + FELT_H;
      assert.ok(!onFelt, "on the felt: " + JSON.stringify(s));
    }
  }
  // clockwise from my left: seat 1 is on my left when I sit at 0 of 8
  assert.equal(seatSpots(8, 0)[0].seat, 1);
  assert.equal(seatSpots(8, 0)[0].side, "left");
});

test("hit finds the topmost thing under a point", () => {
  const t = free3();
  deal(t, 0, "p0", 3, FREE);
  const top = stock(t).cards.at(-1)!;
  // loose cards are drawn over piles: a loose card on the stock is what a click there takes
  place(t, 0, { k: "hand", i: 0 }, { k: "felt", at: [...t.piles[0].at] as [number, number] }, true, FREE);
  const pc = cardAt(t.piles[0].at);
  assert.deepEqual(hit(t, 0, pc.x + 2, pc.y + 2), { k: "loose", c: t.loose[0].c & ~UP });
  place(t, 0, { k: "loose", c: t.loose[0].c & ~UP }, { k: "felt", at: [20, 20] }, true, FREE);
  assert.deepEqual(hit(t, 0, pc.x + 2, pc.y + 2), { k: "pile", id: "p0" });
  assert.notEqual(top, undefined);
  const h = handSpots(t.hands[0].length);
  assert.deepEqual(hit(t, 0, h[1].x + 2, h[1].y + 10), { k: "hand", i: 1 });
  assert.deepEqual(hit(t, null, h[1].x + 2, h[1].y + 10), null, "a spectator has no hand");
  const bo = seatSpots(t.seats.length, 0).find((s) => s.seat === 1)!;
  assert.deepEqual(hit(t, 0, bo.x, bo.y), { k: "seat", seat: 1 });
  assert.deepEqual(hit(t, 0, FX + 300, FY + 170), { k: "felt", at: [300, 170] });
});

test("canReset mirrors chess, and reset clears the table", () => {
  const t = free3();
  assert.equal(canReset(t, 1, new Set([1, 9])), true, "a present seated player");
  assert.equal(canReset(t, 9, new Set([1, 9])), false, "a spectator while a seated player is here");
  assert.equal(canReset(t, 9, new Set([9])), true, "nobody seated is here");
  reset(t);
  assert.deepEqual(t, newTable());
});

test("parseTable survives broken storage", () => {
  assert.deepEqual(parseTable(null), newTable());
  assert.deepEqual(parseTable("{"), newTable());
  assert.deepEqual(parseTable('{"game":3}'), newTable());
  const t = free3();
  assert.deepEqual(parseTable(JSON.stringify(t)), t);
});

// ---- sizes are UTF-8 bytes (the 4 KB limits of messages and hq.kv are bytes)
import { utf8Bytes } from "../../plugins/bundled/hq-cards/public/games.ts";

test("utf8Bytes counts what JSON sends", () => {
  assert.equal(utf8Bytes("abc"), 3);
  assert.equal(utf8Bytes("é"), 2);
  assert.equal(utf8Bytes("牌"), 3);
  assert.equal(utf8Bytes("😀"), 4);
  assert.equal(utf8Bytes(JSON.stringify({ n: "牌牌" })), Buffer.byteLength(JSON.stringify({ n: "牌牌" })));
});

test("a table of wide names is measured in bytes: seats and piles that would not fit are refused", () => {
  const t = newTable();
  choose(t, FREE, lcg());
  for (let i = 0; i < 8; i++) take(t, i, { id: 100 + i, name: "牌".repeat(24) });
  let piles = 0;
  for (let i = 1; i < 16; i++) if (createPile(t, 0, "牌".repeat(16), "up", [300, 170], FREE).ok) piles++;
  for (let i = 0; i < 54; i++) place(t, i % 8, { k: "pile", id: "p0" }, { k: "felt", at: [100 + i, 100 + (i % 50)] }, true, FREE);
  assert.ok(encodedSize(t) <= TABLE_MAX, "bytes " + encodedSize(t));
  assert.equal(encodedSize(t), Buffer.byteLength(JSON.stringify(t)));
});

test("take is refused when the seat's name would not fit", () => {
  const t = newTable();
  choose(t, FREE, lcg());
  for (let i = 1; i < 16; i++) createPile(t, 0, "牌".repeat(16), "up", [300, 170], FREE); // no seat yet: refused, nobody seated
  for (let i = 0; i < 8; i++) take(t, i, { id: 100 + i, name: "牌".repeat(24) });
  for (let i = 1; i < 16; i++) createPile(t, 0, "牌".repeat(16), "up", [300, 170], FREE);
  for (let i = 0; i < 54; i++) if (!place(t, i % 8, { k: "pile", id: "p0" }, { k: "felt", at: [100 + i, 100] }, true, FREE).ok) break;
  const t2 = parseTable(JSON.stringify(t));
  t2.seats[7] = null;
  t2.hands[7] = [];
  const room = TABLE_MAX - encodedSize(t2);
  const name = "牌".repeat(Math.ceil(room / 3) + 30).slice(0, 24); // 72 bytes: over when the table is that full
  if (room < 80) assert.equal(take(t2, 7, { id: 999, name }).ok, false);
  assert.ok(encodedSize(t2) <= TABLE_MAX);
});

test("the log is bounded in bytes", () => {
  let log: LogEntry[] = [];
  for (let i = 0; i < 300; i++) log = append(log, { s: 0, v: "counted", text: "牌".repeat(60) });
  assert.ok(Buffer.byteLength(JSON.stringify(log)) <= LOG_MAX, String(Buffer.byteLength(JSON.stringify(log))));
});

test("a deck whose wide names would not fit a page's message is refused", () => {
  const r = validateDefinition(custom(100, 40, () => "漢".repeat(24)));
  assert.equal(r.ok, false);
});

// ---- labels.ts: the window's labels stay within the 40 characters of a button, whatever the names
import { labels, LABEL_MAX } from "../../plugins/bundled/hq-cards/public/labels.ts";

test("every window label fits 40 characters with the longest names", () => {
  const name = "Bartholomew Featherstone"; // 24, the longest display name
  const pile = "x".repeat(16);
  const all = [
    labels.seat(7, name, true), labels.seat(7, name, false), labels.freeSeat(7),
    labels.offer(name), labels.withdraw(name), labels.shuffle(pile), labels.deal(52),
  ];
  for (const l of all) assert.ok(l.length >= 1 && l.length <= LABEL_MAX, `${l.length}: ${l}`);
  assert.equal(labels.offer("Bo"), "Offer my hand to Bo");
  assert.ok(labels.withdraw(name).endsWith("…"));
});

// ---- the narrow layout (phones): no side columns, the other seats in rows on top, my hand drawn larger
import { WIDE, NARROW, layoutFor } from "../../plugins/bundled/hq-cards/public/layout.ts";

test("layoutFor picks the narrow layout when the wide one would be drawn under 1x", () => {
  assert.equal(layoutFor(416 + 20), WIDE);
  assert.equal(layoutFor(800), WIDE);
  assert.equal(layoutFor(300), NARROW);
  assert.equal(NARROW.w, FELT_W, "the whole felt, nothing beside it");
});

test("narrow seatSpots: everybody but me in rows above the felt, inside the view, apart", () => {
  const spots = seatSpots(8, 3, NARROW);
  assert.equal(spots.length, 7);
  for (const s of spots) {
    assert.ok(s.x - NARROW.seatW / 2 >= 0 && s.x + NARROW.seatW / 2 <= NARROW.w, JSON.stringify(s));
    assert.ok(s.y + NARROW.seatH / 2 <= NARROW.fy, "above the felt: " + JSON.stringify(s));
  }
  for (const a of spots) for (const b of spots) if (a !== b) assert.ok(Math.abs(a.x - b.x) >= NARROW.seatW || Math.abs(a.y - b.y) >= NARROW.seatH, "overlap " + JSON.stringify([a, b]));
});

test("narrow hand: larger cards, all inside the view, and hit finds them", () => {
  const h = handSpots(12, NARROW);
  const w = CARD_W * NARROW.handK;
  assert.ok(w >= 26, "a hand card is at least 26 view px wide: " + w);
  for (const p of h) assert.ok(p.x >= 0 && p.x + w <= NARROW.w && p.y + CARD_H * NARROW.handK <= NARROW.h, JSON.stringify(p));
  const t = free3();
  deal(t, 0, "p0", 5, FREE);
  const s = handSpots(5, NARROW);
  assert.deepEqual(hit(t, 0, s[4].x + w - 2, s[4].y + 2, NARROW), { k: "hand", i: 4 }, "the right edge of the last, larger card");
  const pile = cardAt(t.piles[0].at, NARROW);
  assert.deepEqual(hit(t, 0, pile.x + 2, pile.y + 2, NARROW), { k: "pile", id: "p0" });
});

// ---- round 2: snapping setting, moving groups and piles, removing any pile, setting cards aside
import { setSnap, moveCards, movePile, setAside } from "../../plugins/bundled/hq-cards/public/table.ts";

test("a new game snaps; any seated player turns it off and on, logged", () => {
  const t = free3();
  assert.equal(t.snap, true);
  let r = setSnap(t, 1, false);
  assert.deepEqual(r, { ok: true, log: { s: 1, v: "snap", n: 0 } });
  assert.equal(t.snap, false);
  r = setSnap(t, 0, true);
  if (r.ok) assert.equal(r.log?.n, 1);
  assert.equal(setSnap(t, null, false).ok, false, "a spectator");
  assert.equal(sentence({ s: 1, v: "snap", n: 0 }, (s) => names[s], String), "Bo turned snapping off");
});

test("moveCards moves loose cards together, on top, in their order", () => {
  const t = free3();
  deal(t, 0, "p0", 3, FREE);
  for (let i = 0; i < 3; i++) place(t, 0, { k: "hand", i: 0 }, { k: "felt", at: [40 + i, 40 + 13 * i] }, true, FREE);
  place(t, 0, { k: "pile", id: "p0" }, { k: "felt", at: [200, 100] }, true, FREE); // another card, put down last
  const [a, b, c] = t.loose.slice(0, 3).map((l) => l.c & ~UP);
  const r = moveCards(t, 1, [a, b, c], 100, 20, FREE);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.log, { s: 1, v: "moved", n: 3 });
  assert.deepEqual(t.loose.slice(-3).map((l) => [l.c & ~UP, l.at]), [[a, [140, 60]], [b, [141, 73]], [c, [142, 86]]]);
  assert.equal(moveCards(t, 1, [a, 999], 1, 1, FREE).ok, false, "a card not on the felt");
  assert.equal(moveCards(t, 1, [a, a], 1, 1, FREE).ok, false, "twice");
  assert.equal(moveCards(t, 1, [a], 1000, 0, FREE).ok, false, "off the felt");
  assert.equal(moveCards(t, 1, [], 1, 1, FREE).ok, false);
  assert.equal(moveCards(t, null, [a], 1, 1, FREE).ok, false);
  assert.equal(moveCards(t, 1, [a], 1, 1, { ...FREE, allow: ["draw"] }).ok, false);
});

test("movePile moves a pile; removePile removes any pile but the stock, its cards back to the stock", () => {
  const g: Game = { ...FREE, piles: [{ name: "Stock", face: "down", at: [160, 90] }, { name: "Discard", face: "up", at: [200, 90] }] };
  const t = newTable();
  choose(t, g, lcg());
  take(t, 0, ANN);
  place(t, 0, { k: "pile", id: "p0" }, { k: "pile", id: "p1" }, true, g);
  let r = movePile(t, 0, "p1", [20, 30], g);
  assert.deepEqual(r, { ok: true, log: { s: 0, v: "moved pile", p: "Discard" } });
  assert.deepEqual(t.piles[1].at, [20, 30]);
  assert.equal(movePile(t, 0, "p1", [999, 0], g).ok, false);
  r = removePile(t, 0, "p1", g);
  assert.equal(r.ok, true, "a game's pile, not empty");
  assert.equal(t.piles.length, 1);
  assert.equal(t.piles[0].cards.length, 54);
  assert.ok(t.piles[0].cards.every((c) => c < UP), "back face down");
  assert.equal(removePile(t, 0, "p0", g).ok, false, "never the stock");
});

test("setAside takes a card out of the game until a reset; gather leaves it out", () => {
  const t = free3();
  deal(t, 0, "p0", 2, FREE);
  const mine = t.hands[0][0];
  let r = setAside(t, 0, { k: "hand", i: 0 }, FREE);
  assert.deepEqual(r, { ok: true, log: { s: 0, v: "set aside", c: mine } });
  assert.deepEqual(t.out, [mine]);
  const top = t.piles[0].cards.at(-1)!;
  setAside(t, 1, { k: "pile", id: "p0" }, FREE);
  assert.equal(t.out.length, 2);
  assert.ok(t.out.includes(top & ~UP));
  assert.equal(setAside(t, 0, { k: "hand", i: 0 }, { ...FREE, allow: ["place"] }).ok, false, "not allowed");
  gather(t, 0, FREE);
  assert.equal(t.piles[0].cards.length, 52, "gather leaves them out");
  assert.equal(t.out.length, 2);
  assert.match(defaultCount(t), /2 set aside/);
  reset(t);
  choose(t, FREE, lcg());
  assert.equal(t.piles[0].cards.length, 54, "a new game starts from the whole deck");
  assert.deepEqual(t.out, []);
  assert.equal(sentence({ s: 0, v: "set aside", c: 7 }, (s) => names[s], () => "8 of spades"), "Ann set the 8 of spades aside");
  assert.equal(sentence({ s: 0, v: "moved", n: 3 }, (s) => names[s], String), "Ann moved 3 cards");
  assert.equal(sentence({ s: 0, v: "moved pile", p: "Discard" }, (s) => names[s], String), "Ann moved the pile Discard");
});

// ---- round 2: snapping and groups (layout.ts)
import { snapAt, groupFrom, groups, GRID, CASCADE } from "../../plugins/bundled/hq-cards/public/layout.ts";

function feltOf(at: [number, number][]): Table {
  const t = free3();
  deal(t, 0, "p0", at.length, FREE);
  for (const p of at) place(t, 0, { k: "hand", i: 0 }, { k: "felt", at: p }, true, FREE);
  return t;
}

test("snapAt: off, where dropped; on, the nearest grid point inside the felt", () => {
  const t = feltOf([]);
  assert.deepEqual(snapAt(t, [101, 77], [], false), [101, 77]);
  assert.deepEqual(GRID, [24, 32]);
  assert.deepEqual(snapAt(t, [101, 77], [], true), [108, 80]); // centres at 12 + 24k, 16 + 32k
  assert.deepEqual(snapAt(t, [1, 1], [], true), [12, 16]);
  assert.deepEqual(snapAt(t, [319, 219], [], true), [300, 176], "the last row whose card stays on the felt");
});

test("snapAt over a card: its lower half cascades CASCADE lower, its upper half stacks on it", () => {
  const t = feltOf([[60, 48]]);
  assert.equal(CASCADE, 13);
  assert.deepEqual(snapAt(t, [62, 55], [], true), [60, 61], "lower half: the card under shows its index");
  assert.deepEqual(snapAt(t, [58, 42], [], true), [60, 48], "upper half: exactly on it");
  const c = t.loose[0].c & ~UP;
  assert.deepEqual(snapAt(t, [62, 55], [c], true), [60, 48], "never on a card being moved: the grid");
});

test("groupFrom: a card and the cards put on it; groups: the bottom of each", () => {
  const t = feltOf([[60, 48], [60, 61], [60, 74], [150, 48], [60, 160]]); // a cascade of 3, a lone card, a lone card far below
  const [a, b, c, d, e] = t.loose.map((l) => l.c & ~UP);
  assert.deepEqual(groupFrom(t, a), [a, b, c]);
  assert.deepEqual(groupFrom(t, b), [b, c], "a middle card takes those put on it");
  assert.deepEqual(groupFrom(t, d), [d]);
  assert.deepEqual(groups(t).map((g) => g.c), [a], "only the cascade has a handle");
  void e;
});

// ---- setting aside a whole set of ranks (a 32- or 52-card game from the standard deck)
import { setAsideRanks } from "../../plugins/bundled/hq-cards/public/table.ts";

test("setAsideRanks takes every card of those ranks out of the game, wherever it is", () => {
  const t = free3();
  deal(t, 0, "p0", 3, FREE);
  place(t, 0, { k: "hand", i: 0 }, { k: "felt", at: [40, 40] }, true, FREE);
  const r = setAsideRanks(t, 1, ["2", "3", "4", "5", "6", "X"], FREE);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.log, { s: 1, v: "set aside", n: 22, text: "the 2s, 3s, 4s, 5s, 6s and the jokers" });
  assert.equal(t.out.length, 22);
  const left = [...t.hands.flat(), ...t.piles.flatMap((p) => p.cards), ...t.loose.map((l) => l.c)].map((c) => STANDARD[c & ~UP]);
  assert.equal(left.length, 32);
  assert.ok(left.every((code) => "789TJQKA".includes(code[0])), left.join(" "));
  assert.equal(sentence(r.ok ? r.log! : { s: 0, v: "drew" }, (s) => names[s], String), "Bo set aside the 2s, 3s, 4s, 5s, 6s and the jokers");
  assert.deepEqual(setAsideRanks(t, 1, ["2"], FREE), { ok: true }, "nothing left of those: nothing to log");
  assert.equal(setAsideRanks(t, 1, ["Z"], FREE).ok, false, "not a rank");
  assert.equal(setAsideRanks(t, 1, [], FREE).ok, false);
  assert.equal(setAsideRanks(t, null, ["7"], FREE).ok, false, "a spectator");
  assert.equal(setAsideRanks(t, 1, ["7"], { ...FREE, allow: ["place"] }).ok, false, "not allowed");
  const custom = { ...FREE, deck: { sheet: "shared/c.png", cell: [20, 28] as [number, number], back: 0, total: 2, cards: [{ name: "a" }, { name: "b" }] } };
  assert.equal(setAsideRanks(t, 1, ["7"], custom).ok, false, "a deck of its own has no ranks");
});

// ---- turning a named pile over (the discard pile back into a stock)
import { turnPile } from "../../plugins/bundled/hq-cards/public/table.ts";

test("turnPile turns a whole pile over: its order reversed, every card the other face, the pile's face too", () => {
  const t = free3();
  createPile(t, 0, "Discard", "up", [40, 40], FREE);
  for (let i = 0; i < 3; i++) place(t, 0, { k: "pile", id: "p0" }, { k: "pile", id: "p1" }, true, FREE);
  const before = [...t.piles[1].cards];
  assert.ok(before.every((c) => c & UP));
  const r = turnPile(t, 1, "p1", FREE);
  assert.deepEqual(r, { ok: true, log: { s: 1, v: "turned pile", p: "Discard" } });
  assert.deepEqual(t.piles[1].cards, [...before].reverse().map((c) => c & ~UP));
  assert.equal(t.piles[1].face, "down");
  assert.equal(sentence({ s: 1, v: "turned pile", p: "Discard" }, (s) => names[s], String), "Bo turned the pile Discard over");
  assert.equal(turnPile(t, null, "p1", FREE).ok, false);
  assert.equal(turnPile(t, 1, "nope", FREE).ok, false);
  assert.equal(turnPile(t, 1, "p1", { ...FREE, allow: ["draw"] }).ok, false);
});
