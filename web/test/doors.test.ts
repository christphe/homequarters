// Which door and desk buttons the page offers (game/doors.ts, shown by ui/SocialControls.tsx): Lock and
// Release desk in the room I stand in, Knock and Enter anyway at a closed door. Run: pnpm exec vitest run (in web/)
import { test } from "vitest";
import assert from "node:assert/strict";
import { doorAt, roomActions } from "../src/game/doors.ts";
import type { Area, MapData } from "../src/net/protocol.ts";

const room = (o: Partial<Area>): Area => ({ id: "r", name: "Room", kind: "room", x: 0, y: 0, w: 4, h: 4, floor: "wood", access: { mode: "open" }, ...o });
// a hall (0), Office 2 owned by 7 (1), a free Office 3 (2), the desk room of 8's desk at (20,2) (3), a zone (4)
const map = {
  version: 1, tile: 16, w: 30, h: 12, walls: [], solid: [],
  props: [{ t: "desk", x: 20, y: 2, w: 2, h: 1, assign: 8 }, { t: "desk", x: 24, y: 2, w: 2, h: 1 }],
  areas: [
    { id: "hall", name: "Offices hall", kind: "zone", x: 0, y: 0, w: 14, h: 2, floor: "wood", access: { mode: "open" } },
    room({ id: "office-2", name: "Office 2", x: 0, y: 3, w: 6, h: 6, access: { mode: "office", users: [7] } }),
    room({ id: "office-3", name: "Office 3", x: 8, y: 3, w: 6, h: 6, access: { mode: "office" } }),
    room({ id: "desk-20-2", name: "Desk", x: 20, y: 2, w: 2, h: 3, auto: true, access: { mode: "open", users: [8] } }), // as Compile makes it
    { id: "zone", name: "Lounge", kind: "zone", x: 16, y: 6, w: 4, h: 4, floor: "wood", access: { mode: "open" } },
  ],
} as unknown as MapData;

test("an assigned office offers its owner no Lock button: it is always closed to strangers", () => {
  const r = roomActions(map, 1, 7, "member");
  assert.equal(r.room?.id, "office-2");
  assert.equal(r.lockable, false);
  assert.equal(roomActions(map, 1, 9, "admin").lockable, false, "nor an administrator let in");
});

test("a free office, like a meeting room, can be locked from inside by anybody", () => {
  assert.equal(roomActions(map, 2, 9, "member").lockable, true);
  assert.equal(roomActions({ ...map, areas: [...map.areas, room({ id: "m" })] }, 5, 9, "member").lockable, true);
});

test("my desk room: Lock desk and Release desk", () => {
  const r = roomActions(map, 3, 8, "member");
  assert.equal(r.lockable, true);
  assert.deepEqual(r.myDesk, map.props[0]);
});

test("someone else's desk room: only the owner gets Release desk; an administrator may lock it", () => {
  assert.deepEqual(roomActions(map, 3, 9, "member"), { room: map.areas[3], lockable: false, myDesk: null });
  assert.deepEqual(roomActions(map, 3, 9, "admin"), { room: map.areas[3], lockable: true, myDesk: null });
});

test("outside a room: no Lock, no Release", () => {
  for (const here of [-1, 0, 4]) assert.deepEqual(roomActions(map, here, 8, "admin"), { room: null, lockable: false, myDesk: null });
  assert.deepEqual(roomActions(null, 1, 7, "member"), { room: null, lockable: false, myDesk: null });
});

// standing in the hall, 24 px above Office 2 (its top edge is at y 48)
const atDoor = [3 * 16, 24] as const;

test("at a door the server keeps me out of, a member gets Knock and no Enter anyway", () => {
  const d = doorAt(map, [1], 0, "member", ...atDoor);
  assert.equal(d?.index, 1);
  assert.equal(d?.area.id, "office-2");
  assert.equal(d?.force, false);
});

test("at that door an administrator gets Knock and Enter anyway", () => {
  const d = doorAt(map, [1], 0, "admin", ...atDoor);
  assert.equal(d?.index, 1);
  assert.equal(d?.force, true);
});

test("no door buttons at an open door, inside the room, or out of reach", () => {
  assert.equal(doorAt(map, [], 0, "admin", ...atDoor), null, "not denied: I may walk in");
  assert.equal(doorAt(map, [1], 1, "admin", ...atDoor), null, "already inside");
  assert.equal(doorAt(map, [1], 0, "admin", 3 * 16, 48 - 41), null, "41 px away");
  assert.equal(doorAt(map, [1], 0, "admin", 3 * 16, 48 - 40)?.index, 1, "40 px away");
});
