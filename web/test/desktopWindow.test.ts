// The desktop app's window hidden to the tray: busy while hidden, back to available when shown if the
// tray put you busy. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { onWindowHidden, onWindowShown } from "../src/desktopWindow.ts";

test("hiding the window sets an available person busy, and remembers it did", () => {
  assert.deepEqual(onWindowHidden("available"), { status: "busy", restore: true });
});

test("hiding while automatically away also goes busy (away still lets a call reach you)", () => {
  assert.deepEqual(onWindowHidden("away"), { status: "busy", restore: true });
});

test("a status chosen by hand is kept while hidden and not undone later", () => {
  for (const s of ["busy", "invisible"]) assert.deepEqual(onWindowHidden(s), { status: null, restore: false });
});

test("showing the window again makes you available only if the tray set you busy and you still are", () => {
  assert.equal(onWindowShown("busy", true), "available");
  assert.equal(onWindowShown("busy", false), null); // busy by hand before hiding
  assert.equal(onWindowShown("invisible", true), null); // changed meanwhile (another tab, the server)
  assert.equal(onWindowShown("available", true), null);
});
