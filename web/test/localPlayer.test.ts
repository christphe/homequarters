// My avatar when the server moves it (localPlayer.ts applySelf): a portal's teleport stops me and drops what was
// held, and a follower keeps its leader's pace. It replaces the browser checks "walking onto the portal teleports
// once and stops movement" and the follower's own page running with a leader who runs (features); the server's half
// is world TestPortalsTeleportOncePerArrivalAndNotIntoLockedRooms, TestFollowWalksAroundWallsAndStopsOnInput and
// TestFollowerKeepsTheLeadersPace. The browser keeps a request to lead through the people panel's real menu (features).
// Run: pnpm exec vitest run (in web/)
import { test } from "vitest";
import assert from "node:assert/strict";
import { LocalPlayer } from "../src/game/localPlayer.ts";
import type { MapData, SelfPosition } from "../src/net/protocol.ts";

/** A LocalPlayer on an open 40x20 floor with no areas, recording the inputs it sends. */
function player() {
  const sent: [number, number, boolean][] = [];
  const w = 40, h = 20;
  const ctx = {
    map: { areas: [] } as unknown as MapData,
    grid: { w, h, solid: new Uint8Array(w * h), areaAt: new Int16Array(w * h).fill(-1), deny: new Set<number>() },
    cam: { panX: 0, panY: 0 }, shownOf: new Int16Array(0), nameOf: () => undefined,
  };
  const p = new LocalPlayer(ctx as never, {
    sendInput: (_s: number, dx: number, dy: number, run: boolean) => { sent.push([dx, dy, run]); },
    onArea: () => {},
    onRun: () => {},
  }, () => {});
  p.setMe(100, 100, 72, 2);
  return { p, sent, ctx };
}

const self = (m: Partial<SelfPosition>): SelfPosition => ({ t: "self", x: 0, y: 0, dx: 0, dy: 0, d: 0, r: false, tp: false, ...m });

test("a held key walks at the office's speed, and twice as fast with always-run on (as the server moves me)", () => {
  const { p } = player();
  p.setDirection(1, 0);
  let x0 = p.self.x;
  p.advance(performance.now() + 500);
  const walked = p.self.x - x0;
  p.toggleRun(true);
  x0 = p.self.x;
  p.advance(performance.now() + 500);
  const ran = p.self.x - x0;
  assert.ok(walked >= 36 && walked < 37, `walked ${walked.toFixed(1)} px in 0.5 s (72 px/s)`);
  assert.ok(ran >= 72 && ran < 74, `ran ${ran.toFixed(1)} px in 0.5 s (144 px/s)`);
});

test("a teleport (a portal) puts me there at once and stops me: no key stays held, no correction fades in", () => {
  const { p, ctx } = player();
  ctx.cam.panX = 30;
  p.setDirection(0, 1);
  assert.equal(p.applySelf(self({ x: 584, y: 520, tp: true })), true, "the caller drops the held keys");
  assert.deepEqual([p.dx, p.dy, p.steering], [0, 0, false], "stopped");
  assert.equal(ctx.cam.panX, 0, "the camera recentres");
  p.update(1 / 60, performance.now() + 500);
  assert.deepEqual([p.rx, p.ry], [584, 520], "drawn on the arrival tile, with no offset and no walk on");
});

test("a server-steered step is not a teleport: it walks on along the server's direction", () => {
  const { p } = player();
  p.setGuided(true, false);
  assert.equal(p.applySelf(self({ x: 120, y: 100, dx: 1 })), false);
  assert.deepEqual([p.dx, p.dy], [1, 0]);
});

test("a follower goes at its leader's pace: running while the server says the leader runs, walking again after", () => {
  const { p, sent } = player();
  p.setGuided(true, false); // "fol": following somebody, at their pace
  assert.equal(p.fast, false, "following a walker walks");
  p.applySelf(self({ x: 100, y: 100, dx: 1, r: true }));
  assert.equal(p.fast, true, "the leader runs: so do I, on my own page");
  const x0 = p.self.x;
  p.advance(performance.now() + 500); // half a second on from the step
  const ran = p.self.x - x0;
  assert.ok(ran >= 72 && ran < 74, `predicted at run speed: ${ran.toFixed(1)} px in 0.5 s (walking: 36)`);
  p.applySelf(self({ x: p.self.x, y: 100, dx: 1, r: false }));
  assert.equal(p.fast, false, "the leader walks again");
  p.setGuided(false, false);
  assert.equal(p.fast, false);
  assert.deepEqual(sent, [], "a steered walk sends no input of its own");
});
