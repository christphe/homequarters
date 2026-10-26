// Client movement: collisions shared with the server, my predicted position and its reconciliation,
// remote dead reckoning. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOX_HH, BOX_HW, LocalMotion, MAX_ADVANCE, OFFSET_TAU, REMOTE_SNAP_PX, SNAP_PX,
  canStand, canStandStatic, contact, moveBody, retarget, solidGrid, stepRemote, type Grid, type Remote,
} from "../src/game/motion.ts";
import type { MapData } from "../src/net/protocol.ts";

const T = 16;
const close = (a: number, b: number, what: string, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

/** A grid from rows of "#" (wall), "." (floor) or a digit (floor in that area). */
function grid(rows: string[], deny: number[] = []): Grid {
  const w = rows[0].length, h = rows.length;
  const solid = new Uint8Array(w * h), areaAt = new Int16Array(w * h).fill(-1);
  rows.forEach((r, y) => [...r].forEach((c, x) => {
    if (c === "#") solid[y * w + x] = 1;
    else if (c !== ".") areaAt[y * w + x] = Number(c);
  }));
  return { w, h, solid, areaAt, deny: new Set(deny) };
}

// a wall at column 6, a room (area 0) at columns 1-3 of rows 4-5
const ROOM = grid([
  "......#...",
  "......#...",
  "......#...",
  "..........",
  ".000......",
  ".000......",
]);
const mid = (t: number) => t * T + T / 2;

test("solidGrid reads the map's solid rows", () => {
  const map = { w: 3, h: 2, solid: ["010", "001"] } as MapData;
  assert.deepEqual([...solidGrid(map)], [0, 1, 0, 0, 0, 1]);
});

test("contact puts the box flush against the tile edge it crosses", () => {
  assert.equal(contact(6 * T - 1, 1, BOX_HW), 6 * T - BOX_HW, "moving right into tile 6");
  assert.equal(contact(7 * T + 1, -1, BOX_HW), 7 * T + BOX_HW, "moving left into tile 6");
  assert.equal(contact(3 * T, 1, BOX_HH), 3 * T - BOX_HH, "moving down to a row edge");
});

test("canStand: walls, the map's edges and denied areas; canStandStatic only walls and edges", () => {
  const g = { ...ROOM, deny: new Set([0]) };
  assert.equal(canStand(g, mid(4), mid(1), -1), true);
  assert.equal(canStand(g, 6 * T - BOX_HW, mid(1), -1), true, "flush against the wall");
  assert.equal(canStand(g, 6 * T - BOX_HW + 0.01, mid(1), -1), false, "overlapping it");
  assert.equal(canStand(g, BOX_HW - 0.01, mid(1), -1), false, "past the map's left edge");
  assert.equal(canStand(g, mid(2), mid(4), -1), false, "a denied room");
  assert.equal(canStand(g, mid(2), mid(4), 0), true, "a denied room I am already in");
  assert.equal(canStandStatic(g, mid(2), mid(4)), true, "rooms do not stop remote people");
  assert.equal(canStandStatic(g, mid(6), mid(1)), false);
});

test("moveBody walks the exact distance, diagonals at 1/sqrt2 per axis", () => {
  const p = { x: mid(1), y: mid(1) };
  moveBody(ROOM, p, 1, 0, 30, -1);
  close(p.x, mid(1) + 30, "x");
  const q = { x: mid(1), y: mid(0) + 2 };
  moveBody(ROOM, q, 1, 1, 20, -1);
  close(q.x, mid(1) + 20 * 0.70710678, "diagonal x");
  close(q.y, mid(0) + 2 + 20 * 0.70710678, "diagonal y");
});

test("moveBody stops flush against a wall however far it goes in one step (no tunnelling)", () => {
  for (const dist of [5, 37, 300]) {
    const p = { x: mid(4), y: mid(1) };
    moveBody(ROOM, p, 1, 0, dist, -1);
    assert.equal(p.x, Math.min(mid(4) + dist, 6 * T - BOX_HW), `dist ${dist}`);
  }
});

test("moveBody slides along a wall walking diagonally into it (corner sliding)", () => {
  const p = { x: 6 * T - BOX_HW - 1, y: mid(0) };
  moveBody(ROOM, p, 1, 1, 20, -1);
  assert.equal(p.x, 6 * T - BOX_HW, "x stops at the wall");
  close(p.y, mid(0) + 20 * 0.70710678, "y keeps going");
  // under the wall's foot (row 3 is open), walking up-right slides along the foot
  const q = { x: 6 * T - BOX_HW, y: 3 * T + BOX_HH };
  moveBody(ROOM, q, 1, -1, 10, -1);
  close(q.x, 6 * T - BOX_HW + 10 * 0.70710678, "x goes on under the wall");
  assert.equal(q.y, 3 * T + BOX_HH, "y stays flush against its foot");
});

test("moveBody gives the same result however the time is split", () => {
  const whole = { x: mid(1), y: mid(1) }, split = { x: mid(1), y: mid(1) };
  moveBody(ROOM, whole, 1, 1, 90, -1);
  for (let i = 0; i < 9; i++) moveBody(ROOM, split, 1, 1, 10, -1);
  close(whole.x, split.x, "x", 1e-6);
  close(whole.y, split.y, "y", 1e-6);
});

test("moveBody: a denied room stops me at its door, but I may walk out of it, and not back in", () => {
  const g = { ...ROOM, deny: new Set([0]) };
  const p = { x: mid(2), y: mid(2) };
  moveBody(g, p, 0, 1, 40, -1);
  assert.equal(p.y, 4 * T - BOX_HH, "stopped at the room's edge");
  const q = { x: mid(2), y: mid(5) };
  moveBody(g, q, 0, -1, 60, 0); // I am inside
  close(q.y, mid(5) - 60, "walked out");
  moveBody(g, q, 0, 1, 60, -1);
  assert.equal(q.y, 4 * T - BOX_HH, "and cannot walk back in");
  // within one call, access follows the walk: out and back in the same move is refused at the door
  const r = { x: mid(2), y: 4 * T + 1 };
  moveBody(g, r, 0, -1, 8, 0);
  moveBody(g, r, 0, 1, 8, -1);
  assert.equal(r.y, 4 * T - BOX_HH);
});

test("moveBody with no area (remote people) ignores rooms", () => {
  const g = { ...ROOM, deny: new Set([0]) };
  const p = { x: mid(2), y: mid(2) };
  moveBody(g, p, 0, 1, 32, null);
  close(p.y, mid(2) + 32, "walked into the denied room");
});

test("LocalMotion.advance integrates up to now, at most MAX_ADVANCE seconds at once (a backgrounded tab)", () => {
  const m = new LocalMotion();
  m.reset(mid(0), mid(3));
  m.restart(1000);
  assert.equal(m.advance(1500, ROOM, 1, 0, 40, -1), true);
  close(m.x, mid(0) + 20, "half a second at 40 px/s");
  assert.equal(m.advance(1500, ROOM, 1, 0, 40, -1), false, "no time went by");
  m.advance(61_500, ROOM, 1, 0, 40, -1);
  close(m.x, mid(0) + 20 + 40 * MAX_ADVANCE, "a minute away moves one second's worth");
  assert.equal(m.advance(61_000, ROOM, 1, 0, 40, -1), false, "a clock going back moves nothing");
  assert.equal(m.advance(62_000, ROOM, 0, 0, 40, -1), false, "standing still");
  assert.equal(m.advance(63_000, null, 1, 0, 40, -1), false, "no map yet");
  close(m.x, mid(0) + 60, "...and the time standing still is not caught up later");
});

test("LocalMotion: an exact ack changes nothing; an error moves me and every input in flight once", () => {
  const m = new LocalMotion();
  m.reset(100, 100);
  const s1 = m.record();
  m.x = 110;
  const s2 = m.record();
  m.x = 120;
  assert.equal(m.ack(s1, 100.05, 100), false, "within the server's 0.1 px rounding");
  assert.equal(m.x, 120);
  assert.equal(m.ack(s2, 113, 100), true, "the server had me 3 px further");
  assert.equal(m.x, 123);
  assert.equal(m.ox, -3, "the avatar is drawn where it was, the offset fades");
  const s3 = m.record(); // at 123
  m.x = 130;
  assert.equal(m.ack(s3, 123, 100), false, "the error is not applied again by later acks");
  assert.equal(m.x, 130);
});

test("LocalMotion: corrections in flight shift the recorded positions too", () => {
  const m = new LocalMotion();
  m.reset(0, 0);
  const s1 = m.record();
  m.x = 10;
  const s2 = m.record();
  m.x = 20;
  m.ack(s1, 5, 0); // error 5: s2 was really at 15
  assert.equal(m.x, 25);
  assert.equal(m.ack(s2, 15, 0), false, "s2's record carries the same error");
});

test("LocalMotion: the ack of an old input is ignored; one of an unknown newer input compares with where I am", () => {
  const m = new LocalMotion();
  m.reset(0, 0);
  const s1 = m.record();
  const s2 = m.record();
  m.x = 50;
  assert.equal(m.ack(s2, 0, 0), false, "no error; clears s1 and s2");
  assert.equal(m.x, 50);
  assert.equal(m.ack(s1, 999, 999), false, "a delayed ack older than the last applied");
  assert.deepEqual([m.x, m.y], [50, 0]);
  assert.equal(m.ack(s2 + 5, 54, 0), true, "newer than anything applied, no record");
  assert.equal(m.x, 54);
});

test("LocalMotion keeps only the last 64 inputs", () => {
  const m = new LocalMotion();
  m.reset(0, 0);
  const first = m.record();
  for (let i = 0; i < 64; i++) m.record();
  m.x = 7;
  // the first record is gone: its ack compares with the live position
  assert.equal(m.ack(first, 7, 0), false);
  assert.equal(m.x, 7);
});

test("LocalMotion: corrections above SNAP_PX snap, with no offset", () => {
  const m = new LocalMotion();
  m.reset(0, 0);
  m.ack(m.record(), SNAP_PX + 1, 0);
  assert.deepEqual([m.x, m.ox, m.oy], [SNAP_PX + 1, 0, 0]);
  m.correct(SNAP_PX + 1 + 30, 0);
  assert.equal(m.ox, -30, "a server-steered step fades in");
  m.correct(1000, 0);
  assert.deepEqual([m.x, m.ox], [1000, 0], "a far one jumps");
});

test("LocalMotion.reset (spawn, teleport) drops the offset and the inputs in flight", () => {
  const m = new LocalMotion();
  m.reset(0, 0);
  const s = m.record();
  m.correct(10, 0);
  m.reset(500, 500);
  assert.deepEqual([m.x, m.y, m.ox, m.oy], [500, 500, 0, 0]);
  assert.equal(m.ack(s, 500, 500), false, "no record left: compared with the live position");
  assert.equal(m.seq, s, "sequence numbers keep counting");
});

test("LocalMotion.blend fades the offset, but never draws a step back against the held direction", () => {
  const dt = 1 / 60, speed = 72, k = 1 - Math.exp(-dt / 0.12);
  const lim = 0.6 * speed * Math.SQRT1_2 * dt;
  const m = new LocalMotion();
  m.ox = 10;
  m.blend(dt, -1, 0, speed);
  close(m.ox, 10 - 10 * k, "walking left, the fade goes with the walk: uncapped");
  m.ox = 10;
  m.blend(dt, 1, 0, speed);
  close(m.ox, 10 - lim, "walking right it would pull back: capped below walking speed");
  m.ox = 0.01;
  m.oy = 0.01;
  m.blend(dt, 0, 0, speed);
  assert.deepEqual([m.ox, m.oy], [0, 0], "a vanishing offset is dropped");
  let n = 0;
  m.ox = -50;
  while (m.ox && n < 1000) { m.blend(dt, 1, 0, speed); n++; }
  assert.ok(n < 120, `a 50 px offset is gone within two seconds (${n} frames)`);
});

const remote = (x: number, y: number): Remote => ({ tx: x, ty: y, ox: 0, oy: 0, dx: 0, dy: 0, x, y });

test("retarget keeps a remote person's picture continuous, unless the jump is too large", () => {
  const e = remote(100, 100);
  retarget(e, 110, 100);
  assert.deepEqual([e.tx, e.ox, e.x], [110, -10, 100], "drawn where they were");
  retarget(e, 110 + REMOTE_SNAP_PX + 11, 100);
  assert.deepEqual([e.tx, e.ox], [110 + REMOTE_SNAP_PX + 11, 0], "a far jump");
});

test("stepRemote walks a remote person on (walls stop them, rooms do not) and fades the offset", () => {
  const g = { ...ROOM, deny: new Set([0]) };
  const e = remote(mid(2), mid(3));
  e.dy = 1;
  e.ox = 8;
  const dt = 0.1;
  stepRemote(e, g, dt, 72);
  close(e.ty, mid(3) + 7.2, "walked into the room");
  close(e.ox, 8 * Math.exp(-dt / OFFSET_TAU), "offset faded");
  close(e.x, e.tx + e.ox, "drawn at truth + offset");
  const w = remote(mid(5), mid(1));
  w.dx = 1;
  stepRemote(w, g, 1, 72);
  assert.equal(w.tx, 6 * T - BOX_HW, "stopped at the wall");
  const still = remote(10, 10);
  still.ox = 4;
  stepRemote(still, g, dt, 72);
  assert.equal(still.tx, 10, "standing still: no walk");
  assert.ok(still.ox < 4);
});
