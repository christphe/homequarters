// Which props get a depth sprite (web/src/game/art/objects.ts depthObjects): every desk, and every pc on a desk,
// for the three layouts (web/dev's fixtures, kept equal to the server's templates by gamemap's
// TestArtPreviewFixturesAreTheTemplates). The pixels stay in the browser: e2e/scenarios/depth.ts compares the
// world with and without the depth sprites, and checks who a desk hides. Run: pnpm exec vitest run (in web/)
import { test } from "vitest";
import assert from "node:assert/strict";
import { depthObjects } from "../src/game/art/objects.ts";
import type { MapData } from "../src/net/protocol.ts";
import loft from "../dev/default-map.json" with { type: "json" };
import lodge from "../dev/lodge-map.json" with { type: "json" };
import manor from "../dev/manor-map.json" with { type: "json" };

const count = (m: MapData) => {
  const objs = depthObjects(m);
  return { desks: objs.filter((o) => o.p.t === "desk").length, pcs: objs.filter((o) => o.p.t === "pc").length };
};
const desks = (m: MapData) => m.props.filter((p) => p.t === "desk").length;
const withoutPCs = (m: MapData): MapData => ({ ...m, props: m.props.filter((p) => p.t !== "pc") });

for (const [name, map, n] of [["Loft", loft, 18], ["Lodge", lodge, 36], ["Manor", manor, 48]] as const) {
  const m = map as MapData;
  test(`${name}: a depth sprite for each of its ${n} desks and for the pc on each`, () => {
    assert.equal(desks(m), n);
    assert.deepEqual(count(m), { desks: n, pcs: n });
  });
  test(`${name} saved without pc props (a map from before PCs): a sprite per desk, none for PCs`, () => {
    assert.deepEqual(count(withoutPCs(m)), { desks: n, pcs: 0 });
  });
}

test("a pc sorts by the desk it stands on; a pc on no desk, and anything else, gets no sprite", () => {
  const desk = { t: "desk", x: 4, y: 4 }, turned = { t: "desk", x: 10, y: 4, up: true };
  const m = {
    w: 20, h: 10, props: [
      desk, { t: "pc", x: 5, y: 4 }, // the desk's right tile
      turned, { t: "pc", x: 10, y: 4 },
      { t: "pc", x: 15, y: 8 }, // on the floor
      { t: "chair", x: 4, y: 5 }, { t: "plant", x: 1, y: 1 },
    ],
  } as unknown as MapData;
  assert.deepEqual(depthObjects(m).map((o) => [o.p.t, o.p.x, o.desk]), [["desk", 4, desk], ["pc", 5, desk], ["desk", 10, turned], ["pc", 10, turned]]);
});
