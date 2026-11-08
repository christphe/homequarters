// The labels drawn on the map (game/labelLayer.ts) show a lock on a desk or an area that is locked against me (the
// rooms the server denies me, grid.deny), and none otherwise. Who may lock and who walks in anyway: world
// TestADeskOwnerLocksTheirDeskAndAlwaysWalksIn and TestLockingKnockingAndAnswering. Run: pnpm exec vitest run (in web/)
import { test } from "vitest";
import assert from "node:assert/strict";
import type { Area } from "../src/net/protocol.ts";

const { areaLabelText, deskLabelText } = await import("../src/game/labelLayer.ts");

const nameOf = (id: number) => (id === 4 ? "Ana" : undefined);
const desk = { t: "desk", x: 20, y: 3, assign: 4 };
const room: Area = { id: "horizon", name: "Horizon", kind: "room", x: 0, y: 0, w: 4, h: 4, floor: "wood", access: { mode: "open" } };

test("a desk whose room is locked against me shows a lock after its owner's name; unlocked, none", () => {
  assert.equal(deskLabelText(desk, 5, nameOf, new Set([5])), "Ana's desk 🔒");
  assert.equal(deskLabelText(desk, 5, nameOf, new Set([2])), "Ana's desk", "another room's lock");
  assert.equal(deskLabelText(desk, 5, nameOf, new Set()), "Ana's desk");
});

test("an area locked against me shows a lock after its name", () => {
  assert.equal(areaLabelText(room, 3, nameOf, new Set([3])), "Horizon 🔒");
  assert.equal(areaLabelText(room, 3, nameOf, new Set()), "Horizon");
});
