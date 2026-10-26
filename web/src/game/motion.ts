// Movement on the client, no PixiJS: the collision rules shared with the server (world.move), my own
// predicted position with its reconciliation against the server's acks, and the dead reckoning of
// remote people. Plain numbers in and out; time comes in as arguments. Nothing here allocates per frame.
import type { MapData } from "../net/protocol";
import { areaIndex } from "./areas.ts";

const T = 16;
/** Half size of a person's collision box (world px), around the feet. */
export const BOX_HW = 5;
export const BOX_HH = 3;
// Movement rules shared with the server (world.move): sub-steps of at most SUB_STEP_PX so no wall
// is skipped, and a blocked axis moves to the point of contact, so the result does not depend on
// how time was split into frames or ticks.
export const SUB_STEP_PX = 4;
export const MAX_ADVANCE = 1; // seconds integrated at most in one go (a backgrounded tab)
export const OFFSET_TAU = 0.08; // seconds over which a remote correction blends in
export const SELF_TAU = 0.12; // seconds over which a correction of my own position blends in
// ...but on each axis never faster than this fraction of the slowest per-axis walking speed (a diagonal
// walk), so a held key never draws a step back in any direction
export const SELF_BLEND_FRAC = 0.6;
export const SNAP_PX = 128; // larger corrections are not network jitter: no blending (teleports reset the offset anyway)
export const REMOTE_SNAP_PX = 24; // a remote person further than this from the new truth jumps there

/** The map as movement sees it: solid tiles, the area of each tile, and the areas I may not enter. */
export interface Grid {
  w: number;
  h: number;
  solid: Uint8Array;
  areaAt: Int16Array;
  deny: Set<number>;
}

/** Solid tiles of a map, one byte per tile. */
export function solidGrid(map: MapData) {
  const solid = new Uint8Array(map.w * map.h);
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) solid[y * map.w + x] = map.solid[y][x] === "1" ? 1 : 0;
  return solid;
}

/** Where a box of half size `half` moving in direction v touches the tile edge it crosses reaching c (server: contact). */
export function contact(c: number, v: number, half: number) {
  return v > 0 ? Math.floor((c + half - 0.001) / T) * T - half : (Math.floor((c - half) / T) + 1) * T + half;
}

/** Whether a person may stand at (x, y) being in area `area`: inside the map, on no wall, in no denied area but their own. */
export function canStand(g: Grid, x: number, y: number, area: number) {
  const x0 = Math.floor((x - BOX_HW) / T), x1 = Math.floor((x + BOX_HW - 0.001) / T);
  const y0 = Math.floor((y - BOX_HH) / T), y1 = Math.floor((y + BOX_HH - 0.001) / T);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (tx < 0 || ty < 0 || tx >= g.w || ty >= g.h || g.solid[ty * g.w + tx]) return false;
      const ai = g.areaAt[ty * g.w + tx];
      if (ai !== area && g.deny.has(ai)) return false;
    }
  }
  return true;
}

/** Whether a box may stand at (x, y) on walls alone (remote people, plugin sprites): rooms are not checked. */
export function canStandStatic(g: Grid, x: number, y: number) {
  const x0 = Math.floor((x - BOX_HW) / T), x1 = Math.floor((x + BOX_HW - 0.001) / T);
  const y0 = Math.floor((y - BOX_HH) / T), y1 = Math.floor((y + BOX_HH - 0.001) / T);
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) if (tx < 0 || ty < 0 || tx >= g.w || ty >= g.h || g.solid[ty * g.w + tx]) return false;
  return true;
}

/**
 * world.move on the server: moves p by dist along (dx, dy) in the same sub-steps and with the same
 * contact rule (see SUB_STEP_PX). With an area, room access is checked and follows the walk, as on
 * the server; with null, walls only.
 */
export function moveBody(g: Grid, p: { x: number; y: number }, dx: number, dy: number, dist: number, area: number | null) {
  let vx = dx, vy = dy;
  if (vx && vy) { vx *= 0.70710678; vy *= 0.70710678; }
  const n = Math.max(1, Math.ceil(dist / SUB_STEP_PX));
  const step = dist / n;
  for (let i = 0; i < n; i++) {
    if (vx) {
      const nx = p.x + vx * step;
      if (stand(g, nx, p.y, area)) p.x = nx;
      else {
        const c = contact(nx, vx, BOX_HW);
        if ((vx > 0 ? c > p.x : c < p.x) && stand(g, c, p.y, area)) p.x = c;
      }
    }
    if (vy) {
      const ny = p.y + vy * step;
      if (stand(g, p.x, ny, area)) p.y = ny;
      else {
        const c = contact(ny, vy, BOX_HH);
        if ((vy > 0 ? c > p.y : c < p.y) && stand(g, p.x, c, area)) p.y = c;
      }
    }
    if (area !== null) area = areaIndex(g, p.x, p.y);
  }
}

function stand(g: Grid, x: number, y: number, area: number | null) {
  return area === null ? canStandStatic(g, x, y) : canStand(g, x, y, area);
}

/**
 * My own position, predicted: integrated locally from the direction held, recorded with every input
 * sent, and reconciled with the server's acknowledgements. (x, y) is the prediction; the avatar is
 * drawn at (x + ox, y + oy), an offset that hides corrections and fades out (blend).
 */
export class LocalMotion {
  x = 0;
  y = 0;
  ox = 0;
  oy = 0;
  /** Sequence number of the last input sent. */
  seq = 0;
  private hist = new Map<number, { x: number; y: number }>();
  private lastAck = 0; // newest acknowledgement sequence applied
  private last = 0; // the time (ms) the position was integrated to

  /** Puts me at (x, y) with no correction pending and no input in flight (a spawn or a teleport). */
  reset(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.ox = this.oy = 0;
    this.hist.clear();
    this.lastAck = 0;
  }

  /** From now on, integrate from this time (ms). */
  restart(now: number) {
    this.last = now;
  }

  /**
   * Integrates my movement along (dx, dy) at v px/s up to now (ms), at most MAX_ADVANCE seconds at once.
   * area: the area I am in (room access). Returns whether the position was integrated.
   */
  advance(now: number, g: Grid | null, dx: number, dy: number, v: number, area: number) {
    const dt = Math.min(Math.max(now - this.last, 0) / 1000, MAX_ADVANCE);
    this.last = now;
    if (!g || (!dx && !dy) || dt === 0) return false;
    moveBody(g, this, dx, dy, v * dt, area);
    return true;
  }

  /** Records where I am as a new input is sent; returns its sequence number. Keeps the last 64. */
  record() {
    this.seq++;
    this.hist.set(this.seq, { x: this.x, y: this.y });
    if (this.hist.size > 64) this.hist.delete(this.hist.keys().next().value!);
    return this.seq;
  }

  /**
   * Server reconciliation: compare with where we were when input s was sent. The whole error
   * is applied, to the position and to every input still in flight (whose recorded positions
   * share the same error; leaving them alone applied it again on each later ack and overshot).
   * The avatar is drawn where it was and the offset fades, so jitter never shows as a step back.
   * Returns whether the position changed.
   */
  ack(s: number, ax: number, ay: number) {
    let h = this.hist.get(s);
    if (!h) {
      // No record of this input: its acknowledgement arrived after newer ones already
      // cleared it (a delayed message after a stall). The effects of every input up to this
      // one are already in the live position, so compare against that — but only for acks
      // newer than anything applied so far.
      if (s <= this.lastAck) return false;
      h = { x: this.x, y: this.y };
    }
    this.lastAck = Math.max(this.lastAck, s);
    for (const k of this.hist.keys()) if (k <= s) this.hist.delete(k);
    const ex = ax - h.x;
    const ey = ay - h.y;
    if (Math.abs(ex) <= 0.1 && Math.abs(ey) <= 0.1) return false; // the server rounds to 0.1 px
    this.x += ex;
    this.y += ey;
    for (const p of this.hist.values()) {
      p.x += ex;
      p.y += ey;
    }
    this.absorb(ex, ey);
    return true;
  }

  /** The server moved me to (x, y) (a server-steered walk): go there, and fade the gap in. */
  correct(x: number, y: number) {
    const ex = x - this.x, ey = y - this.y;
    this.x = x;
    this.y = y;
    this.absorb(ex, ey);
  }

  /** The drawn avatar stays where it was: a jump of (ex, ey) goes into the offset, unless it is too large to be jitter. */
  private absorb(ex: number, ey: number) {
    if (Math.hypot(ex, ey) > SNAP_PX) this.ox = this.oy = 0;
    else {
      this.ox -= ex;
      this.oy -= ey;
    }
  }

  /** Fades the offset over a frame of dt seconds, walking along (dx, dy) at walking speed `speed` px/s. */
  blend(dt: number, dx: number, dy: number, speed: number) {
    if (!this.ox && !this.oy) return;
    const k = 1 - Math.exp(-dt / SELF_TAU);
    // fading the offset moves the drawn avatar by -b; only where that would go against the held
    // direction is it capped, below walking speed, so the avatar slows but never steps back
    const lim = SELF_BLEND_FRAC * speed * Math.SQRT1_2 * dt;
    let bx = this.ox * k, by = this.oy * k;
    if (dx && Math.sign(bx) === dx) bx = Math.sign(bx) * Math.min(Math.abs(bx), lim);
    if (dy && Math.sign(by) === dy) by = Math.sign(by) * Math.min(Math.abs(by), lim);
    this.ox -= bx;
    this.oy -= by;
    if (Math.hypot(this.ox, this.oy) < 0.02 || Math.hypot(this.ox, this.oy) > SNAP_PX) this.ox = this.oy = 0;
  }
}

/**
 * A remote person, dead-reckoned: the server sends state changes (position + direction), the client
 * keeps walking them with the same collision rules. (tx, ty) is the extrapolated truth, (ox, oy) a
 * short-lived offset that hides corrections, (x, y) where they are drawn.
 */
export interface Remote {
  tx: number;
  ty: number;
  ox: number;
  oy: number;
  dx: number;
  dy: number;
  x: number;
  y: number;
}

/** A new truth (x, y) from the server: keep the picture continuous, the difference fades out (stepRemote). */
export function retarget(e: Remote, x: number, y: number) {
  const ox = e.tx + e.ox - x;
  const oy = e.ty + e.oy - y;
  if (Math.hypot(ox, oy) > REMOTE_SNAP_PX) {
    e.ox = 0;
    e.oy = 0;
  } else {
    e.ox = ox;
    e.oy = oy;
  }
  e.tx = x;
  e.ty = y;
}

const body = { x: 0, y: 0 };

/** One frame of dt seconds for a remote person walking at v px/s: walk on (the server's shadow rule), fade the offset, place them. */
export function stepRemote(e: Remote, g: Grid, dt: number, v: number) {
  if (e.dx || e.dy) {
    body.x = e.tx;
    body.y = e.ty;
    moveBody(g, body, e.dx, e.dy, v * dt, null);
    e.tx = body.x;
    e.ty = body.y;
  }
  const k = Math.exp(-dt / OFFSET_TAU);
  e.ox *= k;
  e.oy *= k;
  e.x = e.tx + e.ox;
  e.y = e.ty + e.oy;
}
