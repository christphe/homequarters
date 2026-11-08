// What the server's replies to a walk-to and a wave, and its notices of a layout switch and a forced door, tell the
// player (replies.ts); the rules themselves are the server's (world: TestWalkToAPersonInALockedRoomStopsAtTheDoor,
// TestWaveReachesThePersonBusyAndAwayIncluded, TestReplaceMapChangesSizeAndRespawnsEverybody,
// TestAssignedOfficeOwnerKnockAndAdmit).
import { test } from "vitest";
import assert from "node:assert/strict";
import { forcedToast, goToast, layoutToast, waveToast } from "../src/replies.ts";

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

// was a browser check of e2e/scenarios/templates.ts
test("a layout switch tells an online member the office moved, naming the new layout", () => {
  assert.equal(layoutToast("Manor"), "The office moved to the Manor layout.");
});

// was a browser check of e2e/scenarios/offices.ts
test("a forced door tells the people inside which administrator entered which room", () => {
  assert.equal(forcedToast("Ada", "Office 2 · Bo"), "Ada (admin) entered Office 2 · Bo.");
});
