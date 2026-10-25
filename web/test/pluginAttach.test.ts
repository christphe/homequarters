// hq.attach: the command that pins a plugin sprite above a member's head.
// Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBatch } from "../src/plugins/commands.ts";

test("attach accepts a member id and null", () => {
  assert.deepEqual(parseBatch([{ op: "attach", id: "b", player: 7 }]), [{ op: "attach", id: "b", player: 7 }]);
  assert.deepEqual(parseBatch([{ op: "attach", id: "b", player: null }]), [{ op: "attach", id: "b", player: null }]);
  assert.deepEqual(parseBatch([{ op: "attach", id: "b", player: 2 ** 32 - 1 }]), [{ op: "attach", id: "b", player: 2 ** 32 - 1 }]);
});

test("attach refuses a member id of 0, a fraction, a string, 2^32 or none", () => {
  for (const player of [0, 1.5, "7", 2 ** 32, -1, undefined]) {
    assert.equal(typeof parseBatch([{ op: "attach", id: "b", player }]), "string", String(player));
  }
});

test("attach needs a sprite id", () => {
  assert.equal(typeof parseBatch([{ op: "attach", player: 7 }]), "string");
});
