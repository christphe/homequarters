// Pet following, frame by frame with a fixed 60 Hz clock. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { followOwner, newPet, PET_GAP, type PetState } from "../src/game/petFollow.ts";

const DT = 1 / 60, WALK = 72, RUN = 144;

/** Walks the owner along (vx, vy) for secs; returns the pet-owner distance at every frame. */
function walk(s: PetState, o: { x: number; y: number; t: number }, vx: number, vy: number, secs: number, v = WALK) {
  const gaps: number[] = [];
  const dir = vx < 0 ? 1 : vx > 0 ? 2 : vy < 0 ? 3 : 0;
  for (let i = 0; i < Math.round(secs / DT); i++) {
    o.x += vx * v * DT;
    o.y += vy * v * DT;
    o.t += DT * 1000;
    followOwner(s, o.x, o.y, dir, v, DT, o.t);
    gaps.push(Math.hypot(s.px - o.x, s.py - o.y));
  }
  return gaps;
}

test("walks PET_GAP behind on a straight line and never on top", () => {
  const s = newPet(), o = { x: 100, y: 100, t: 0 };
  const g = walk(s, o, 1, 0, 2).slice(30);
  assert.ok(Math.min(...g) >= PET_GAP - 2 && Math.max(...g) <= PET_GAP + 2, `gaps ${Math.min(...g)}..${Math.max(...g)}`);
});

test("goes around a corner on the owner's trail", () => {
  const s = newPet(), o = { x: 100, y: 100, t: 0 };
  walk(s, o, 1, 0, 1);
  const cornerX = o.x;
  for (let i = 0; i < 40; i++) {
    walk(s, o, 0, 1, DT);
    // while the owner goes down, the pet is still on the horizontal leg or on the vertical one, never inside the corner
    assert.ok(Math.abs(s.py - 100) < 0.5 || Math.abs(s.px - cornerX) < 0.5, `pet at ${s.px.toFixed(1)},${s.py.toFixed(1)}`);
  }
});

test("keeps up with a runner", () => {
  const s = newPet(), o = { x: 100, y: 100, t: 0 };
  const g = walk(s, o, 1, 0, 2, RUN).slice(30);
  assert.ok(Math.max(...g) <= PET_GAP + 3, `max ${Math.max(...g)}`);
});

test("catches up within a second after a 60 px jump of its owner (network correction, short portal)", () => {
  const s = newPet(), o = { x: 100, y: 100, t: 0 };
  walk(s, o, 1, 0, 1);
  o.x += 60;
  const g = walk(s, o, 1, 0, 1.5);
  const late = g.slice(60);
  assert.ok(Math.max(...late) <= PET_GAP + 6, `still ${Math.max(...late).toFixed(1)} px away 1 s after the jump`);
});

test("small network corrections (up to 6 px, sudden) never make the pet outrun a walker", () => {
  const s = newPet(), o = { x: 100, y: 100, t: 0 };
  walk(s, o, 1, 0, 1);
  let fastest = 0;
  for (let i = 0; i < 180; i++) {
    const px = s.px, py = s.py;
    o.x += WALK * DT + (i % 20 === 0 ? 6 * Math.sign(Math.sin(i)) : 0); // a correction every third of a second
    o.t += DT * 1000;
    followOwner(s, o.x, o.y, 2, WALK, DT, o.t);
    fastest = Math.max(fastest, Math.hypot(s.px - px, s.py - py) / DT);
  }
  assert.ok(fastest <= WALK * 1.35, `pet reached ${fastest.toFixed(0)} px/s`);
});

test("reseeds behind the owner after a teleport", () => {
  const s = newPet(), o = { x: 100, y: 100, t: 0 };
  walk(s, o, 1, 0, 1);
  o.x += 500;
  const g = walk(s, o, 1, 0, DT * 2);
  assert.ok(g[g.length - 1] <= PET_GAP + 2);
});

/** Share of the pet sprite (16x14 above its feet) hidden by the owner (18x26 sprite plus name tag above). */
function hidden(s: PetState, o: { x: number; y: number }) {
  const p = { x0: s.px - 7, x1: s.px + 7, y0: s.py - 13, y1: s.py };
  const owner = { x0: o.x - 9, x1: o.x + 9, y0: o.y - 31, y1: o.y };
  const w = Math.max(0, Math.min(p.x1, owner.x1) - Math.max(p.x0, owner.x0));
  const h = Math.max(0, Math.min(p.y1, owner.y1) - Math.max(p.y0, owner.y0));
  return (w * h) / (14 * 13);
}

test("after the owner walks toward the camera and stops, the pet does not stay hidden behind them", () => {
  const s = newPet(), o = { x: 100, y: 100, t: 0 };
  walk(s, o, 0, 1, 1);
  walk(s, o, 0, 0, 1.5);
  assert.ok(hidden(s, o) <= 0.25, `${Math.round(hidden(s, o) * 100)} % of the pet is behind the owner`);
});

test("a pet that appears next to an owner facing the camera is visible", () => {
  const s = newPet(), o = { x: 100, y: 100, t: 0 };
  walk(s, o, 0, 0, 1.5); // owner standing, facing down (dir 0), pet just created
  assert.ok(hidden(s, o) <= 0.25, `${Math.round(hidden(s, o) * 100)} % hidden`);
});

test("at rest it settles behind and looks at the owner", () => {
  const s = newPet(), o = { x: 100, y: 100, t: 0 };
  walk(s, o, 1, 0, 1);
  walk(s, o, 0, 0, 1);
  assert.ok(!s.moving && Math.abs(Math.hypot(s.px - o.x, s.py - o.y) - PET_GAP) < 1);
  assert.equal(s.dir, 2, "facing right, toward the owner");
});

test("an owner pulled back after stopping (dead-reckoning overshoot) does not leave the pet glued to them", () => {
  // what an observer sees: the remote owner walks left, keeps going ~7 px past the real stop until the
  // stop record arrives, then is corrected back over ~80 ms
  for (const [fps, back] of [[60, 5], [60, 7], [60, 10], [12, 7]]) {
    const dt = 1 / fps, s = newPet(), o = { x: 300, y: 100, t: 0 };
    for (let i = 0; i < Math.round(1.2 / dt); i++) { o.x -= WALK * dt; o.t += dt * 1000; followOwner(s, o.x, o.y, 1, WALK, dt, o.t); }
    const gaps: number[] = [];
    const steps = Math.max(1, Math.round(0.08 / dt)); // pulled back over ~80 ms
    for (let i = 0; i < steps; i++) { o.x += back / steps; o.t += dt * 1000; followOwner(s, o.x, o.y, 1, WALK, dt, o.t); gaps.push(Math.hypot(s.px - o.x, s.py - o.y)); }
    for (let i = 0; i < Math.round(1.5 / dt); i++) { o.t += dt * 1000; followOwner(s, o.x, o.y, 1, 0, dt, o.t); gaps.push(Math.hypot(s.px - o.x, s.py - o.y)); }
    const min = Math.min(...gaps), end = gaps[gaps.length - 1];
    assert.ok(min >= PET_GAP - 4 && Math.abs(end - PET_GAP) <= 2, // never closer than 16 px: before, 7-10 px for half a second
      `${fps} fps, pulled back ${back} px: closest ${min.toFixed(1)}, resting ${end.toFixed(1)}`);
  }
});

test("behaves the same at 12 fps (slow, software-rendered browsers)", () => {
  const s = newPet(), o = { x: 100, y: 100, t: 0 };
  const dt = 1 / 12;
  let fastest = 0;
  const gaps: number[] = [];
  for (let i = 0; i < 36; i++) {
    const px = s.px, py = s.py;
    o.x += WALK * dt;
    o.t += dt * 1000;
    followOwner(s, o.x, o.y, 2, WALK, dt, o.t);
    if (i > 6) {
      fastest = Math.max(fastest, Math.hypot(s.px - px, s.py - py) / dt);
      gaps.push(Math.hypot(s.px - o.x, s.py - o.y));
    }
  }
  assert.ok(fastest <= WALK * 1.35, `pet reached ${fastest.toFixed(0)} px/s`);
  assert.ok(Math.min(...gaps) >= PET_GAP - 3 && Math.max(...gaps) <= PET_GAP + 3, `gaps ${Math.min(...gaps).toFixed(1)}..${Math.max(...gaps).toFixed(1)}`);
});

test("the trail stays bounded", () => {
  const s = newPet(), o = { x: 100, y: 100, t: 0 };
  walk(s, o, 1, 0, 30);
  assert.ok(s.trail.length < 2 * (PET_GAP + 4), `trail has ${s.trail.length / 2} points`);
});

test("a larger gap keeps the pet that far behind (plugin creatures)", () => {
  const s = newPet(), o = { x: 100, y: 100, t: 0 };
  const g: number[] = [];
  for (let i = 0; i < 120; i++) {
    o.x += WALK * DT;
    o.t += DT * 1000;
    followOwner(s, o.x, o.y, 2, WALK, DT, o.t, () => true, 36);
    if (i >= 30) g.push(Math.hypot(s.px - o.x, s.py - o.y));
  }
  assert.ok(Math.min(...g) >= 34 && Math.max(...g) <= 38, `gaps ${Math.min(...g)}..${Math.max(...g)}`);
});

test("with rest beside, a resting creature sits at the owner's side, away from their own pet", () => {
  for (const [avoid, want] of [[undefined, 0], [130, -1], [70, 1]] as const) {
    const s = newPet(), o = { x: 100, y: 100, t: 0 };
    for (let i = 0; i < 60; i++) { // walk up, then stop facing the camera
      o.y -= WALK * DT;
      o.t += DT * 1000;
      followOwner(s, o.x, o.y, 3, WALK, DT, o.t, () => true, 36, { beside: 22, avoid });
    }
    for (let i = 0; i < 180; i++) {
      o.t += DT * 1000;
      followOwner(s, o.x, o.y, 0, WALK, DT, o.t, () => true, 36, { beside: 22, avoid: avoid === undefined ? undefined : o.x + (avoid - 100) });
    }
    const dx = s.px - o.x, dy = s.py - o.y;
    assert.ok(Math.abs(Math.abs(dx) - 22) < 1.5 && Math.abs(dy) < 1.5, `rest at ${dx.toFixed(1)},${dy.toFixed(1)}`);
    if (want) assert.equal(Math.sign(dx), want, `side away from the pet at ${avoid}`);
  }
});

test("a pet resting at its owner's feet waits, then walks off behind them: no dash, no jump", () => {
  for (const [vx, vy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const s = newPet();
    const o = { x: 200, y: 200, t: 0 };
    const rest = { beside: 10 };
    // walk in, then stand still long enough to settle at the feet
    for (let i = 0; i < 120; i++) { o.x += WALK * DT; o.t += DT * 1000; followOwner(s, o.x, o.y, 2, WALK, DT, o.t, () => true, 36, rest); }
    for (let i = 0; i < 180; i++) { o.t += DT * 1000; followOwner(s, o.x, o.y, 2, 0, DT, o.t, () => true, 36, rest); }
    assert.ok(Math.hypot(s.px - o.x, s.py - o.y) <= 12, `rests at the feet: ${Math.hypot(s.px - o.x, s.py - o.y)}`);
    // set off: every frame the pet moves at most a walking step and a bit, and it never runs away sideways
    let worst = 0, px = s.px, py = s.py;
    const dir = vx < 0 ? 1 : vx > 0 ? 2 : vy < 0 ? 3 : 0;
    for (let i = 0; i < 120; i++) {
      o.x += vx * WALK * DT; o.y += vy * WALK * DT; o.t += DT * 1000;
      followOwner(s, o.x, o.y, dir, WALK, DT, o.t, () => true, 36, rest);
      worst = Math.max(worst, Math.hypot(s.px - px, s.py - py));
      px = s.px; py = s.py;
    }
    assert.ok(worst <= WALK * DT * 1.6, `setting off ${vx},${vy}: a frame moved ${worst.toFixed(2)} px`);
    const d = Math.hypot(s.px - o.x, s.py - o.y);
    assert.ok(d >= 28 && d <= 44, `then it walks about 36 px behind: ${d.toFixed(1)}`);
  }
});

test("at rest a roaming pet potters about its owner's feet, the same on every page", () => {
  const rest = (clock: number) => ({ beside: 10, roam: 14, seed: 12345, clock });
  const settle = (s: PetState, clock0: number, secs: number, record?: [number, number][]) => {
    for (let i = 0; i < Math.round(secs / DT); i++) {
      const t = i * DT * 1000;
      followOwner(s, 300, 300, 0, 0, DT, 1000 + t, () => true, 36, rest(clock0 + t));
      record?.push([s.px, s.py]);
    }
  };
  const a = newPet(), b = newPet();
  const seen: [number, number][] = [];
  settle(a, 1_000_000, 40, seen);
  settle(b, 1_000_000, 40);
  assert.ok(Math.abs(a.px - b.px) < 0.01 && Math.abs(a.py - b.py) < 0.01, "two pages agree");
  const spots = new Set(seen.map(([x, y]) => `${Math.round(x / 4)},${Math.round(y / 4)}`));
  assert.ok(spots.size > 6, `it moves about: ${spots.size} places`);
  const far = Math.max(...seen.slice(120).map(([x, y]) => Math.hypot(x - 300, y - 300)));
  assert.ok(far <= 10 + 14 + 1, `it stays at the feet: ${far.toFixed(1)} px`);
  let fastest = 0;
  for (let i = 121; i < seen.length; i++) fastest = Math.max(fastest, Math.hypot(seen[i][0] - seen[i - 1][0], seen[i][1] - seen[i - 1][1]));
  assert.ok(fastest <= 1.2, `it strolls, never jumps: ${fastest.toFixed(2)} px a frame`);
});

test("a roaming pet never picks a spot where it cannot stand", () => {
  const s = newPet();
  const wallAbove = (_x: number, y: number) => y >= 300; // nothing behind (above) the owner is free
  for (let i = 0; i < 60 * 40; i++) {
    followOwner(s, 300, 300, 0, 0, DT, 1000 + i * DT * 1000, wallAbove, 36, { beside: 10, roam: 14, seed: 7, clock: 2_000_000 + i * DT * 1000 });
    assert.ok(s.py >= 300 - 0.01 || i < 60, `frame ${i}: ${s.py}`);
  }
});

test("on a fast display (120-240 Hz) a pet that rested walks off behind its owner, at walking pace too", () => {
  // a walker moves under 1 px a frame there: the pet must still see them leave
  for (const hz of [60, 120, 144, 240]) {
    for (const rest of [{ beside: 10 }, { beside: 10, roam: 14, seed: 7 }]) {
      const dt = 1 / hz, gap = 36, s = newPet();
      let x = 100, t = 0, clock = 1_700_000_000_000;
      const step = (v: number) => {
        x += v * dt;
        t += dt * 1000;
        clock += dt * 1000;
        followOwner(s, x, 100, 2, v, dt, t, () => true, gap, { ...rest, clock });
        return Math.hypot(s.px - x, s.py - 100);
      };
      for (let i = 0; i < hz; i++) step(WALK); // in line
      for (let i = 0; i < hz * 12; i++) step(0); // rests (and potters about) for 12 s
      const gaps: number[] = [];
      for (let i = 0; i < hz * 4; i++) gaps.push(step(WALK));
      const late = gaps.slice(hz * 2); // 2 s after setting off
      assert.ok(Math.max(...late) <= gap + 2, `${hz} Hz ${rest.roam ? "roaming" : "resting"}: ${Math.min(...late).toFixed(1)}..${Math.max(...late).toFixed(1)} px behind, want ${gap}`);
    }
  }
});
