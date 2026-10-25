// Plugin objects on the map: which ones the page draws and which one X uses. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DYNAMIC, dynamicObjects, nearestUsable, objectChanges, objectsFor, placedObjects, type PlacedObject, type PluginObjectSpec } from "../src/game/pluginObjects.ts";
import { propSize } from "../src/game/props.ts";
import type { Prop } from "../src/net/protocol.ts";

const CHESSBOARD: PluginObjectSpec = { plugin: "hq-chess", kind: "chessboard", label: "Chessboard", size: [1, 1], sprite: "board.png", frame: [0, 0, 16, 16] };
const board: Prop = { t: "hq-chess/chessboard", x: 10, y: 5, w: 1, h: 1 };
const whiteboard: Prop = { t: "whiteboard", x: 2, y: 5 }; // 3x1 by default: tiles 2-4

test("objectsFor keeps props of running plugins whose kind the manifest declares", () => {
  const props: Prop[] = [board, whiteboard, { t: "desk", x: 0, y: 0 }];
  assert.deepEqual(objectsFor(props, [CHESSBOARD]), [{ prop: board, spec: CHESSBOARD }]);
});

test("objectsFor drops a prop of a stopped plugin", () => {
  assert.deepEqual(objectsFor([board], []), []);
  const other: PluginObjectSpec = { ...CHESSBOARD, plugin: "hq-other" };
  assert.deepEqual(objectsFor([board], [other]), []);
});

test("objectsFor drops a prop whose kind the manifest no longer declares", () => {
  const renamed: PluginObjectSpec = { ...CHESSBOARD, kind: "checkers" };
  assert.deepEqual(objectsFor([board], [renamed]), []);
});

// a board two tiles right of the whiteboard: both within reach of a member standing between them
const near: Prop = { t: "hq-chess/chessboard", x: 6, y: 5, w: 1, h: 1 }; // 96-112 px; the whiteboard is 32-80 px

test("nearestUsable returns the chessboard when it is nearer than a whiteboard", () => {
  assert.equal(nearestUsable([whiteboard, near], [CHESSBOARD], 90, 88, 20), near); // 6 px from it, 10 from the whiteboard
});

test("nearestUsable returns the whiteboard when it is nearer", () => {
  assert.equal(nearestUsable([whiteboard, near], [CHESSBOARD], 86, 88, 20), whiteboard); // 6 px from it, 10 from the board
});

test("nearestUsable returns null beyond 20 px", () => {
  assert.equal(nearestUsable([whiteboard, board], [CHESSBOARD], 130, 88, 20), null); // 50 px from both
  assert.equal(nearestUsable([board], [CHESSBOARD], 176 + 21, 88, 20), null);
  assert.equal(nearestUsable([board], [CHESSBOARD], 176 + 20, 88, 20), board); // exactly 20 px is in reach
});

test("nearestUsable ignores objects of plugins that are not running", () => {
  assert.equal(nearestUsable([board], [], 180, 88, 20), null);
});

test("propSize of a plugin prop is its own w and h", () => {
  assert.deepEqual(propSize({ t: "hq-chess/chessboard", x: 0, y: 0, w: 1, h: 1 }), [1, 1]);
  assert.deepEqual(propSize({ t: "hq-chess/table", x: 0, y: 0, w: 3, h: 2 }), [3, 2]);
  assert.deepEqual(propSize({ t: "whiteboard", x: 0, y: 0 }), [3, 1]);
});

// ---- object callbacks (init, destroy, update) ----

const ORB: PluginObjectSpec = { plugin: "ui-demo", kind: "orb", label: "Orb", size: [1, 1], dynamic: true };
const place = (kind: string, x: number, y: number, w = 1, h = 1): PlacedObject => ({ kind, x, y, w, h, px: x * 16, py: y * 16 });

test("placedObjects lists the objects of one plugin's declared kinds, in map order, with world pixels", () => {
  const props: Prop[] = [{ t: "ui-demo/orb", x: 3, y: 4, w: 1, h: 1 }, board, { t: "ui-demo/gone", x: 1, y: 1, w: 1, h: 1 }, { t: "ui-demo/orb", x: 1, y: 2, w: 2, h: 1 }];
  assert.deepEqual(placedObjects(props, [ORB, CHESSBOARD], "ui-demo"), [place("orb", 3, 4), place("orb", 1, 2, 2, 1)]);
  assert.deepEqual(placedObjects(props, [ORB, CHESSBOARD], "hq-chess"), [place("chessboard", 10, 5)]);
  assert.deepEqual(placedObjects(props, [], "ui-demo"), []);
});

test("objectChanges: init for a new object, destroy for a removed one", () => {
  const a = place("orb", 1, 1), b = place("orb", 5, 5);
  assert.deepEqual(objectChanges([], [a, b]), { init: [a, b], destroy: [] });
  assert.deepEqual(objectChanges([a, b], [a]), { init: [], destroy: [b] });
});

test("objectChanges: nothing for unchanged objects", () => {
  const a = place("orb", 1, 1), b = place("chessboard", 1, 1);
  assert.deepEqual(objectChanges([a, b], [{ ...b }, { ...a }]), { init: [], destroy: [] });
});

test("objectChanges: a moved or resized object is a destroy then an init", () => {
  const a = place("orb", 1, 1);
  const moved = place("orb", 2, 1);
  assert.deepEqual(objectChanges([a], [moved]), { init: [moved], destroy: [a] });
  const bigger = place("orb", 1, 1, 2, 2);
  assert.deepEqual(objectChanges([a], [bigger]), { init: [bigger], destroy: [a] });
});

test("dynamicObjects keeps only dynamic kinds, the first 64 in map order", () => {
  const still: PluginObjectSpec = { ...ORB, kind: "still", dynamic: undefined };
  const many = Array.from({ length: 70 }, (_, i) => place("orb", i, 0));
  const placed = [place("still", 0, 9), ...many];
  const d = dynamicObjects(placed, [ORB, still]);
  assert.equal(MAX_DYNAMIC, 64);
  assert.deepEqual(d.objects, many.slice(0, 64));
  assert.equal(d.over, 6);
  assert.deepEqual(dynamicObjects([place("still", 0, 9)], [ORB, still]), { objects: [], over: 0 });
});
