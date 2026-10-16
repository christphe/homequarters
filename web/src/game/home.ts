import type { Area, MapData, Prop } from "../net/protocol";

// Where "go back to my desk" leads: next to the desk assigned to me, otherwise inside the private
// office I own. Pure so it can be tested without a browser.

// same rule as isMyOffice in protocol.ts (a type-only import keeps this module loadable by node --test)
const mine = (a: Area, me: number) => a.kind === "room" && a.access.mode === "office" && (a.access.users ?? []).includes(me);
const solidAt = (map: MapData, x: number, y: number) => x < 0 || y < 0 || x >= map.w || y >= map.h || map.solid[y]?.[x] === "1";

/** A free tile to stand on for my desk or office, or null when nothing is assigned to me. */
export function homeTile(map: MapData, me: number): { x: number; y: number } | null {
  const desk = map.props.find((p) => p.t === "desk" && p.assign === me);
  if (desk) {
    const w = desk.w ?? 2, h = desk.h ?? 1;
    // the chair side first (below the desk), then above, then either end
    const spots: [number, number][] = [];
    for (let x = desk.x; x < desk.x + w; x++) spots.push([x, desk.y + h]);
    for (let x = desk.x; x < desk.x + w; x++) spots.push([x, desk.y - 1]);
    for (let y = desk.y; y < desk.y + h; y++) spots.push([desk.x - 1, y], [desk.x + w, y]);
    const free = spots.find(([x, y]) => !solidAt(map, x, y));
    if (free) return { x: free[0], y: free[1] };
  }
  const office = map.areas.find((a) => mine(a, me));
  if (office) {
    const inside = (x: number, y: number) => x >= office.x && y >= office.y && x < office.x + office.w && y < office.y + office.h;
    const chair = map.props.find((p) => p.t === "chair" && inside(p.x, p.y) && !solidAt(map, p.x, p.y));
    if (chair) return { x: chair.x, y: chair.y }; // the office's own seat
    // otherwise the free tile nearest the middle of the office
    const cx = office.x + (office.w - 1) / 2, cy = office.y + (office.h - 1) / 2;
    let best: { x: number; y: number } | null = null, bestD = Infinity;
    for (let y = office.y; y < office.y + office.h; y++) {
      for (let x = office.x; x < office.x + office.w; x++) {
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < bestD && !solidAt(map, x, y)) { best = { x, y }; bestD = d; }
      }
    }
    if (best) return best;
  }
  return null;
}

/** px between my feet and a desk's rectangle to take it; the server's useReach. */
export const CLAIM_REACH = 20;

/** The free desk I stand next to and may take, or null. Same rules as the server (world.doClaimDesk):
 * I have no desk and no office, the desk is unassigned and not inside a room. */
export function claimableDesk(map: MapData, me: number, px: number, py: number): Prop | null {
  if (map.props.some((p) => p.t === "desk" && p.assign === me) || map.areas.some((a) => mine(a, me))) return null;
  const T = map.tile || 16;
  let best: Prop | null = null, bestD = CLAIM_REACH;
  for (const p of map.props) {
    if (p.t !== "desk" || p.assign) continue;
    if (map.areas.some((a) => a.kind === "room" && !a.auto && p.x >= a.x && p.y >= a.y && p.x < a.x + a.w && p.y < a.y + a.h)) continue;
    const w = p.w ?? 2, h = p.h ?? 1;
    const d = Math.hypot(Math.max(p.x * T - px, 0, px - (p.x + w) * T), Math.max(p.y * T - py, 0, py - (p.y + h) * T));
    if (d <= bestD) { bestD = d; best = p; }
  }
  return best;
}

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
type ModKeyEvent = { code: string; key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };
/** Ctrl+<letter>, or Cmd+<letter> on a Mac (where Ctrl+letter edits text fields), by key position. */
function isModKey(e: ModKeyEvent, code: string, mac: boolean) {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.altKey && !e.shiftKey && (e.code ? e.code === code : e.key.toLowerCase() === code.slice(3).toLowerCase());
}
/** Ctrl+D / Cmd+D: back to my desk. */
export const isHomeKey = (e: ModKeyEvent, mac = isMac()) => isModKey(e, "KeyD", mac);
/** Ctrl+U / Cmd+U ("unavailable"): busy, or available again. */
export const isBusyKey = (e: ModKeyEvent, mac = isMac()) => isModKey(e, "KeyU", mac);
