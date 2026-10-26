// How desks and offices are named on screen (game/places.ts): from the owner names the server sends, never a
// name stored in the map. Run: node --test web/test
import "./tsResolve.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Area } from "../src/net/protocol.ts";

const { areaTitle, deskTitle, ownerMap } = await import("../src/game/places.ts");

const names = ownerMap({ "4": "Ana", "7": "Bo" });
const nameOf = (id: number) => names.get(id);
const area = (o: Partial<Area>): Area => ({ id: "a", name: "Office 2", kind: "room", x: 0, y: 0, w: 2, h: 2, floor: "wood", access: { mode: "open" }, ...o });

test("ownerMap keys the server's names by number", () => {
  assert.deepEqual([...names], [[4, "Ana"], [7, "Bo"]]);
  assert.equal(ownerMap(undefined).size, 0);
});

test("an assigned desk is its owner's; a free one shows its own label, or nothing", () => {
  assert.equal(deskTitle({ t: "desk", x: 1, y: 1, assign: 4, label: "Window desk" }, nameOf), "Ana's desk");
  assert.equal(deskTitle({ t: "desk", x: 1, y: 1, label: "Window desk" }, nameOf), "Window desk");
  assert.equal(deskTitle({ t: "desk", x: 1, y: 1, assign: 99, label: "Window desk" }, nameOf), "Window desk", "an owner whose name is not known yet");
  assert.equal(deskTitle({ t: "desk", x: 1, y: 1 }, nameOf), "");
});

test("a desk room is named after its owner; an owned office lists its owners after its name", () => {
  assert.equal(areaTitle(area({ auto: true, access: { mode: "office", users: [7] } }), nameOf), "Bo's desk");
  assert.equal(areaTitle(area({ access: { mode: "office", users: [4, 7] } }), nameOf), "Office 2 · Ana, Bo");
  assert.equal(areaTitle(area({ access: { mode: "office", users: [4, 99] } }), nameOf), "Office 2 · Ana", "unknown names are left out");
  assert.equal(areaTitle(area({ access: { mode: "office", users: [99] } }), nameOf), "Office 2", "no name known: the area's own");
  assert.equal(areaTitle(area({ access: { mode: "members", users: [4] } }), nameOf), "Office 2", "a members list does not rename a room");
  assert.equal(areaTitle(area({}), nameOf), "Office 2");
});
