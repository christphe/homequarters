// Automatic away: from the tab's own inactivity or the computer's (Idle Detection). Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoStatus } from "../src/osIdle.ts";

const base = { status: "available", autoAway: false, inCall: false, inactive: false };

test("an available person who goes idle is set away", () => {
  assert.equal(autoStatus({ ...base, inactive: true }), "away");
});

test("being in a call or watching a spotlight keeps you available while idle", () => {
  assert.equal(autoStatus({ ...base, inactive: true, inCall: true }), null);
});

test("busy and invisible are never touched", () => {
  for (const status of ["busy", "invisible"]) {
    assert.equal(autoStatus({ ...base, status, inactive: true }), null);
    assert.equal(autoStatus({ ...base, status, autoAway: true }), null);
  }
});

test("coming back undoes only an automatic away", () => {
  assert.equal(autoStatus({ ...base, status: "away", autoAway: true }), "available");
  assert.equal(autoStatus({ ...base, status: "away", autoAway: false }), null, "an away the person chose stays");
});
