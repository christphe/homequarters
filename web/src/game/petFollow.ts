// How a pet follows its owner: pure logic, no PixiJS, so it can be tested with plain Node
// (node --test 'web/test/*.test.ts'). The view calls followOwner() once per frame for every visible pet.

export const PET_GAP = 20; // px along the owner's trail between the owner's feet and the pet
export const PET_SNAP = 140; // px: an owner jump farther than this reseeds the trail (portal, teleport)
const SETTLE_MS = 500; // owner still this long: a pet hidden behind them strolls to their side
const STROLL = 45; // px/s for that little walk
const RETRACE = 10; // px: an owner stepping back along their own trail by this little is a network correction

export interface PetState {
  /** Owner positions, oldest first, flat [x0, y0, x1, y1, ...]; the pet walks this trail. */
  trail: number[];
  px: number;
  py: number;
  dir: number; // 0 down, 1 left, 2 right, 3 up
  moving: boolean;
  /** ms timestamp of the last frame the pet moved */
  restSince: number;
  /** ms timestamp of the last frame the owner moved */
  ownerMoved: number;
  /** px the owner has stepped back along the trail since they last went forward */
  retraced: number;
}

export const newPet = (): PetState => ({ trail: [], px: NaN, py: NaN, dir: 0, moving: false, restSince: 0, ownerMoved: 0, retraced: 0 });

const facing = (dx: number, dy: number) => (Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : 2) : dy < 0 ? 3 : 0);

/** Share of a pet standing at (px, py) that the owner at (ox, oy) hides: their sprite plus the name tag. */
export function hiddenShare(px: number, py: number, ox: number, oy: number) {
  const w = Math.max(0, Math.min(px + 7, ox + 9) - Math.max(px - 7, ox - 9));
  const h = Math.max(0, Math.min(py, oy) - Math.max(py - 13, oy - 31));
  return (w * h) / (14 * 13);
}

/**
 * Advances the pet one frame. ox/oy/odir: the owner now; ownerV: the owner's current speed in px/s
 * (walk or run); dt in seconds; now in ms; canStand: whether a pet may stand at a point (walls);
 * gap: px along the trail between the owner and the pet (plugin creatures keep a larger one);
 * rest: once the owner stands still, sit `beside` px to their side, away from x `avoid` (their own pet)
 * when given, so a second follower does not queue up behind the owner or sit on the pet.
 */
export function followOwner(s: PetState, ox: number, oy: number, odir: number, ownerV: number, dt: number, now: number, canStand: (x: number, y: number) => boolean = () => true, gap = PET_GAP, rest?: { beside: number; avoid?: number }) {
  const tr = s.trail;
  const lx = tr[tr.length - 2], ly = tr[tr.length - 1];
  if (!Number.isFinite(s.px) || tr.length === 0 || Math.hypot(ox - lx, oy - ly) > PET_SNAP) {
    // (re)seed a short trail from the owner's back; an owner facing the camera gets the pet at their
    // side instead, where it is not hidden behind them
    const back = [[-1, 0], [1, 0], [-1, 0], [0, 1]][odir] ?? [-1, 0];
    tr.length = 0;
    tr.push(ox + back[0] * gap, oy + back[1] * gap, ox, oy);
    s.px = tr[0];
    s.py = tr[1];
    s.ownerMoved = now;
  } else if (Math.hypot(ox - lx, oy - ly) >= 1) {
    // A remote owner is extrapolated past a stop, then pulled back a few px when the stop arrives.
    // Stepping back along the last stretch of the trail shortens the trail instead of folding it,
    // so the pet keeps its distance rather than being drawn onto the owner. A longer way back is a
    // real turn: it is appended, and the pet walks round as before.
    const n = tr.length;
    const sx = lx - tr[n - 4], sy = ly - tr[n - 3], len = Math.hypot(sx, sy);
    const ux = len > 0 ? sx / len : 0, uy = len > 0 ? sy / len : 0; // the way the owner was going
    const back = -((ox - lx) * ux + (oy - ly) * uy); // px moved against it
    const across = Math.abs((ox - lx) * uy - (oy - ly) * ux);
    const step = Math.hypot(ox - lx, oy - ly);
    if (n >= 4 && len > 0 && back > 0 && across < 0.5 && s.retraced + step <= RETRACE) {
      // drop the points the owner stepped back past, on the same straight stretch only
      while (tr.length >= 6) {
        const qx = tr[tr.length - 2], qy = tr[tr.length - 1];
        if ((ox - qx) * ux + (oy - qy) * uy >= 0 || Math.abs((ox - qx) * uy - (oy - qy) * ux) > 0.5) break;
        tr.length -= 2;
      }
      tr.push(ox, oy);
      s.retraced += step;
    } else {
      tr.push(ox, oy);
      if (back <= 0) s.retraced = 0;
    }
    s.ownerMoved = now;
  }
  const still = now - s.ownerMoved > SETTLE_MS;
  // walk back from the owner along the trail to find the pet's spot; drop what lies beyond it
  let need = gap, gx = tr[0], gy = tr[1], cut = 0, found = false;
  let ax = ox, ay = oy;
  for (let i = tr.length - 2; i >= 0; i -= 2) {
    const bx = tr[i], by = tr[i + 1];
    const seg = Math.hypot(ax - bx, ay - by);
    if (seg >= need) {
      const k = need / seg;
      gx = ax + (bx - ax) * k;
      gy = ay + (by - ay) * k;
      cut = i;
      found = true;
      break;
    }
    need -= seg;
    ax = bx;
    ay = by;
  }
  if (!found && tr.length >= 4) {
    // the trail is shorter than the gap (it was trimmed, then the owner stepped back): carry its first
    // stretch on in a straight line, so the pet keeps its distance instead of closing in
    const dx = tr[0] - tr[2], dy = tr[1] - tr[3], l = Math.hypot(dx, dy);
    if (l > 0 && canStand(tr[0] + (dx / l) * need, tr[1] + (dy / l) * need)) {
      gx = tr[0] + (dx / l) * need;
      gy = tr[1] + (dy / l) * need;
    }
  }
  if (cut > 2) tr.splice(0, cut - 2); // keep one point behind the spot
  if (still && rest) {
    const side = rest.avoid !== undefined ? (rest.avoid >= ox ? -1 : 1) : s.px >= ox ? 1 : -1;
    for (const sx of [ox + side * rest.beside, ox - side * rest.beside]) {
      if (canStand(sx, oy)) {
        tr.length = 0;
        tr.push(sx, oy, ox, oy);
        gx = sx;
        gy = oy;
        break;
      }
    }
  } else if (still && hiddenShare(gx, gy, ox, oy) > 0.25) {
    // the spot is behind the owner (they face the camera): sit beside them instead. The trail now ends
    // at that side spot, so when the owner walks off the pet leaves from there without a jump.
    const side = s.px >= ox ? 1 : -1;
    for (const sx of [ox + side * gap, ox - side * gap]) {
      if (canStand(sx, oy)) {
        tr.length = 0;
        tr.push(sx, oy, ox, oy);
        gx = sx;
        gy = oy;
        break;
      }
    }
  }
  // Move to the spot at the owner's pace. Lag is what is left after this frame's normal advance, so the
  // rule does not depend on the frame rate: a small lag (a network correction) is closed at 1.15x the
  // owner's pace, a big one (the owner jumped: correction, short portal) with a proportional catch-up.
  // With the owner standing still the pet strolls.
  const ddx = gx - s.px, ddy = gy - s.py;
  const d = Math.hypot(ddx, ddy);
  const lag = Math.max(0, d - ownerV * dt);
  const step = still ? STROLL * dt : (ownerV * (lag > 2 ? 1.15 : 1) + Math.max(0, lag - 8) * 5) * dt;
  if (d > 0.3) {
    const k = Math.min(1, step / d);
    s.px += ddx * k;
    s.py += ddy * k;
    s.moving = true;
    s.dir = facing(ddx, ddy);
    s.restSince = now;
  } else {
    s.moving = false;
    if (now - s.restSince > 400) s.dir = facing(ox - s.px, oy - s.py); // settled: look at the owner
  }
}
