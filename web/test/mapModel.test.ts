// The map as the page models it: props' footprints and solidity agree with the server's table
// (server/internal/gamemap/map.go), the collision grid computed the server's way, the wire format of a save,
// and the office helpers of net/protocol.ts. Run: node --test web/test
import "./tsResolve.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROP_DEFS } from "../src/game/props.ts";
import { isMyOffice, isOwnedOffice, type Area, type MapData } from "../src/net/protocol.ts";

const { computeSolid, toWire, PROP_TYPES } = await import("../src/game/mapModel.ts");

test("every prop's default size and solidity are the server's (client prediction and server collisions agree)", () => {
  const go = readFileSync(new URL("../../server/internal/gamemap/map.go", import.meta.url), "utf8");
  const consts = new Map([...go.matchAll(/(Prop\w+)\s*=\s*"(\w+)"/g)].map((m) => [m[1], m[2]]));
  const table = go.slice(go.indexOf("var propDefaults"), go.indexOf("\n}\n", go.indexOf("var propDefaults")));
  const server = new Map<string, { w: number; h: number; solid: boolean }>();
  for (const m of table.matchAll(/^\s*(?:"(\w+)"|(Prop\w+)):\s*\{(\d+), (\d+), (true|false)\}/gm)) {
    const name = m[1] ?? consts.get(m[2]);
    assert.ok(name, "a known constant: " + m[2]);
    server.set(name, { w: Number(m[3]), h: Number(m[4]), solid: m[5] === "true" });
  }
  assert.ok(server.size >= 20, `parsed the server's table (${server.size} kinds)`);
  assert.deepEqual(new Map(PROP_DEFS.map((p) => [p.t, { w: p.w, h: p.h, solid: p.solid }])), server);
});

const map = (o: Partial<MapData> = {}): MapData => ({
  version: 1, tile: 16, w: 6, h: 4, walls: ["######", "#....#", "#....#", "######"], solid: [], props: [], areas: [], spawn: { x: 1, y: 1 }, ...o,
});

test("computeSolid: walls, then the footprint of solid props only, clipped to the map", () => {
  const m = map({
    props: [
      { t: "desk", x: 1, y: 1 }, // 2x1 by default
      { t: "chair", x: 1, y: 2 }, // never solid
      { t: "plant", x: 4, y: 2, w: 1, h: 1 },
      { t: "table", x: 4, y: 3 }, // 3x2 from the bottom wall: off the map past its edge
      { t: "hq-chess/chessboard", x: 3, y: 2, w: 1, h: 1 }, // a plugin object never blocks
    ],
  });
  assert.deepEqual(computeSolid(m), ["111111", "111001", "100011", "111111"]);
});

test("toWire keeps only what PUT /api/map accepts", () => {
  const m = map({ solid: ["x"], props: [{ t: "desk", x: 1, y: 1 }] });
  assert.deepEqual(Object.keys(toWire(m)).sort(), ["areas", "h", "props", "spawn", "version", "w", "walls"]);
});

test("the editor offers every built-in prop but the pc, each with a label", () => {
  assert.ok(!PROP_TYPES.some((p) => p.t === "pc"));
  assert.equal(PROP_TYPES.length, PROP_DEFS.length - 1);
  const raw = PROP_TYPES.filter((p) => !p.label || p.label === p.t);
  assert.deepEqual(raw, [], "a label, not the raw type name");
});

const room = (access: Area["access"], kind = "room"): Area => ({ id: "a", name: "Office 2", kind, x: 0, y: 0, w: 2, h: 2, floor: "wood", access });

test("an owned office is a room in office mode with owners; it is mine when I am one of them", () => {
  assert.equal(isOwnedOffice(room({ mode: "office", users: [4, 7] })), true);
  assert.equal(isOwnedOffice(room({ mode: "office" })), false, "no owner yet");
  assert.equal(isOwnedOffice(room({ mode: "office", users: [] })), false);
  assert.equal(isOwnedOffice(room({ mode: "members", users: [4] })), false, "a list of members is not ownership");
  assert.equal(isOwnedOffice(room({ mode: "office", users: [4] }, "zone")), false, "a zone is never an office");
  assert.equal(isMyOffice(room({ mode: "office", users: [4, 7] }), 7), true);
  assert.equal(isMyOffice(room({ mode: "office", users: [4, 7] }), 5), false);
});
