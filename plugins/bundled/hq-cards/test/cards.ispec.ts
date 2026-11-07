// The bundled card table (hq-cards) through the real server (testbed): "use" is X next to a deck on the map,
// a plugin message is what the page's code sends. Run: node --test "plugins/bundled/hq-cards/test/*.ispec.ts"
// (needs bin/homequarters[.exe] or HQ_BIN).
import assert from "node:assert/strict";
import path from "node:path";
import { after, test } from "node:test";
import {
  CARDS, DECK, NAMES, act, cardBed, cardsDir, closeBeds, count, fixture, frames, freeTable, handSizes, lastOf, logVerbs, noErrors, stateAfter, tableOf, until,
  useDeck, waitTable,
} from "./harness.ts";
import type { Frame } from "./harness.ts";

after(closeBeds);

const games = path.resolve(cardsDir, "..");
const key = (prefix: string): string => `${prefix}:${DECK.x},${DECK.y}`;

test("a free table: games listed, seats, the game told, a deal, the log", async () => {
  const { bed, members: [alice, bob] } = await cardBed([cardsDir], NAMES);
  useDeck(alice!);
  const list = (await until("the game list", () => lastOf(alice!, "games")?.list)) as Frame[];
  assert.ok(list.length === 1 && list[0]!.name === "free" && list[0]!.title === "Free table", `a new table offers the free table: ${JSON.stringify(list)}`);
  await freeTable([alice!, bob!]);
  assert.equal(lastOf(alice!, "game")?.g.name, "free", "the page is told the game");
  act(alice!, { t: "dealAll", pile: "p0" });
  for (const p of [alice!, bob!]) {
    const tb = await waitTable(p, `${p.name} sees the deal`, (t) => handSizes(t)[0] === 27);
    assert.deepEqual(handSizes(tb).slice(0, 2), [27, 27]);
  }
  await until("the deal logged", () => logVerbs(bob!).includes("dealt"));
  await noErrors(bed);
});

test("only members with the window open act", async () => {
  const { members: [alice, bob, carol] } = await cardBed([cardsDir], NAMES);
  await freeTable([alice!, bob!]);
  act(carol!, { t: "seat", seat: 2 }); // never opened the deck
  act(bob!, { t: "close" });
  act(bob!, { t: "draw", pile: "p0" }); // window closed
  await carol!.quiet(CARDS, 200); // the messages above are handled, and carol is told nothing
  act(alice!, { t: "draw", pile: "p0" });
  const tb = await waitTable(alice!, "Alice's draw", (t) => handSizes(t)[0] === 1);
  assert.ok(handSizes(tb)[1] === 0 && tb.seats[2] === null, `only members with the window open act: hands ${handSizes(tb)}, seats ${JSON.stringify(tb.seats)}`);
});

test("a card taken twice: the second move is refused", async () => {
  const { members: [alice, bob] } = await cardBed([cardsDir], NAMES);
  await freeTable([alice!, bob!]);
  act(alice!, { t: "flip", from: { k: "pile", id: "p0" } });
  let tb = await waitTable(alice!, "the top turned up", (t) => t.piles[0].cards.at(-1) >= 128);
  const top = tb.piles[0].cards.at(-1) - 128;
  act(alice!, { t: "place", from: { k: "pile", id: "p0" }, to: { k: "felt", at: [10, 10] }, up: true });
  await waitTable(alice!, "the card on the felt", (t) => t.loose.length === 1);
  act(bob!, { t: "place", from: { k: "loose", c: top }, to: { k: "hand", seat: 1 }, up: false });
  await waitTable(alice!, "the card in Bob's hand", (t) => handSizes(t)[1] === 1);
  // the stale move: Alice's, of a card Bob has taken
  tb = (await stateAfter(alice!, { t: "place", from: { k: "loose", c: top }, to: { k: "felt", at: [50, 50] }, up: true })).tb;
  assert.equal(tb.loose.length, 0, `the second move of a card already taken is refused: ${JSON.stringify(tb.loose)}`);
  assert.equal(handSizes(tb)[1], 1);
});

test("the table survives a restart: game, hands and log", async () => {
  const { bed, members: [alice, bob] } = await cardBed([cardsDir], NAMES);
  await freeTable([alice!, bob!]);
  act(alice!, { t: "deal", pile: "p0", n: 5 });
  await waitTable(alice!, "the deal", (t) => handSizes(t)[0] === 5);
  await bed.waitKv(CARDS, (kv) => key("table") in kv && JSON.parse(kv[key("table")]!).hands[0].length === 5 && key("log") in kv);
  await bed.restart();
  await alice!.reconnect();
  const from = count(alice!);
  useDeck(alice!);
  const tb = await waitTable(alice!, "the table after a restart", (t) => t.game === "free", from);
  assert.deepEqual(handSizes(tb).slice(0, 2), [5, 5], "hands kept");
  await until("the log after a restart", () => lastOf(alice!, "log", from)?.log.some((e: Frame) => e.v === "dealt"));
});

test("a member who leaves no longer looks; their offer stays", async () => {
  const { members: [alice, bob] } = await cardBed([cardsDir], NAMES);
  await freeTable([alice!, bob!]);
  act(alice!, { t: "deal", pile: "p0", n: 3 });
  await waitTable(bob!, "the deal", (t) => handSizes(t)[0] === 3);
  act(alice!, { t: "look", pile: "p0" });
  act(alice!, { t: "offer", to: 1 });
  await waitTable(bob!, "Alice looking and offering", (t, s) => s.looking.length === 1 && s.looking[0].pile === "p0" && t.offer != null);
  await until("the look logged", () => logVerbs(bob!).includes("looked"));
  await alice!.leave();
  // a member's presence ends when the server's reconnect grace is over (about 11 s)
  await waitTable(bob!, "Alice gone: no longer looking, offer kept", (t, s) => s.looking.length === 0 && t.offer != null, 0, 25_000);
  act(bob!, { t: "pick", i: 0 });
  await waitTable(bob!, "Bob picked from the absent Alice", (t) => handSizes(t)[1] === 4);
});

test("a reset: refused for a spectator while seated players are here, allowed when they are not", async () => {
  const { members: [alice, bob, carol] } = await cardBed([cardsDir], NAMES);
  await freeTable([alice!, bob!]);
  useDeck(carol!);
  const refused = await stateAfter(carol!, { t: "reset" }); // a spectator while seated players are here
  assert.equal(refused.tb.game, "free", "a spectator cannot reset while a seated player is here");
  act(alice!, { t: "draw", pile: "p0" });
  const tb = await waitTable(carol!, "Alice's draw", (t) => handSizes(t)[0] === 1);
  assert.equal(tb.game, "free");
  act(alice!, { t: "close" });
  act(bob!, { t: "close" });
  await waitTable(carol!, "nobody seated is here", (_, s) => s.here.length === 0);
  act(carol!, { t: "reset" });
  await until("the choice again", () => {
    const t = tableOf(carol!);
    return t && t.tb.game === null && lastOf(carol!, "games")?.list.length === 1;
  });
});

// Games register again whenever another plugin starts or stops; the table keeps the complete definition it had
// while the split deck of its game arrives.
test("a game registering again never makes its tables unavailable while its split deck arrives", async () => {
  const { members: [alice, bob] } = await cardBed([cardsDir, fixture("partgame")], NAMES);
  const part = async (n: number): Promise<void> => {
    alice!.send("partgame", { t: `part${n}`, title: "Part game" });
    const r = await alice!.waitFor<Frame>("partgame", (d) => d.t === `r${n}`);
    assert.equal(r.r.ok, true, `r${n} refused: ${JSON.stringify(r)}`);
  };
  await part(1);
  await part(2);
  useDeck(alice!, bob!);
  await until("the part game listed", () => lastOf(alice!, "games")?.list.length === 2);
  act(alice!, { t: "choose", game: "partgame" });
  await waitTable(alice!, "the part game chosen", (t, s) => t.game === "partgame" && s.unavailable === false);
  const from = count(alice!);
  await part(1); // registering again: only the first part has arrived
  act(bob!, { t: "seat", seat: 1 });
  await waitTable(alice!, "Bob's seat", (t) => t.seats[1] !== null, from);
  assert.ok(
    frames(alice!, from).every((d) => !(d.t === "state" || d.t === "open") || d.s.unavailable === false),
    "the table went unavailable while its game registered again",
  );
  await part(2);
});

// Wide characters: the 4 KB limits are bytes, and a name of 24 CJK characters is 72 of them. Nothing a member
// can do stops the plugin: every message stays under 4096 bytes and no error is thrown.
test("wide names stay under the limits", async () => {
  const names = Array.from({ length: 8 }, (_, i) => "牌".repeat(23) + String.fromCharCode(66 + i));
  const { bed, members } = await cardBed([cardsDir], names);
  await freeTable(members);
  // spread over the members: the server limits a socket to 10 plugin messages a second (burst 20)
  for (let i = 1; i < 16; i++) act(members[i % 8]!, { t: "newPile", name: "牌".repeat(15) + String.fromCharCode(97 + i), face: "up", at: [300, 170] });
  // Wide names make a big table: the plugin refuses the moves that would not fit it (that is the point), so the
  // loose cards are not counted. A batch of 8 moves is over when each member who moved got a message after it.
  for (let batch = 0; batch < 7; batch++) {
    const before = members.map(count);
    for (let i = batch * 8; i < Math.min(54, batch * 8 + 8); i++) {
      act(members[i % 8]!, { t: "place", from: { k: "pile", id: "p0" }, to: { k: "felt", at: [100 + i, 100 + i] }, up: true });
    }
    await until(`batch ${batch + 1} handled`, () => members.every((m, j) => j >= Math.min(8, 54 - batch * 8) || count(m) > before[j]!), 20_000);
  }
  for (let i = 0; i < 12; i++) act(members[1 + (i % 4)]!, { t: "count" });
  // the plugin still answers: opening the deck again gets the table (a move would be refused by a full table)
  const from = count(members[0]!);
  useDeck(members[0]!);
  await until("the plugin answers", () => frames(members[0]!, from).find((d) => d.t === "open"), 20_000);
  await noErrors(bed);
  for (const m of members) {
    for (const d of m.received(CARDS)) {
      const n = Buffer.byteLength(JSON.stringify(d));
      assert.ok(n <= 4096, `a message of ${n} bytes to ${m.name}: ${JSON.stringify(d).slice(0, 120)}`);
    }
  }
  const kv = await bed.waitKv(CARDS, (data) => key("table") in data && JSON.parse(data[key("table")]!).loose.length > 0, 20_000);
  for (const [k, v] of Object.entries(kv)) assert.ok(Buffer.byteLength(v) <= 4096, `${k} is ${Buffer.byteLength(v)} bytes`);
});

// A malformed choice is ignored, never thrown: eleven of them would stop the plugin.
test("a malformed choice is ignored", async () => {
  const { bed, members: [alice, bob] } = await cardBed([cardsDir], NAMES);
  useDeck(alice!, bob!);
  await until("the game list", () => lastOf(alice!, "games"));
  // two members: the server limits a socket to 10 plugin messages a second (burst 20)
  for (let i = 0; i < 12; i++) {
    act(alice!, { t: "choose", game: { toString: 1 } });
    act(bob!, { t: "choose", game: ["free"] });
  }
  // a plugin stopped by its errors would not answer a good choice
  act(alice!, { t: "choose", game: "free" });
  await waitTable(alice!, "the free table chosen after the malformed ones", (t) => t.game === "free");
  await noErrors(bed);
});

// A deck whose wide names pass in parts is refused at its last part: chosen, it would not fit a message.
test("a deck of wide names too big for a message is refused", async () => {
  const { bed, members: [alice] } = await cardBed([cardsDir, fixture("widegame")], NAMES);
  const answer = async (t: string): Promise<boolean> => {
    alice!.send("widegame", { t });
    const d = await alice!.waitFor<Frame>("widegame", (m) => m.t === `r${t}`);
    return d.r?.ok === true;
  };
  const accepted = (await answer("a")) && (await answer("b")) && (await answer("c"));
  assert.ok(!accepted, "a deck of 100 names of 72 bytes was accepted");
  useDeck(alice!);
  const list = (await until("the list", () => lastOf(alice!, "games")?.list)) as Frame[];
  assert.equal(list.length, 1, `only the free table is offered: ${JSON.stringify(list)}`);
  await noErrors(bed);
});

// Only hq-cards plays a game: a plugin named "free" cannot register, and a game's count hook refuses other
// callers without throwing (thrown errors would stop the game).
test("other plugins cannot pose as the table or call a game's count", async () => {
  const dirs = [cardsDir, path.join(games, "hq-card-pouilleux"), path.join(games, "hq-card-lastcard"), fixture("free")];
  const { bed, members: [alice] } = await cardBed(dirs, NAMES);
  alice!.send("free", { t: "a" });
  const r = (await alice!.waitFor<Frame>("free", (d) => d.t === "ra")).r;
  assert.notEqual(r.ok, true, `a plugin named free registered: ${JSON.stringify(r)}`);
  for (let i = 0; i < 12; i++) alice!.send("free", { t: "b" });
  for (let i = 0; i < 12; i++) await alice!.waitFor("free", (d) => d.t === "rb");
  // all three still run: both games are listed by the table, which answers
  useDeck(alice!);
  const names = await until("the games listed", () => {
    const l = lastOf(alice!, "games")?.list as Frame[] | undefined;
    return l && l.length === 3 && l.map((g) => g.name);
  });
  assert.deepEqual([...names].sort(), ["free", "hq-card-lastcard", "hq-card-pouilleux"]);
  await noErrors(bed);
});

test("a reset frees the table's keys; looking again at the pile one looks at writes nothing new", async () => {
  const { bed, members: [alice, bob] } = await cardBed([cardsDir], NAMES);
  await freeTable([alice!, bob!]);
  for (let i = 0; i < 5; i++) act(alice!, { t: "look", pile: "p0" });
  act(alice!, { t: "draw", pile: "p0" });
  await until("the draw logged", () => logVerbs(bob!).includes("drew"));
  const n = logVerbs(bob!).filter((v) => v === "looked").length;
  assert.equal(n, 1, `five looks at the same pile log ${n} lines`);
  await bed.waitKv(CARDS, (kv) => key("table") in kv && key("log") in kv); // the table is saved while it plays
  act(alice!, { t: "reset" });
  const kv = await bed.waitKv(CARDS, (data) => !(key("table") in data) && !(key("log") in data));
  assert.deepEqual(Object.keys(kv).filter((k) => k.startsWith("table:") || k.startsWith("log:")), []);
});

test("round 2: snapping, cards and piles moved, cards set aside until a reset", async () => {
  const { bed, members: [alice, bob] } = await cardBed([cardsDir], NAMES);
  await freeTable([alice!, bob!]);
  act(bob!, { t: "snap", on: false });
  await waitTable(alice!, "snapping off for everybody", (t) => t.snap === false);
  await until("the switch logged", () => logVerbs(alice!).includes("snap"));
  for (let i = 0; i < 3; i++) act(alice!, { t: "place", from: { k: "pile", id: "p0" }, to: { k: "felt", at: [60, 48 + 13 * i] }, up: true });
  let tb = await waitTable(alice!, "a cascade of 3", (t) => t.loose.length === 3);
  const ids = tb.loose.map((l: Frame) => l.c & ~128);
  act(bob!, { t: "moveCards", cards: ids, dx: 100, dy: 10 });
  await waitTable(alice!, "the cascade moved", (t) => t.loose[0].at[0] === 160 && t.loose[0].at[1] === 58);
  act(alice!, { t: "newPile", name: "Waste", face: "up", at: [20, 20] });
  act(alice!, { t: "movePile", pile: "p1", at: [40, 200] });
  await waitTable(bob!, "the pile moved", (t) => t.piles.length === 2 && t.piles[1].at[1] === 200);
  act(alice!, { t: "setAside", from: { k: "pile", id: "p0" } });
  await waitTable(bob!, "a card set aside", (t) => t.out.length === 1);
  act(alice!, { t: "gather" });
  await waitTable(bob!, "gathered, the card still out", (t) => t.piles[0].cards.length === 53 && t.out.length === 1);
  // hostile shapes: refused, never thrown
  for (const m of [
    { t: "snap", on: "yes" }, { t: "moveCards", cards: "1", dx: 1, dy: 1 }, { t: "moveCards", cards: [1], dx: "1", dy: 1 }, { t: "movePile", pile: {}, at: [1, 1] },
    { t: "movePile", pile: "p0", at: "1,1" }, { t: "setAside", from: null }, { t: "setAside", from: { k: "hand", i: 99 } },
  ]) {
    act(alice!, m);
  }
  act(alice!, { t: "reset" });
  await waitTable(alice!, "the choice again", (t) => t.game === null);
  act(alice!, { t: "choose", game: "free" });
  tb = await waitTable(alice!, "a new game from the whole deck", (t) => t.game === "free" && t.piles[0].cards.length === 54 && t.out.length === 0);
  assert.equal(tb.out.length, 0);
  await noErrors(bed);
});

// A game turned off and on while its table is open: the open window gets its table back, available.
test("a game turned off and on: the open window gets its table back, available", async () => {
  const { bed, members: [alice] } = await cardBed([cardsDir, path.join(games, "hq-card-lastcard")], NAMES);
  useDeck(alice!);
  await until("Last Card listed", () => lastOf(alice!, "games")?.list.length === 2);
  act(alice!, { t: "choose", game: "hq-card-lastcard" });
  await waitTable(alice!, "Last Card chosen", (t, s) => t.game === "hq-card-lastcard" && s.unavailable === false);
  await bed.setPlugin("hq-card-lastcard", false);
  await waitTable(alice!, "unavailable", (_, s) => s.unavailable === true);
  act(alice!, { t: "close" });
  const reopened = count(alice!);
  useDeck(alice!); // the window opened again while the game is off
  await waitTable(alice!, "the table in the window, the game off", (_, s) => s.unavailable === true, reopened);
  const from = count(alice!);
  await bed.setPlugin("hq-card-lastcard", true);
  await until("available again in the open window", () => {
    const t = tableOf(alice!, from);
    return t && t.s.unavailable === false && lastOf(alice!, "game", from);
  });
  await noErrors(bed);
});

test("a 32-card game from the free table: ranks set aside in one message", async () => {
  const { bed, members: [alice, bob] } = await cardBed([cardsDir], NAMES);
  await freeTable([alice!, bob!]);
  act(bob!, { t: "setAsideRanks", ranks: ["2", "3", "4", "5", "6", "X"] });
  await waitTable(alice!, "22 cards set aside", (t) => t.out.length === 22 && t.piles[0].cards.length === 32);
  await until("logged", () => logVerbs(alice!).includes("set aside"));
  for (const ranks of ["2", [2], ["22"]]) act(bob!, { t: "setAsideRanks", ranks });
  const tb = (await stateAfter(bob!, { t: "snap", on: false })).tb; // handled after the three above
  assert.equal(tb.out.length, 22);
  await noErrors(bed);
});

test("a pile removed while somebody looks through it: nobody is shown looking at it", async () => {
  const { members: [alice, bob] } = await cardBed([cardsDir], NAMES);
  await freeTable([alice!, bob!]);
  act(alice!, { t: "newPile", name: "Waste", face: "up", at: [40, 40] });
  await waitTable(bob!, "Waste made", (t) => t.piles.length === 2);
  act(alice!, { t: "look", pile: "p1" });
  await waitTable(bob!, "Alice looking", (_, s) => s.looking.length === 1);
  act(bob!, { t: "delPile", pile: "p1" });
  await waitTable(bob!, "the pile gone, nobody looking", (t, s) => t.piles.length === 1 && s.looking.length === 0);
});

// A window closed and opened again at once: the page's close (posted by the window) may reach the server after the
// reopen (sent by the game session). That stale close must not drop the member from the window they have open.
test("a stale close after a reopen does not drop the member", async () => {
  const { members: [alice] } = await cardBed([cardsDir], NAMES);
  await freeTable([alice!]);
  const opens = (): Frame[] => frames(alice!).filter((d) => d.t === "open");
  const first = opens()[0]!.n as number;
  useDeck(alice!);
  await until("the second open", () => opens().length === 2);
  act(alice!, { t: "close", n: first }); // the first window's close, late
  act(alice!, { t: "draw", pile: "p0" });
  await waitTable(alice!, "Alice still at her open window draws", (t) => handSizes(t)[0] === 1);
  // the close of the window she has open still closes it
  act(alice!, { t: "close", n: opens()[1]!.n });
  act(alice!, { t: "draw", pile: "p0" });
  await alice!.quiet(CARDS, 300); // she acts no more: the table sends her nothing
  assert.equal(handSizes(tableOf(alice!)!.tb)[0], 1, "after closing the window she had open, Alice no longer acts");
});
