// When a desktop notification may fire. Run: pnpm exec vitest run (in web/)
import { test } from "vitest";
import assert from "node:assert/strict";
import { mayNotify } from "../src/notifyGate.ts";

const on = { enabled: true, permission: "granted" as const };

test("a visible page without the focus notifies (another app in front, window behind another one)", () => {
  assert.equal(mayNotify({ ...on, hidden: false, focused: false }), true);
});

test("a hidden page notifies (minimised, in the tray, a background tab)", () => {
  assert.equal(mayNotify({ ...on, hidden: true, focused: false }), true);
  assert.equal(mayNotify({ ...on, hidden: true, focused: true }), true);
});

test("a visible page with the focus does not notify: the person is looking at it", () => {
  assert.equal(mayNotify({ ...on, hidden: false, focused: true }), false);
});

test("the setting off or no permission: never", () => {
  assert.equal(mayNotify({ ...on, enabled: false, hidden: true, focused: false }), false);
  assert.equal(mayNotify({ ...on, permission: "default", hidden: true, focused: false }), false);
  assert.equal(mayNotify({ ...on, permission: "denied", hidden: true, focused: false }), false);
  assert.equal(mayNotify({ ...on, permission: undefined, hidden: true, focused: false }), false, "no Notification API");
});
