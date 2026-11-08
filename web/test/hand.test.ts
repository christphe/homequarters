// The raised hand's toggle (hand.ts): H and the hand button invert what was last asked for, so quick presses
// before the server's echo do not repeat a raise.
import { test } from "vitest";
import assert from "node:assert/strict";
import { HAND_PENDING_MS, nextHand } from "../src/hand.ts";

test("H pressed twice quickly (before the server's echo) is a raise and a lower, not two raises", () => {
  const first = nextHand(false, null, 0, 10_000);
  assert.equal(first, true, "the first press raises");
  assert.equal(nextHand(false, first, 10_000, 10_050), false, "the second, the server still saying down, lowers");
});

test("with nothing pending, a press inverts what the server says", () => {
  assert.equal(nextHand(true, null, 0, 10_000), false);
  assert.equal(nextHand(false, null, 0, 10_000), true);
});

test("a request the server never confirmed (dropped by the rate limit) stops counting after a second", () => {
  assert.equal(nextHand(false, true, 10_000, 10_000 + HAND_PENDING_MS), true, "the server says down: raise again");
  assert.equal(HAND_PENDING_MS, 1000);
});
