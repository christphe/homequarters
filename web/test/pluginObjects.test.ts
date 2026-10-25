// Plugin objects on the map: which ones the page draws and which one X uses. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { nearestUsable, objectsFor, type PluginObjectSpec } from "../src/game/pluginObjects.ts";
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
