// The world view's layer loop and render-on-demand decision (layer.ts). Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
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
