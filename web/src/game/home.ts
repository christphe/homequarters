import type { Area, MapData } from "../net/protocol";

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

/** Ctrl+D, or Cmd+D on a Mac (where Ctrl+D deletes forward in text fields). */
export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export function isHomeKey(e: { code: string; key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, mac = isMac()) {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.altKey && !e.shiftKey && (e.code ? e.code === "KeyD" : e.key.toLowerCase() === "d");
}
