// What the server's replies to a walk-to and a wave tell the player (replies.ts); the rules themselves are the
// server's (world: TestWalkToAPersonInALockedRoomStopsAtTheDoor, TestWaveReachesThePersonBusyAndAwayIncluded).
import { test } from "vitest";
import assert from "node:assert/strict";
import { goToast, waveToast } from "../src/replies.ts";

test("a walk-to a person behind a closed door says it will stop at the door", () => {
  assert.match(goToast({ ok: true, near: true }) ?? "", /stop at the door/);
});

test("a walk-to the server refuses (an admin-only room) says there is no way there", () => {
  assert.match(goToast({ ok: false }) ?? "", /no way/);
});

test("a plain walk-to says nothing", () => {
  assert.equal(goToast({ ok: true }), null);
  assert.equal(goToast({ ok: true, near: false }), null);
});

test("a wave refused by the busy-or-away cooldown names the person and the 30 seconds", () => {
  const s = waveToast("wait", "Desk42");
  assert.match(s, /30 seconds/);
  assert.match(s, /Desk42/);
  assert.match(waveToast("ok", "Desk42"), /^You waved at Desk42/);
});
