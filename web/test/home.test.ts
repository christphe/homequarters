// Ctrl+D / Cmd+D: where "go back to my desk" leads. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimableDesk, homeTile, isBusyKey, isHomeKey } from "../src/game/home.ts";
import type { MapData } from "../src/net/protocol.ts";

// 8x6 room: walls around, a 2x1 desk at (2,2) assigned to 7, a private office (5..6, 1..4) owned by 9
const solid = ["11111111", "10000001", "10110001", "10000001", "10000001", "11111111"];
const map = {
  version: 1, tile: 16, w: 8, h: 6, walls: solid, solid,
  props: [{ t: "desk", x: 2, y: 2, w: 2, h: 1, assign: 7, label: "Desk of Ana" }],
  areas: [{ id: "office-1", name: "Office 1", kind: "room", x: 5, y: 1, w: 2, h: 4, floor: "wood", access: { mode: "office", users: [9] } }],
} as unknown as MapData;

test("my desk: the free tile on the chair side", () => {
  assert.deepEqual(homeTile(map, 7), { x: 2, y: 3 });
});

test("a blocked chair side falls back to another side of the desk", () => {
  const s = ["11111111", "10000001", "10110001", "10110001", "10000001", "11111111"];
  assert.deepEqual(homeTile({ ...map, solid: s } as MapData, 7), { x: 2, y: 1 });
});

test("no desk: the free tile nearest the middle of my office", () => {
  const t = homeTile(map, 9)!;
  assert.ok(t.x >= 5 && t.x <= 6 && t.y >= 2 && t.y <= 3, JSON.stringify(t));
});

test("nothing assigned: nowhere to go", () => {
  assert.equal(homeTile(map, 3), null);
});

test("Ctrl+D on Windows and Linux, Cmd+D on a Mac, by key position", () => {
  const k = (o: Partial<{ code: string; key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ code: "KeyD", key: "d", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
  assert.equal(isHomeKey(k({ ctrlKey: true }), false), true);
  assert.equal(isHomeKey(k({ metaKey: true }), true), true);
  assert.equal(isHomeKey(k({ ctrlKey: true }), true), false); // Ctrl+D deletes forward in Mac text fields
  assert.equal(isHomeKey(k({ ctrlKey: true, shiftKey: true }), false), false);
  assert.equal(isHomeKey(k({}), false), false);
});

test("in my office, its chair when it has one", () => {
  const withChair = { ...map, props: [...map.props, { t: "chair", x: 6, y: 4 }] } as MapData;
  assert.deepEqual(homeTile(withChair, 9), { x: 6, y: 4 });
});

// A free desk at (2,4) in the open, next to the assigned one; px/py are feet in pixels.
const free = { ...map, props: [...map.props, { t: "desk", x: 2, y: 4, w: 2, h: 1, label: "Desk 2" }] } as MapData;
const chairOfFree = [2 * 16 + 8, 5 * 16 + 8] as const;

test("claim: a free desk next to me, when I have no place", () => {
  assert.equal(claimableDesk(free, 3, ...chairOfFree)?.label, "Desk 2");
});

test("claim: nothing when I already have a desk or an office", () => {
  assert.equal(claimableDesk(free, 7, ...chairOfFree), null);
  assert.equal(claimableDesk(free, 9, ...chairOfFree), null);
});

test("claim: nothing for a taken desk, a desk in a room, or one out of reach", () => {
  assert.equal(claimableDesk(map, 3, 2 * 16 + 8, 3 * 16 + 8), null, "taken");
  const inRoom = { ...map, props: [{ t: "desk", x: 5, y: 2, w: 2, h: 1 }] } as MapData;
  assert.equal(claimableDesk(inRoom, 3, 5 * 16 + 8, 3 * 16 + 8), null, "inside office-1");
  assert.equal(claimableDesk(free, 3, 2 * 16 + 8, 5 * 16 + 8 + 24), null, "two tiles away");
  assert.ok(claimableDesk(free, 3, 2 * 16 + 8, 5 * 16 + 4), "within reach");
});

test("Ctrl+U (Cmd+U on a Mac) toggles busy, by key position", () => {
  const k = (o: Partial<{ code: string; key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ code: "KeyU", key: "u", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
  assert.equal(isBusyKey(k({ ctrlKey: true }), false), true);
  assert.equal(isBusyKey(k({ metaKey: true }), true), true);
  assert.equal(isBusyKey(k({ ctrlKey: true }), true), false);
  assert.equal(isBusyKey(k({ ctrlKey: true, altKey: true }), false), false); // Ctrl+Alt+U is not ours
  assert.equal(isBusyKey(k({ code: "KeyD", key: "d", ctrlKey: true }), false), false);
  assert.equal(isHomeKey(k({ ctrlKey: true }), false), false);
});
