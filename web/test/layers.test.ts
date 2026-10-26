// The world view's layer loop and render-on-demand decision (layer.ts), the signboard's slide (labelLayer.ts)
// and LocalPlayer (localPlayer.ts). Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import "./tsResolve.ts";
import { IDLE_RENDER_MS, shouldRender, updateLayers, type Layer } from "../src/game/layer.ts";

/** A layer that records its updates in `log` and reports `changed`. */
function layer(name: string, log: string[], changed: () => boolean): Layer {
  return { init() {}, update: (dt, now) => { log.push(`${name}@${now}:${dt}`); return changed(); }, destroy() {} };
}

test("updateLayers updates every layer in array order with the same dt and now", () => {
  const log: string[] = [];
  const layers = [layer("map", log, () => false), layer("avatars", log, () => false), layer("hud", log, () => false)];
  assert.equal(updateLayers(layers, 0.016, 1000), false, "nothing changed");
  assert.deepEqual(log, ["map@1000:0.016", "avatars@1000:0.016", "hud@1000:0.016"]);
});

test("updateLayers is true when any layer changed, and still updates the layers after it", () => {
  const log: string[] = [];
  const layers = [layer("a", log, () => true), layer("b", log, () => false), layer("c", log, () => false)];
  assert.equal(updateLayers(layers, 0.1, 5), true);
  assert.equal(log.length, 3, "a change does not cut the loop short: later layers still move their sprites");
  const last: string[] = [];
  assert.equal(updateLayers([layer("a", last, () => false), layer("b", last, () => false), layer("z", last, () => true)], 0.1, 5), true, "the last one counts too");
});

test("updateLayers over no layers changes nothing", () => {
  assert.equal(updateLayers([], 0.016, 0), false);
});

test("shouldRender draws a changed frame at once, an unchanged one only on the idle heartbeat", () => {
  assert.equal(shouldRender(true, 1000, 999), true, "a change draws now");
  assert.equal(shouldRender(false, 1000, 1000 - IDLE_RENDER_MS + 1), false, "unchanged within the heartbeat: no draw");
  assert.equal(shouldRender(false, 1000, 1000 - IDLE_RENDER_MS), true, "heartbeat due: draw");
  assert.equal(IDLE_RENDER_MS, 250, "the heartbeat stays at 4 frames a second");
});

test("an idle second draws only the heartbeat, a changing one draws every frame", () => {
  // 60 frames of 1000/60 ms each, as the ticker calls frame()
  const count = (changed: (i: number) => boolean) => {
    let last = 0, n = 0;
    for (let i = 1; i <= 60; i++) {
      const now = (i * 1000) / 60;
      if (shouldRender(changed(i), now, last)) { last = now; n++; }
    }
    return n;
  };
  assert.equal(count(() => false), 4, "idle: the 250 ms heartbeat only");
  assert.equal(count(() => true), 60, "walking: every frame");
});

// ---- the pure parts of the layers that node can run (PixiJS text needs a DOM) ----
const { bannerSlide } = await import("../src/game/labelLayer.ts");
const { LocalPlayer } = await import("../src/game/localPlayer.ts");

test("bannerSlide: hidden before and after its 2.6 s, slides in and out over 260 ms, eased", () => {
  assert.equal(bannerSlide(-1), -1, "not yet");
  assert.equal(bannerSlide(2601), -1, "gone: the label layer stops asking for frames");
  assert.equal(bannerSlide(0), 0, "starts above the screen");
  assert.equal(bannerSlide(130), 0.75, "half the slide time is three quarters of the way (ease out)");
  assert.equal(bannerSlide(1000), 1, "holds fully in");
  assert.equal(bannerSlide(2600), 0, "back out at the end");
});

/** A LocalPlayer on no map (free movement), with the hooks it calls recorded. */
function player() {
  const sent: [number, number, boolean][] = [], areas: string[] = [], runs: boolean[] = [], banners: string[] = [];
  const ctx = { map: null, grid: { w: 0, h: 0, solid: new Uint8Array(0), areaAt: new Int16Array(0), deny: new Set() }, cam: { panX: 7, panY: 7 }, shownOf: new Int16Array(0), nameOf: () => undefined };
  const p = new LocalPlayer(ctx as never, {
    sendInput: (_s: number, dx: number, dy: number, run: boolean) => { sent.push([dx, dy, run]); },
    onArea: (name: string) => { areas.push(name); },
    onRun: (on: boolean) => { runs.push(on); },
  }, (name: string) => { banners.push(name); });
  return { p, ctx, sent, areas, runs, banners };
}

test("LocalPlayer: a held direction is sent at once, then again every 400 ms, never while the server steers", () => {
  const { p, sent } = player();
  p.setMe(100, 100, 72, 2);
  p.setDirection(1, 0);
  assert.deepEqual(sent, [[1, 0, false]]);
  const t0 = performance.now();
  p.update(0.016, t0 + 100);
  assert.equal(sent.length, 1, "no heartbeat within 400 ms");
  p.update(0.016, t0 + 450);
  assert.equal(sent.length, 2, "the heartbeat re-sends what is held");
  p.setGuided(true, true);
  p.update(0.016, t0 + 2000);
  assert.equal(sent.length, 2, "a walk the server steers sends nothing on its own");
  assert.equal(p.steering, true, "it still recentres the camera");
});

test("LocalPlayer: setMe recentres the camera; update gives where I am drawn", () => {
  const { p, ctx } = player();
  p.setMe(40, 60, 72, 2);
  assert.deepEqual([ctx.cam.panX, ctx.cam.panY], [0, 0]);
  p.update(0.016, performance.now());
  assert.deepEqual([p.rx, p.ry], [40, 60]);
  assert.equal(p.steering, false, "standing still: the camera keeps a pan");
});

test("LocalPlayer: a held key cancels a walk-to; the server stopping a walk clears it and stops me", () => {
  const { p } = player();
  p.setMe(100, 100, 72, 2);
  p.goTo(3, 4);
  assert.deepEqual(p.dest, { x: 56, y: 72 });
  p.setDirection(0, 1);
  assert.equal(p.dest, null);
  p.goTo(3, 4);
  p.setGuided(true, true);
  p.setGuided(false, true);
  assert.equal(p.dest, null);
  assert.deepEqual([p.dx, p.dy, p.guided], [0, 0, false]);
});

test("LocalPlayer: Shift inverts always-run; a change while moving is sent at once", () => {
  const { p, sent, runs } = player();
  p.setMe(100, 100, 72, 2);
  p.toggleRun(true);
  assert.equal(p.running, true);
  assert.equal(sent.length, 0, "standing still: sent with the next input");
  p.setDirection(-1, 0);
  assert.deepEqual(sent.at(-1), [-1, 0, true]);
  p.setRunHeld(true);
  assert.equal(p.running, false, "Shift with always-run on walks");
  assert.deepEqual(sent.at(-1), [-1, 0, false]);
  assert.deepEqual(runs, [true, false]);
});
