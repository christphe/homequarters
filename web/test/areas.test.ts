// Areas of the map: which one a point is in, which one is named, and when walking changes them. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { AREA, SAME, SHOWN, Whereabouts, areaGrid, areaIndex, deskRoom, shownArea, shownAreas } from "../src/game/areas.ts";
import type { Area, MapData, Prop } from "../src/net/protocol.ts";

const T = 16;
const area = (id: string, kind: string, x: number, y: number, w: number, h: number, auto?: boolean): Area =>
  ({ id, name: id, kind, x, y, w, h, floor: "wood", access: { mode: "open" }, ...(auto ? { auto } : {}) });

// 12 x 6 tiles: a room listed first but painted over the plain area it overlaps, a desk room inside
// the open space, and a desk room outside every plain area
const office: MapData = {
  version: 1, tile: T, w: 12, h: 6, walls: [], solid: [], props: [], spawn: { x: 0, y: 0 },
  areas: [
    area("meeting", "room", 4, 0, 3, 2), // 0: over the open space's top
    area("open", "area", 0, 0, 8, 6), // 1
    area("desk-2-3", "room", 2, 3, 2, 2, true), // 2: a desk room in the open space
    area("desk-9-4", "room", 9, 4, 2, 2, true), // 3: a desk room outside every plain area
  ],
};
const at = (t: number) => t * T + T / 2; // the middle of tile t (one axis)

test("rooms are painted over plain areas whatever their order", () => {
  const g = { w: office.w, h: office.h, areaAt: areaGrid(office) };
  assert.equal(areaIndex(g, at(5), at(1)), 0, "the meeting room over the open space");
  assert.equal(areaIndex(g, at(5), at(2)), 1, "the open space under it");
  assert.equal(areaIndex(g, at(2), at(3)), 2, "a desk room");
  assert.equal(areaIndex(g, at(10), at(0)), -1, "a tile in no area");
});

test("areaIndex is -1 off the map, and tile edges belong to the tile right/below", () => {
  const g = { w: office.w, h: office.h, areaAt: areaGrid(office) };
  assert.equal(areaIndex(g, -0.01, 8), -1);
  assert.equal(areaIndex(g, 8, -0.01), -1);
  assert.equal(areaIndex(g, office.w * T, 8), -1);
  assert.equal(areaIndex(g, 8, office.h * T), -1);
  assert.equal(areaIndex(g, 4 * T - 0.01, 8), 1, "just left of the room");
  assert.equal(areaIndex(g, 4 * T, 8), 0, "on the room's left edge");
  assert.equal(areaIndex({ w: 0, h: 0, areaAt: new Int16Array(0) }, 0, 0), -1, "no map yet");
});

test("a desk room is named after the plain area around it, other areas after themselves", () => {
  const shown = shownAreas(office);
  assert.deepEqual([...shown], [0, 1, 1, -1]);
  assert.equal(shownArea(shown, 2), 1);
  assert.equal(shownArea(shown, 3), -1, "a desk room in no area names nothing");
  assert.equal(shownArea(shown, -1), -1, "outside every area");
  assert.equal(shownArea(new Int16Array(0), 5), 5, "an index the table does not know yet names itself");
});

test("deskRoom finds the desk room of an assigned desk", () => {
  const desk = { t: "desk", x: 2, y: 3 } as Prop;
  assert.equal(deskRoom(office, desk), 2);
  assert.equal(deskRoom(office, { t: "desk", x: 0, y: 0 } as Prop), -1);
});

test("walking into a desk room changes the area but not the signboard", () => {
  const shown = shownAreas(office);
  const w = new Whereabouts();
  assert.equal(w.enter(1, shown), SHOWN, "into the open space");
  assert.equal(w.shown, 1);
  assert.equal(w.enter(1, shown), SAME, "still there");
  assert.equal(w.enter(2, shown), AREA, "into my desk room: room access changes");
  assert.deepEqual([w.area, w.shown], [2, 1]);
  assert.equal(w.enter(1, shown), AREA, "back out: no signboard");
  assert.equal(w.enter(0, shown), SHOWN, "into the meeting room");
  assert.equal(w.enter(-1, shown), SHOWN, "out of every area: shown becomes -1 (no signboard is drawn for it)");
  assert.equal(w.shown, -1);
  assert.equal(w.enter(3, shown), AREA, "a desk room in no area still names nothing");
});
