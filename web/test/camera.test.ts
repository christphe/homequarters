// The camera: scale and zoom steps, zoom memory, pan, following, and the interest radius it asks for. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { Camera, MAX_SCALE, VIEW_PAD, autoScale, reachClamp, zoomStore, type ZoomStore } from "../src/game/camera.ts";

// the server's defaults (world.DefaultConfig): 128 px cells, a radius of 2 cells, up to 8 when zoomed out
const CELL = 128, AOI = 2, AOI_MAX = 8;
const SMALL = [800, 450] as const; // E2E_VIEWPORT=small, CI's viewport

/** A ZoomStore in memory; `writes` lists what was remembered. */
function memory(start = 0): ZoomStore & { writes: number[] } {
  const writes: number[] = [];
  return { writes, read: () => start, write: (z) => { writes.push(z); } };
}
function camera(start = 0) {
  const store = memory(start);
  return { cam: new Camera(store), store };
}

test("autoScale: the reference view by a whole number, from 2 to 6", () => {
  assert.equal(autoScale(...SMALL), 2);
  assert.equal(autoScale(1280, 720), 3);
  assert.equal(autoScale(1920, 1080), 5);
  assert.equal(autoScale(320, 200), 2, "never under 2");
  assert.equal(autoScale(4000, 3000), 6, "never over 6");
});

test("before hello only the automatic scale and closer: the remembered zoom out waits for the limits", () => {
  const { cam, store } = camera(-3);
  assert.deepEqual(cam.range(...SMALL), [2, MAX_SCALE]);
  assert.equal(cam.fit(...SMALL), 2, "a remembered zoom out cannot apply yet");
  assert.equal(cam.zoomBy(1, ...SMALL), 2, "-3 + 1: still clamped");
  assert.equal(cam.zoom, -2, "the remembered steps are kept until the limits are known");
  assert.deepEqual(store.writes, [], "nothing remembered before hello");
  cam.setInterest(CELL, AOI, AOI_MAX);
  assert.equal(cam.fit(...SMALL), 1, "with the limits known it applies, as far as they allow");
});

test("zoom bounds at 800x450: out to 1 (the largest radius covers half the view), in to MAX_SCALE", () => {
  const { cam, store } = camera();
  cam.setInterest(CELL, AOI, AOI_MAX);
  assert.deepEqual(cam.range(...SMALL), [1, MAX_SCALE]);
  assert.equal(cam.fit(...SMALL), 2);
  assert.equal(cam.zoomBy(-5, ...SMALL), 1, "out stops at the limit");
  assert.equal(cam.zoom, -1, "steps past a limit are forgotten");
  assert.equal(cam.zoomBy(1, ...SMALL), 2, "so one step in comes straight back");
  assert.equal(cam.zoomBy(20, ...SMALL), MAX_SCALE);
  assert.equal(cam.zoom, MAX_SCALE - 2);
  assert.deepEqual(store.writes, [-1, 0, MAX_SCALE - 2], "every step is remembered");
});

test("a narrow largest radius keeps the farthest zoom at the automatic scale", () => {
  const { cam } = camera();
  cam.setInterest(CELL, 2, 2);
  assert.deepEqual(cam.range(...SMALL), [2, MAX_SCALE], "half of 800 px needs 400 world px at scale 1; 2 cells reach 232");
  cam.setInterest(CELL, 3, 1);
  assert.equal(cam.aoiMax, 3, "aoiMax is never under aoi");
});

test("the zoom is remembered in storage, and a blocked storage only means no memory", () => {
  const data = new Map<string, string>();
  const ok = zoomStore(() => ({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } }));
  assert.equal(ok.read(), 0, "nothing stored");
  ok.write(-2);
  assert.equal(data.get("hq.zoom"), "-2");
  assert.equal(ok.read(), -2);
  data.set("hq.zoom", "1.6");
  assert.equal(ok.read(), 2, "rounded");
  data.set("hq.zoom", "junk");
  assert.equal(ok.read(), 0, "garbage reads as no zoom");
  const blocked = zoomStore(() => { throw new Error("SecurityError"); });
  assert.equal(blocked.read(), 0);
  assert.doesNotThrow(() => blocked.write(3));
  assert.equal(new Camera(zoomStore(() => ({ getItem: () => "-1", setItem: () => {} }))).zoom, -1, "a new camera starts from the remembered zoom");
});

test("follow centres on me, stops at the map's edges and moves only in whole pixels", () => {
  const { cam } = camera();
  cam.fit(...SMALL); // S = 2
  const [W, H] = SMALL, mapW = 60 * 16, mapH = 40 * 16;
  assert.equal(cam.follow(W, H, 300.4, 200, mapW, mapH), true);
  assert.deepEqual([cam.x, cam.y], [Math.round(400 - 300.4 * 2), 225 - 400]);
  assert.equal(cam.follow(W, H, 300.4, 200, mapW, mapH), false, "not moved");
  cam.follow(W, H, -50, 2000, mapW, mapH);
  assert.deepEqual([cam.x, cam.y], [400, 225 - mapH * 2], "the middle of the screen stays on the map");
  cam.panX = 40;
  cam.follow(W, H, 300, 200, mapW, mapH);
  assert.equal(cam.x, 400 - 340 * 2, "a pan moves the view");
});

test("panTo is the inverse of follow away from the edges", () => {
  const { cam } = camera();
  cam.fit(1280, 720); // S = 3
  cam.panTo(100, -50, 1280, 720, 500, 400);
  cam.follow(1280, 720, 500, 400, 100 * 16, 100 * 16);
  assert.deepEqual([cam.x, cam.y], [100, -50]);
});

test("reachClamp keeps the visible map within reach, or centres on me when the window is wider than the reach", () => {
  const W = 800, S = 1, map = 2000;
  assert.equal(reachClamp(-600, W, S, 1000, 500, map), -600, "everything visible is within reach: unchanged");
  assert.equal(reachClamp(0, W, S, 1000, 500, map), -500, "the map's near end out of reach: pulled in");
  assert.equal(reachClamp(-900, W, S, 1000, 500, map), -700, "the far end out of reach: pulled in");
  assert.equal(reachClamp(0, W, S, 100, 1000, map), 0, "near the map's start the margin is allowed");
  assert.equal(reachClamp(0, W, S, 1000, 300, map), W / 2 - 1000, "wider than 2R: centred on me");
});

test("follow, zoomed far out next to a map edge, shows no map beyond the largest radius", () => {
  const { cam } = camera();
  cam.setInterest(CELL, AOI, 2); // reach 232 px
  cam.zoom = -10;
  const [W, H] = [1920, 1080];
  const S = cam.fit(W, H);
  const mapW = 200 * 16, mapH = 100 * 16, px = 40, py = 800;
  cam.follow(W, H, px, py, mapW, mapH);
  const right = Math.min(mapW, (W - cam.x) / S) - px;
  assert.ok(right <= 2 * CELL - VIEW_PAD + 1, `visible map ${right} px to my right`);
});

test("view asks the server for the radius the visible map needs, once per change, steady while walking", () => {
  const { cam } = camera();
  const [W, H] = SMALL, mapW = 100 * 16, mapH = 60 * 16;
  assert.equal(cam.view(W, H, 400, 300, mapW, mapH), -1, "before hello: nothing to ask");
  cam.setInterest(CELL, AOI, AOI_MAX);
  cam.fit(W, H); // S = 2: 200 world px each way horizontally
  cam.follow(W, H, 800, 480, mapW, mapH);
  assert.equal(cam.view(W, H, 800, 480, mapW, mapH), AOI, "a new connection is told even the default");
  assert.equal(cam.view(W, H, 800, 480, mapW, mapH), -1, "then only changes");
  // walking across cell boundaries does not flip the request
  for (let x = 800; x < 1100; x += 7) {
    cam.follow(W, H, x, 480, mapW, mapH);
    assert.equal(cam.view(W, H, x, 480, mapW, mapH), -1, `at x=${x}`);
  }
  cam.zoomBy(-1, W, H); // S = 1: 400 world px each way
  cam.follow(W, H, 800, 480, mapW, mapH);
  assert.equal(cam.view(W, H, 800, 480, mapW, mapH), Math.ceil((400 + VIEW_PAD) / CELL), "zoomed out: wider");
  cam.zoomBy(1, W, H);
  cam.follow(W, H, 800, 480, mapW, mapH);
  assert.equal(cam.view(W, H, 800, 480, mapW, mapH), AOI, "and back");
  cam.setInterest(CELL, AOI, AOI_MAX);
  assert.equal(cam.view(W, H, 800, 480, mapW, mapH), AOI, "a reconnection asks again");
});
