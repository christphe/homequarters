// Conversation cues: a chime in, a chime out. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { convChange } from "../src/convChime.ts";

const ME = 1;

test("a conversation opening for me chimes in; leaving it chimes out", () => {
  assert.equal(convChange(null, [1, 2], ME), "in");
  assert.equal(convChange([1, 2], null, ME), "out");
  assert.equal(convChange(null, null, ME), null);
});

test("somebody joining chimes in, somebody leaving chimes out", () => {
  assert.equal(convChange([1, 2], [1, 2, 3], ME), "in");
  assert.equal(convChange([1, 2, 3], [1, 3], ME), "out");
});

test("an arrival wins when somebody leaves as somebody else joins; no change, no chime", () => {
  assert.equal(convChange([1, 2], [1, 3], ME), "in");
  assert.equal(convChange([1, 2, 3], [3, 2, 1], ME), null);
  assert.equal(convChange([2, 3], [1, 2, 3], ME), null, "my own arrival in the member list is not news");
});
