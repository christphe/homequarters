// Turning the microphone and camera off for the next conversation once one ends. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_OFF_GRACE_MS, AutoOff, inCall, type Pending } from "../src/media/autoOff.ts";

function rig(stored: Pending | null = null) {
  let now = 1000;
  let saved = stored;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let ids = 0;
  const offs: { mic: boolean; cam: boolean }[] = [];
  const a = new AutoOff({
    now: () => now,
    load: () => saved,
    save: (p) => { saved = p; },
    turnOff: (mic, cam) => offs.push({ mic, cam }),
    setTimer: (fn, ms) => { timers.push({ at: now + ms, fn, id: ++ids }); return ids; },
    clearTimer: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const tm of [...timers].sort((x, y) => x.at - y.at)) if (tm.at <= now && timers.includes(tm)) { timers.splice(timers.indexOf(tm), 1); tm.fn(); }
  };
  return { a, advance, offs, saved: () => saved };
}

test("the grace is 15 seconds", () => {
  assert.equal(AUTO_OFF_GRACE_MS, 15_000);
});

test("a call that ended turns both off once the grace has passed, not before", () => {
  const { a, advance, offs, saved } = rig();
  a.update(true);
  a.update(false);
  advance(AUTO_OFF_GRACE_MS - 1);
  assert.deepEqual(offs, []);
  advance(1);
  assert.deepEqual(offs, [{ mic: true, cam: true }]);
  assert.equal(saved(), null);
});

test("a new call within the grace keeps everything as it was", () => {
  const { a, advance, offs } = rig();
  a.update(true);
  a.update(false);
  advance(5000);
  a.update(true);
  advance(60_000);
  assert.deepEqual(offs, []);
});

test("staying in the same call (a media reconnect) is not an end", () => {
  const { a, advance, offs } = rig();
  a.update(true);
  a.update(true);
  advance(60_000);
  assert.deepEqual(offs, []);
});

test("without any call there is nothing to turn off", () => {
  const { a, advance, offs } = rig();
  a.update(false);
  advance(60_000);
  assert.deepEqual(offs, []);
});

test("a choice made on the bar during the grace wins for that device", () => {
  const { a, advance, offs } = rig();
  a.update(true);
  a.update(false);
  a.chose("cam");
  advance(AUTO_OFF_GRACE_MS);
  assert.deepEqual(offs, [{ mic: true, cam: false }]);
});

test("choices on both devices cancel the turn-off; a choice in a call changes nothing", () => {
  const { a, advance, offs } = rig();
  a.update(true);
  a.chose("mic");
  a.update(false);
  a.chose("mic");
  a.chose("cam");
  advance(AUTO_OFF_GRACE_MS);
  assert.deepEqual(offs, []);
});

test("a page that went away during a call: the call ended then", () => {
  // the page stamps the deadline as it goes away
  const before = rig();
  before.a.update(true);
  before.a.hidden();
  assert.deepEqual(before.saved(), { at: 1000 + AUTO_OFF_GRACE_MS, mic: true, cam: true });
  // reopened the next morning, beside the same colleague: off before the call can form again
  const late = rig({ at: 1000 - 3_600_000, mic: true, cam: true });
  late.a.resume();
  late.advance(0);
  late.a.update(true);
  assert.deepEqual(late.offs, [{ mic: true, cam: true }]);
  // a reload that rejoins the same call within the grace keeps everything
  const reload = rig({ at: 1000 + AUTO_OFF_GRACE_MS - 2000, mic: true, cam: true });
  reload.a.resume();
  reload.advance(1000);
  reload.a.update(true);
  reload.advance(60_000);
  assert.deepEqual(reload.offs, []);
});

test("a call record without a deadline (the page crashed) is overdue", () => {
  const { a, advance, offs } = rig({ at: null, mic: true, cam: true });
  a.resume();
  advance(0);
  assert.deepEqual(offs, [{ mic: true, cam: true }]);
});

test("without storage the turn-off still happens in the page", () => {
  const { a, advance, offs } = rig();
  // a storage that keeps nothing
  (a as unknown as { d: { load: () => null; save: () => void } }).d.load = () => null;
  (a as unknown as { d: { save: () => void } }).d.save = () => {};
  a.update(true);
  a.update(false);
  a.chose("mic");
  advance(AUTO_OFF_GRACE_MS);
  assert.deepEqual(offs, [{ mic: false, cam: true }]);
});

test("a page reopened after the grace turns them off at once; within it, at the deadline", () => {
  const late = rig({ at: 500, mic: true, cam: false });
  late.a.resume();
  late.advance(0);
  assert.deepEqual(late.offs, [{ mic: true, cam: false }]);
  const early = rig({ at: 1000 + 4000, mic: true, cam: true });
  early.a.resume();
  early.advance(3999);
  assert.deepEqual(early.offs, []);
  early.advance(1);
  assert.equal(early.offs.length, 1);
});

test("a call is a conversation or my own spotlight, not watching someone else's", () => {
  assert.equal(inCall({ conv: null, spotlight: null }), false);
  assert.equal(inCall({ conv: {}, spotlight: null }), true);
  assert.equal(inCall({ conv: null, spotlight: { me: true } }), true);
  assert.equal(inCall({ conv: null, spotlight: { me: false } }), false);
});
