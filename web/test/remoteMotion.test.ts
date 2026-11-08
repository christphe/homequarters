// Remote people from the server's state records (motion.ts applyRecord, remoteSpeed, stepRemote), fed the records
// a runner's server sends, late, frame by frame as AvatarLayer.update does. It replaces the browser checks "others
// extrapolate a runner at run speed and agree on where it stops" (movement) and "the leader sees the follower run"
// (features); the server's half is world TestRunningDoublesSpeedAndIsCarriedInTheStateRecord,
// TestShadowMatchesTheServerWhileRunning and TestDeadReckoningSendsStateChangesNotEveryTick. The browser keeps the
// movement scenario's jitter checks (a runner seen by another page converges on where it stopped).
// Run: pnpm exec vitest run (in web/)
import { test } from "vitest";
import assert from "node:assert/strict";
import { applyRecord, moveBody, remoteSpeed, stepRemote, type Grid, type RemoteState } from "../src/game/motion.ts";

const T = 16;
const mid = (t: number) => t * T + T / 2;
const OPEN: Grid = { w: 40, h: 10, solid: new Uint8Array(400), areaAt: new Int16Array(400).fill(-1), deny: new Set() };
const blank = (): RemoteState => ({ tx: 0, ty: 0, ox: 0, oy: 0, dx: 0, dy: 0, x: 0, y: 0, dir: 0, run: false, moving: false });

/** The d byte of a record as world.go's Player.rec writes it. */
const rec = (dir: number, dx: number, dy: number, run: boolean) => dir | (dx + 1) << 2 | (dy + 1) << 4 | (run ? 1 << 6 : 0);

test("a record tells which way a person faces and moves, and whether they run; a stopped one never runs", () => {
  const e = blank();
  applyRecord(e, 100, 60, rec(2, 1, -1, true), true);
  assert.deepEqual({ x: e.x, y: e.y, tx: e.tx, ty: e.ty, dir: e.dir, dx: e.dx, dy: e.dy, run: e.run, moving: e.moving },
    { x: 100, y: 60, tx: 100, ty: 60, dir: 2, dx: 1, dy: -1, run: true, moving: true }, "a newcomer is placed where the record says");
  assert.equal(remoteSpeed(e, 72, 2), 144, "a runner goes at run speed");
  applyRecord(e, 104, 60, rec(1, 0, 0, false), false);
  assert.deepEqual({ dir: e.dir, dx: e.dx, dy: e.dy, run: e.run, moving: e.moving }, { dir: 1, dx: 0, dy: 0, run: false, moving: false });
  assert.equal(remoteSpeed(e, 72, 2), 72);
  assert.equal(e.x, 100, "a later record keeps the picture where it was; the difference fades out");
});

/**
 * A runner on the server, from x0 to the right at speed*runMul for runMs, then stopped. The server sends a record
 * when the run starts and when it stops (its dead reckoning matches the clients'), each arriving `lagMs` late; the
 * client steps the person every 60 Hz frame. Returns the drawn x and the server's x at every frame.
 */
function watchARunner(runMs: number, lagMs: number, untilMs: number) {
  const speed = 72, runMul = 2, x0 = mid(3), y = mid(5);
  const truthAt = (ms: number) => x0 + speed * runMul * Math.min(ms, runMs) / 1000;
  const records = [
    { at: lagMs, x: x0, d: rec(2, 1, 0, true) },
    { at: runMs + lagMs, x: Math.round(truthAt(runMs)), d: rec(2, 0, 0, false) }, // positions go out rounded to whole pixels
  ];
  const e = blank();
  let seen = false;
  const frames: { ms: number; drawn: number; truth: number }[] = [];
  const dt = 1000 / 60;
  for (let ms = 0; ms <= untilMs; ms += dt) {
    while (records.length && records[0].at <= ms) {
      const r = records.shift()!;
      applyRecord(e, r.x, y, r.d, !seen);
      seen = true;
    }
    if (seen) stepRemote(e, OPEN, dt / 1000, remoteSpeed(e, speed, runMul));
    if (seen) frames.push({ ms, drawn: e.x, truth: truthAt(ms) });
  }
  return { frames, stop: truthAt(runMs), e };
}

test("a runner seen by others keeps pace with the server, only as far behind as the records are late", () => {
  const lag = 60, { frames } = watchARunner(450, lag, 450);
  const behind = Math.max(...frames.filter((f) => f.ms > 100).map((f) => f.truth - f.drawn));
  // at walking speed it would fall 72 px/s behind: 25 px by the time the stop leaves the server
  assert.ok(behind <= 144 * lag / 1000 + 0.5, `fell ${behind.toFixed(1)} px behind (the lag alone is ${(144 * lag / 1000).toFixed(1)} px)`);
});

test("...and comes to rest where the server stopped it, without overshooting on", () => {
  const { frames, stop, e } = watchARunner(450, 60, 1100);
  const last = frames.at(-1)!;
  assert.ok(Math.abs(last.drawn - stop) < 1, `rests at ${last.drawn.toFixed(2)}, the server stopped at ${stop.toFixed(2)}`);
  assert.equal(e.moving, false);
  const furthest = Math.max(...frames.map((f) => f.drawn));
  assert.ok(furthest <= stop + 1, `drawn at most 1 px past the stop, got ${(furthest - stop).toFixed(2)}`);
});

test("a runner's extrapolation follows the server's own walk rule (moveBody), wall included", () => {
  // the server's shadow (TestShadowMatchesTheServerWhileRunning) and the client both integrate moveBody: a runner
  // towards a wall at column 10 stops touching it on both
  const g: Grid = { ...OPEN, solid: new Uint8Array(400) };
  for (let y = 0; y < 10; y++) g.solid[y * 40 + 10] = 1;
  const e = blank();
  applyRecord(e, mid(7), mid(5), rec(2, 1, 0, true), true);
  for (let i = 0; i < 60; i++) stepRemote(e, g, 1 / 60, remoteSpeed(e, 72, 2));
  const server = { x: mid(7), y: mid(5) };
  moveBody(g, server, 1, 0, 144, null);
  assert.equal(e.tx, server.x);
  assert.equal(e.tx, 10 * T - 5, "flush against the wall");
});
