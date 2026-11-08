// The bundled chess plugin through the real server: `homequarters testbed` runs the plugin's server code
// (main.ts, compiled and run by QuickJS as in production) and these tests drive it as members do, over
// HTTP and WebSocket, with X next to a board (`use`) and the page's messages (`send`).
// Run: node --test "plugins/bundled/hq-chess/test/*.ispec.ts" (needs bin/homequarters[.exe] or HQ_BIN).
//
// Waiting: a state predicate is polled on everything a member received (`waitBoard`), not matched with
// `waitFor`, which consumes frames and would make a later wait depend on an earlier one. Where an action must
// be refused, the test does not sleep: the plugin handles one socket's messages in order, so a probe the plugin
// always answers (`probe`) proves the earlier message was handled, and nothing changed.
import assert from "node:assert/strict";
import path from "node:path";
import { after, test } from "node:test";
import { testbed } from "../../../sdk/testbed.ts";
import type { Member, Testbed, Tile } from "../../../sdk/testbed.ts";

const PLUGIN = "hq-chess";
const START = "rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR";
// two boards side by side, and where members stand: within reach of both
const A: Tile = { x: 13, y: 22 };
const B: Tile = { x: 14, y: 22 };
const STAND: Tile = { x: 13, y: 23 };

type Seat = { id: number; name: string; here: boolean } | null;
type State = { p: string; w: Seat; b: Seat; r: string; u: boolean; m: { from?: number; to?: number } | null; undone: string | null };
type Frame = { t: string; x?: number; y?: number; s?: State; list?: { id: number; side: string }[] };

const beds: Testbed[] = [];
after(async () => {
  await Promise.all(beds.map((b) => b.close()));
});

/** A fresh server with the plugin and chessboards at the given tiles. */
async function open(...boards: Tile[]): Promise<Testbed> {
  const bed = await testbed({ plugins: [path.resolve(import.meta.dirname, "..")] });
  beds.push(bed);
  // the administrator needs an account before the map can be edited
  const admin = await bed.join("Admin");
  await admin.leave();
  for (const b of boards) await bed.placeObject("chessboard", b);
  return bed;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
}

const frames = (m: Member): Frame[] => m.received(PLUGIN) as Frame[];
const isBoard = (f: Frame, at: Tile): boolean => (f.t === "open" || f.t === "state") && f.x === at.x && f.y === at.y;
/** The states a member got of a board, from the `from`th chess frame on. */
const boardStates = (m: Member, at: Tile, from = 0): State[] =>
  frames(m)
    .slice(from)
    .filter((f) => isBoard(f, at))
    .map((f) => f.s!);
const count = (m: Member, at: Tile, from = 0): number => boardStates(m, at, from).length;
const lastBoard = (m: Member, at: Tile, from = 0): State => {
  const all = boardStates(m, at, from);
  assert.ok(all.length, `${m.name} got no state of the board at ${at.x},${at.y}`);
  return all[all.length - 1]!;
};

/** Waits until the member's latest view of a board satisfies `ok`. */
function waitBoard(m: Member, at: Tile, what: string, ok: (s: State) => boolean, from = 0, ms = 5000): Promise<State> {
  return until(`${m.name}: ${what}`, () => {
    const all = boardStates(m, at, from);
    const s = all[all.length - 1];
    return s && ok(s) ? s : undefined;
  }, ms);
}

/** "" for a free seat, else "<name>" or "<name> (away)". */
function seat(s: State, side: "w" | "b"): string {
  const v = s[side];
  return v ? (v.here ? v.name : v.name + " (away)") : "";
}

/** The playing lists a member got, the last as "id:side" strings. */
function playingOf(m: Member): string[] | undefined {
  const all = frames(m).filter((f) => f.t === "playing");
  return all.length ? all[all.length - 1]!.list!.map((e) => `${e.id}:${e.side}`) : undefined;
}
const waitPlaying = (m: Member, what: string, want: string[]): Promise<string[]> =>
  until(`${m.name}: ${what}`, () => {
    const got = playingOf(m);
    return got && got.join(" ") === want.join(" ") ? got : undefined;
  });

/** The last action of a state ("52-36"; "-12" for a place, "57-" for a stash, "" for none) and whether an undo is open. */
function last(s: State): [string, boolean] {
  const sq = (v: number | undefined): string => (v === undefined ? "" : String(v));
  return [s.m ? sq(s.m.from) + "-" + sq(s.m.to) : "", s.u];
}

const move = (m: Member, at: Tile, from: number, to: number, extra: object = {}): void => m.send(PLUGIN, { t: "move", ...at, from, to, ...extra });
const seatAs = (m: Member, at: Tile, side: "w" | "b"): void => m.send(PLUGIN, { t: "seat", ...at, side });

/**
 * A message the plugin always answers with a state of the board, whatever else happened: a refused action by
 * a viewer queues their state again. A seated player's move of an empty square, anyone else's undo (nothing
 * to undo for a spectator). Resolves with that answer; every earlier message of the member was handled first.
 * Only for a member who has the board open (a viewer): the plugin ignores everybody else.
 */
async function probe(m: Member, at: Tile, seated = false): Promise<State> {
  const n = count(m, at);
  if (seated) move(m, at, 27, 27);
  else m.send(PLUGIN, { t: "undo", ...at });
  await until(`${m.name}: the answer to a probe`, () => count(m, at) > n);
  return lastBoard(m, at);
}

/** Sends messages the way a page may: its limit is a burst of 20, then 10 a second; the rest waits. */
async function sendAll(m: Member, msgs: unknown[]): Promise<void> {
  let i = 0;
  for (const d of msgs) {
    m.send(PLUGIN, d);
    if (++i > 12) await sleep(110);
  }
}

/** A member next to the boards, with the board at `at` open (the first frame is its `open`). */
async function sitAt(bed: Testbed, name: string, ...ats: Tile[]): Promise<Member> {
  const m = await bed.join(name, { at: STAND });
  for (const at of ats) {
    m.use(at);
    await waitBoard(m, at, "open", () => true);
  }
  return m;
}

const stored = async (bed: Testbed, at: Tile, pred: (b: any) => boolean = () => true): Promise<any> => {
  const kv = await bed.waitKv(PLUGIN, (d) => `board:${at.x},${at.y}` in d && pred(JSON.parse(d[`board:${at.x},${at.y}`]!)));
  return JSON.parse(kv[`board:${at.x},${at.y}`]!);
};

const noErrors = async (bed: Testbed): Promise<void> => {
  assert.deepEqual(await bed.errors(), {}, "the plugin never threw");
};

test("a board opens on use, on the start position with both seats free", async () => {
  const bed = await open(A);
  const alice = await bed.join("Alice", { at: STAND });
  alice.use(A);
  const s = await waitBoard(alice, A, "open", () => true);
  assert.equal(s.p, START);
  assert.equal(s.w, null);
  assert.equal(s.b, null);
  assert.equal(frames(alice).find((f) => f.t === "open" || f.t === "state")!.t, "open", "the first message is open");
  await noErrors(bed);
});

test("seats, moves and presence: everybody sees a move, refused actions change nothing", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  const bob = await sitAt(bed, "Bob", A);
  const carol = await sitAt(bed, "Carol", A);
  seatAs(alice, A, "w");
  seatAs(bob, A, "b");
  move(alice, A, 52, 36);
  for (const m of [alice, bob, carol]) {
    const s = await waitBoard(m, A, "e2-e4 seen by everybody", (s) => s.p[36] === "P");
    assert.equal(seat(s, "w"), "Alice");
    assert.equal(seat(s, "b"), "Bob");
    assert.equal(s.p[52], ".");
  }
  // refused: a seated player changing side, a taken seat, black pieces moved by White, a spectator moving
  seatAs(alice, A, "b");
  seatAs(carol, A, "w");
  move(alice, A, 12, 28);
  move(carol, A, 51, 35);
  const afterRefusals = await probe(alice, A, true);
  await probe(carol, A);
  assert.equal(seat(afterRefusals, "w"), "Alice");
  assert.equal(seat(afterRefusals, "b"), "Bob");
  assert.equal(afterRefusals.p[28], ".");
  assert.equal(afterRefusals.p[35], ".");
  assert.equal(afterRefusals.p[12], "p");
  bob.send(PLUGIN, { t: "close", ...A });
  await waitBoard(alice, A, "Bob away", (s) => seat(s, "b") === "Bob (away)");
  carol.send(PLUGIN, { t: "reset", ...A }); // Alice is still here: refused
  await probe(carol, A); // handled before Alice leaves (another socket could overtake it)
  alice.send(PLUGIN, { t: "close", ...A });
  let s = await waitBoard(carol, A, "both away", (s) => seat(s, "w") === "Alice (away)" && seat(s, "b") === "Bob (away)");
  const afterReset = await probe(carol, A);
  assert.equal(afterReset.p[36], "P", "Carol's reset while Alice was here must be refused");
  carol.send(PLUGIN, { t: "reset", ...A }); // nobody seated is here: allowed
  s = await waitBoard(carol, A, "reset", (s) => s.w === null);
  assert.equal(s.p, START);
  assert.equal(s.b, null);
  seatAs(carol, A, "w");
  await waitBoard(carol, A, "anyone may sit after a reset", (s) => seat(s, "w") === "Carol");
  await noErrors(bed);
});

test("a seated player who is present may reset the board", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  const bob = await sitAt(bed, "Bob", A);
  seatAs(alice, A, "w");
  seatAs(bob, A, "b");
  move(bob, A, 12, 28);
  await waitBoard(alice, A, "black moved", (s) => s.p[28] === "p");
  bob.send(PLUGIN, { t: "reset", ...A });
  await waitBoard(alice, A, "Bob, seated and here, resets", (s) => s.p === START && s.w === null && s.b === null);
});

test("hello makes a member absent from every board; leaving the office does too", async () => {
  const bed = await open(A, B);
  const alice = await sitAt(bed, "Alice", A, B);
  const bob = await sitAt(bed, "Bob", A, B);
  seatAs(alice, A, "w");
  seatAs(alice, B, "b");
  await waitBoard(bob, B, "seated", (s) => seat(s, "b") === "Alice");
  alice.send(PLUGIN, { t: "hello" }); // her page reloaded: no window of hers is open
  await waitBoard(bob, A, "away on the first board", (s) => seat(s, "w") === "Alice (away)");
  await waitBoard(bob, B, "away on the second", (s) => seat(s, "b") === "Alice (away)");
  const before = count(alice, A);
  move(alice, A, 52, 36); // not a viewer any more: ignored
  // Bob's probe comes from another socket than Alice's move, which was written first
  assert.equal((await probe(bob, A)).p, START, "a member who is not a viewer cannot move");
  assert.equal(count(alice, A), before, "a member who closed the board gets no more states of it");
  alice.use(A);
  await waitBoard(bob, A, "back in her seat", (s) => seat(s, "w") === "Alice");
  await alice.leave(); // leaving the office makes her absent too
  // the server keeps a member online for its reconnect grace (about 11 s) after the socket closed
  await waitBoard(bob, A, "away after leaving", (s) => seat(s, "w") === "Alice (away)", 0, 20_000);
});

test("a late hello keeps the window open once the page confirms it; a confirmation nobody waits for changes nothing", async () => {
  const bed = await open(A, B);
  const bob = await sitAt(bed, "Bob", A);
  const alice = await bed.join("Alice", { at: STAND });
  alice.use(A);
  await waitBoard(alice, A, "open", () => true);
  seatAs(alice, A, "w");
  await waitBoard(bob, A, "seated", (s) => seat(s, "w") === "Alice");
  alice.send(PLUGIN, { t: "hello" }); // her plugin started after the open was sent
  await waitBoard(bob, A, "away for a moment", (s) => seat(s, "w") === "Alice (away)");
  alice.send(PLUGIN, { t: "opened", ...A }); // her page drew the window
  await waitBoard(bob, A, "here again", (s) => seat(s, "w") === "Alice");
  move(alice, A, 52, 36);
  await waitBoard(bob, A, "she plays", (s) => s.p !== START);

  // closed: a confirmation afterwards does not reopen it; nor does one for a board never opened
  alice.send(PLUGIN, { t: "close", ...A });
  await waitBoard(bob, A, "away after closing", (s) => seat(s, "w") === "Alice (away)");
  alice.send(PLUGIN, { t: "opened", ...A });
  alice.send(PLUGIN, { t: "opened", ...B });
  // she is not a viewer, so she cannot be probed: Bob's probe, from another socket, comes after her messages
  const s = await probe(bob, A);
  assert.equal(seat(s, "w"), "Alice (away)", "an unexpected confirmation reopened the window");
  assert.equal(count(alice, B), 0, "a confirmation for a board never opened sent its state");
});

test("a game and its seats survive a server restart", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  const bob = await sitAt(bed, "Bob", A);
  seatAs(alice, A, "w");
  seatAs(bob, A, "b");
  move(alice, A, 52, 36);
  await waitBoard(bob, A, "moved", (s) => s.p[36] === "P" && seat(s, "b") === "Bob");
  await stored(bed, A, (b) => b.p[36] === "P" && b.b !== null);
  await bed.restart();

  const carol = await bed.join("Carol", { at: STAND });
  carol.use(A);
  const s = await waitBoard(carol, A, "reopened", () => true);
  assert.equal(s.p[36], "P");
  assert.equal(seat(s, "w"), "Alice (away)", "position and seats kept across a restart, nobody present");
  assert.equal(seat(s, "b"), "Bob (away)");
});

test("moves apply in order, each to the position the previous one left", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  seatAs(alice, A, "w");
  await sendAll(
    alice,
    [
      [52, 44],
      [44, 36],
      [36, 28],
      [28, 20],
      [62, 45],
      [45, 30],
    ].map(([from, to]) => ({ t: "move", ...A, from, to })),
  );
  const s = await waitBoard(alice, A, "moves", (s) => s.p[30] === "N");
  for (const i of [52, 44, 36, 28, 62, 45]) assert.equal(s.p[i], ".", `square ${i}`);
  assert.equal(s.p[20], "P");
});

test("a refused move sends the mover the state again, and nobody else", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  const bob = await sitAt(bed, "Bob", A);
  seatAs(alice, A, "w");
  await waitBoard(alice, A, "seated", (s) => seat(s, "w") === "Alice");
  await waitBoard(bob, A, "Bob sees the seat", (s) => seat(s, "w") === "Alice");
  const before = count(alice, A);
  const bobBefore = count(bob, A);
  move(alice, A, 12, 28); // a black pawn: refused
  await until("a fresh state for the mover", () => count(alice, A) > before);
  assert.equal(lastBoard(alice, A).p, START, "the board did not change");
  // Bob's probe is answered; had the refusal reached him he would have two new states
  await probe(bob, A);
  assert.equal(count(bob, A), bobBefore + 1, "only the mover is sent the state again");
});

test("a board is stored under its tile, a seat as {id, name}, and opening writes nothing", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  assert.deepEqual(await bed.kv(PLUGIN), {}, "opening a board writes nothing");
  seatAs(alice, A, "b");
  const b = await stored(bed, A);
  assert.ok(`board:${A.x},${A.y}` in (await bed.kv(PLUGIN)));
  assert.equal(b.p, START);
  assert.equal(b.w, null);
  assert.deepEqual(b.b, { id: alice.id, name: "Alice" }, "a seat is stored as {id, name}");
});

test("malformed messages are ignored, not errors, and the plugin keeps running", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  seatAs(alice, A, "w");
  await waitBoard(alice, A, "seated", (s) => seat(s, "w") === "Alice");
  const at = { x: A.x, y: A.y };
  await sendAll(alice, [
    null,
    7,
    "move",
    [],
    {},
    { t: "nope" },
    { t: "move" },
    { t: "move", x: String(A.x), y: A.y, from: 52, to: 36 },
    { t: "move", ...at, from: "52", to: 36 },
    { t: "move", ...at, from: 52.5, to: 36 },
    { t: "move", ...at, from: 52, to: 64 },
    { t: "move", ...at, from: -1, to: 36 },
    { t: "move", ...at, from: 52, to: 52 },
    { t: "move", x: 9, y: 9, from: 52, to: 36 },
    { t: "seat", ...at, side: "x" },
    { t: "seat", ...at },
    { t: "seat", x: 8, y: 8, side: "b" },
    { t: "reset", x: 8, y: 8 },
    { t: "close", x: 8, y: 8 },
    { t: "close", x: null, y: A.y },
    { t: "reset", x: {}, y: A.y },
    { t: "seat", ...at, side: "b" }, // already seated
  ]);
  move(alice, A, 51, 35); // a valid one after them
  const s = await waitBoard(alice, A, "valid move", (s) => s.p[35] === "P");
  assert.equal(s.p[36], ".", "a malformed move applied");
  assert.equal(s.p[52], "P");
  assert.equal(count(alice, { x: 8, y: 8 }), 0, "a board never opened got no state");
  await noErrors(bed);
  // still running: it answers
  assert.equal((await probe(alice, A, true)).p[35], "P");
});

test("the playing list names the present seated players, and a joining member gets it", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  const bob = await sitAt(bed, "Bob", A);
  seatAs(alice, A, "w");
  seatAs(bob, A, "b");
  await waitPlaying(alice, "both listed", [`${alice.id}:w`, `${bob.id}:b`]);
  bob.send(PLUGIN, { t: "close", ...A });
  await waitPlaying(alice, "Bob closed his window", [`${alice.id}:w`]);
  const carol = await bed.join("Carol", { at: STAND });
  await waitPlaying(carol, "a joining member gets the list", [`${alice.id}:w`]);
  alice.send(PLUGIN, { t: "reset", ...A });
  await waitPlaying(alice, "a reset frees both seats", []);
});

// The playing list reaches every member while one of them keeps the plugin busy with refused moves, each
// answered by a state sent to him. This does not spend Bob's send budget: members' messages are let in at
// 5 a second (httpapi) while the budget refills at 10, so a page cannot flood it. That a spent recipient
// holds back no message sent to another member on its own is the host's behaviour, tested in Go on a
// fixture plugin: TestSpentRecipientDoesNotHoldBackOthers (server/internal/plugin/host_test.go).
test("the playing list reaches every member while one of them sends a stream of refused moves", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  const bob = await sitAt(bed, "Bob", A);
  const carol = await sitAt(bed, "Carol", A);
  seatAs(alice, A, "w");
  seatAs(bob, A, "b");
  await waitPlaying(carol, "Carol sees both players", [`${alice.id}:w`, `${bob.id}:b`]);
  let flooding = true;
  const flood = (async () => {
    while (flooding) {
      move(bob, A, 27, 27); // refused: his state is sent again
      await sleep(40);
    }
  })();
  try {
    alice.send(PLUGIN, { t: "close", ...A });
    await waitPlaying(carol, "Carol gets the new list while Bob sends refused moves", [`${bob.id}:b`]);
  } finally {
    flooding = false;
    await flood;
  }
  await waitPlaying(bob, "Bob gets it too", [`${bob.id}:b`]);
});

test("the reserve of captured pieces, place, stash and promotion, and the reserve survives a restart", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  const bob = await sitAt(bed, "Bob", A);
  seatAs(alice, A, "w");
  seatAs(bob, A, "b");
  let s = await waitBoard(bob, A, "seated, empty reserve", (s) => seat(s, "b") === "Bob");
  assert.equal(s.r, "", "a new board's reserve is empty");
  move(alice, A, 52, 12); // e2 takes e7
  await waitBoard(bob, A, "the black pawn in the reserve", (s) => s.r === "p");
  bob.send(PLUGIN, { t: "place", ...A, piece: "p", to: 20 }); // the pawn back on e6
  alice.send(PLUGIN, { t: "place", ...A, piece: "p", to: 21 }); // refused: not White's piece
  alice.send(PLUGIN, { t: "stash", ...A, from: 62 }); // the g1 knight off the board
  alice.send(PLUGIN, { t: "stash", ...A, from: 1 }); // refused: a black knight
  s = await waitBoard(bob, A, "placed and stashed", (s) => s.r === "N");
  assert.equal(s.p[20], "p");
  assert.equal(s.p[21], ".");
  assert.equal(s.p[62], ".");
  assert.equal(s.p[1], "n");
  move(alice, A, 12, 5, { promote: "k" }); // refused: not a choice
  move(alice, A, 12, 5, { promote: "q" }); // e7 takes f8 and is a queen
  s = await waitBoard(bob, A, "promoted", (s) => s.r === "Nb");
  assert.equal(s.p[5], "Q");
  assert.equal(s.p[12], ".");
  assert.equal(s.p[59], "Q", "promotion makes a second queen");
  alice.send(PLUGIN, { t: "place", ...A, piece: "N", to: 4 }); // on the black king: it goes to the reserve
  await waitBoard(bob, A, "the king in the reserve", (s) => s.r === "bk");
  await stored(bed, A, (b) => b.r === "bk");
  await bed.restart();

  const carol = await bed.join("Carol", { at: STAND });
  carol.use(A);
  s = await waitBoard(carol, A, "reopened", () => true);
  assert.equal(s.r, "bk", "the reserve survives a restart");
  assert.equal(s.p[4], "N");
  await noErrors(bed);
});

test("a reset empties the reserve, in the state and in storage", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  seatAs(alice, A, "w");
  alice.send(PLUGIN, { t: "stash", ...A, from: 57 });
  await waitBoard(alice, A, "stashed", (s) => s.r === "N");
  alice.send(PLUGIN, { t: "reset", ...A });
  await waitBoard(alice, A, "reset", (s) => s.r === "" && s.w === null);
  await stored(bed, A, (b) => b.r === "" && b.w === null);
});

test("malformed reserve, place, stash and promotion messages are ignored, not errors", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  seatAs(alice, A, "w");
  alice.send(PLUGIN, { t: "stash", ...A, from: 57 });
  await waitBoard(alice, A, "stashed", (s) => s.r === "N");
  await sendAll(alice, [
    { t: "place", ...A },
    { t: "place", ...A, piece: "N" },
    { t: "place", ...A, piece: 7, to: 40 },
    { t: "place", ...A, piece: "NN", to: 40 },
    { t: "place", ...A, piece: "N", to: 64 },
    { t: "place", ...A, piece: "N", to: "40" },
    { t: "stash", ...A },
    { t: "stash", ...A, from: -1 },
    { t: "stash", ...A, from: [] },
    { t: "move", ...A, from: 52, to: 36, promote: null },
    { t: "move", ...A, from: 52, to: 36, promote: 1 },
    { t: "move", ...A, from: 52, to: 36, promote: "q" },
  ]);
  alice.send(PLUGIN, { t: "place", ...A, piece: "N", to: 42 }); // a valid one after them
  const s = await waitBoard(alice, A, "valid place", (s) => s.p[42] === "N");
  assert.equal(s.r, "");
  assert.equal(s.p[52], "P");
  assert.equal(s.p[40], ".", "a malformed message applied");
  await noErrors(bed);
});

test("undo takes back the last action only, by either seated player who has the board open", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  const bob = await sitAt(bed, "Bob", A);
  const carol = await sitAt(bed, "Carol", A);
  seatAs(alice, A, "w");
  seatAs(bob, A, "b");
  let s = await waitBoard(carol, A, "seated", (s) => seat(s, "b") === "Bob");
  assert.deepEqual(last(s), ["", false], "a new board has no last action and no undo");
  await waitBoard(bob, A, "Bob sees the seats", (s) => seat(s, "b") === "Bob");
  const bob0 = count(bob, A);
  bob.send(PLUGIN, { t: "undo", ...A }); // nothing to undo: refused, Bob gets the state again
  await until("a refused undo resends the state", () => count(bob, A) > bob0);

  // the mover's own undo
  move(alice, A, 52, 36);
  s = await waitBoard(carol, A, "e4", (s) => s.p[36] === "P");
  assert.deepEqual(last(s), ["52-36", true], "the state names the last move and an undo");
  alice.send(PLUGIN, { t: "undo", ...A });
  for (const m of [alice, bob, carol]) {
    s = await waitBoard(m, A, "undone for everybody", (s) => s.p === START);
    assert.deepEqual(last(s), ["", false], "after an undo: no highlight, no second undo");
    assert.equal(seat(s, "w"), "Alice");
    assert.equal(seat(s, "b"), "Bob");
    assert.equal(s.undone, "w", "the state names the side that undid (the views announce it)");
  }

  // the other player's undo, of a capture: the reserve comes back too
  move(alice, A, 52, 12);
  await waitBoard(bob, A, "exe7", (s) => s.r === "p");
  const carolN = count(carol, A);
  carol.send(PLUGIN, { t: "undo", ...A }); // a watcher: refused, the state resent to him only
  await until("the watcher gets the state again", () => count(carol, A) > carolN);
  assert.equal(lastBoard(carol, A).r, "p", "a watcher cannot undo");
  bob.send(PLUGIN, { t: "undo", ...A });
  s = await waitBoard(alice, A, "Bob undoes White's capture", (s) => s.p === START);
  assert.equal(s.r, "", "the reserve is restored");
  assert.equal(s.undone, "b", "Black is named as the side that undid");
  const bobN = count(bob, A);
  bob.send(PLUGIN, { t: "undo", ...A }); // one level only
  await until("a second undo is refused and resent", () => count(bob, A) > bobN);
  s = lastBoard(bob, A);
  assert.equal(s.p, START, "a second undo changed the board");
  assert.equal(s.r, "");

  // an undoer whose window is closed is not present: ignored
  move(bob, A, 12, 28);
  s = await waitBoard(alice, A, "e5", (s) => s.p[28] === "p");
  assert.equal(s.undone, null, "the next action clears who undid");
  alice.send(PLUGIN, { t: "close", ...A });
  await waitBoard(bob, A, "Alice away", (s) => seat(s, "w") === "Alice (away)");
  alice.send(PLUGIN, { t: "undo", ...A });
  // Alice is not a viewer, so only Bob (another socket, later) can show that nothing changed
  assert.equal((await probe(bob, A, true)).p[28], "p", "an absent player cannot undo");

  // a reset clears the undo and the highlight
  bob.send(PLUGIN, { t: "reset", ...A });
  s = await waitBoard(carol, A, "reset", (s) => s.w === null);
  assert.deepEqual(last(s), ["", false], "a reset clears the last action and the undo");
  await noErrors(bed);
});

test("a place and a stash are actions too: the highlight names their square and undo puts them back", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  seatAs(alice, A, "w");
  alice.send(PLUGIN, { t: "stash", ...A, from: 57 });
  let s = await waitBoard(alice, A, "stashed", (s) => s.r === "N");
  assert.deepEqual(last(s), ["57-", true], "a stash highlights its starting square");
  alice.send(PLUGIN, { t: "place", ...A, piece: "N", to: 12 });
  s = await waitBoard(alice, A, "placed on e7", (s) => s.p[12] === "N");
  assert.equal(last(s)[0], "-12", "a place highlights its destination");
  assert.equal(s.r, "p");
  alice.send(PLUGIN, { t: "undo", ...A });
  s = await waitBoard(alice, A, "place undone", (s) => s.r === "N");
  assert.equal(s.p[12], "p", "the undo of a place puts the pawn back on e7");
  assert.equal(s.p[57], ".", "and the knight in the reserve");
});

test("the last action and its undo survive a server restart", async () => {
  const bed = await open(A);
  const alice = await sitAt(bed, "Alice", A);
  const bob = await sitAt(bed, "Bob", A);
  seatAs(alice, A, "w");
  seatAs(bob, A, "b");
  move(alice, A, 52, 12);
  await waitBoard(bob, A, "moved", (s) => s.r === "p" && seat(s, "b") === "Bob");
  const b = await stored(bed, A, (b) => b.u != null && b.m != null);
  assert.equal(b.u.p, START, "u is the board before the last action");
  assert.equal(b.u.r, "");
  await bed.restart();

  await bob.reconnect();
  const from = bob.received(PLUGIN).length;
  bob.use(A);
  const s = await waitBoard(bob, A, "reopened", () => true, from);
  assert.deepEqual(last(s), ["52-12", true], "the last action and its undo survive a restart");
  bob.send(PLUGIN, { t: "undo", ...A });
  await waitBoard(bob, A, "undone after the restart", (s) => s.p === START && s.r === "", from);
});
