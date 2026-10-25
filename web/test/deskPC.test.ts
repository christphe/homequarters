// A pc on a desk: what erasing a desk takes, and how the depth sprites are packed. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { eraseAt } from "../src/game/props.ts";
import { ATLAS_MAX_H, ATLAS_W, packCells } from "../src/game/art/pack.ts";
import type { Prop } from "../src/net/protocol.ts";

test("eraseAt on a desk takes it with its pcs in one click, whichever tile is clicked", () => {
  const desk: Prop = { t: "desk", x: 2, y: 2 };
  const chair: Prop = { t: "chair", x: 2, y: 3 };
  const other: Prop = { t: "desk", x: 6, y: 2 };
  const props: Prop[] = [desk, chair, other, { t: "pc", x: 2, y: 2, dx: 8 }, { t: "pc", x: 6, y: 2, dx: 8 }];
  assert.equal(eraseAt(props, 2, 2), true); // the pc's own tile: the desk goes too
  assert.deepEqual(props, [chair, other, { t: "pc", x: 6, y: 2, dx: 8 }]);
  assert.equal(eraseAt(props, 7, 2), true); // the other tile of a desk
  assert.deepEqual(props, [chair]);
  assert.equal(eraseAt(props, 2, 3), true); // anything else: the last prop on the tile
  assert.deepEqual(props, []);
  assert.equal(eraseAt(props, 2, 3), false);
});

test("packCells fills rows of the atlas and leaves out what does not fit under its height limit", () => {
  const placed = packCells([{ w: 600, h: 40 }, { w: 500, h: 30 }, { w: 100, h: 20 }]);
  assert.deepEqual(placed, [{ sx: 0, sy: 0 }, { sx: 0, sy: 40 }, { sx: 500, sy: 40 }]);
  // a hostile map: a thousand desks 32 tiles wide (512 px), two per row
  const many = packCells(Array.from({ length: 1000 }, () => ({ w: 512, h: 32 })));
  const kept = many.filter((p) => p !== null);
  assert.ok(kept.length < 1000 && kept.length > 0);
  assert.ok(kept.every((p) => p!.sx + 512 <= ATLAS_W && p!.sy + 32 <= ATLAS_MAX_H));
  assert.equal(packCells([{ w: ATLAS_W + 1, h: 4 }])[0], null);
});
