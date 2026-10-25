// Which area of the map a point is in, which area is named to the player for it, and when walking
// changes either. Plain data, no PixiJS: WorldView draws, this decides.
import type { MapData, Prop } from "../net/protocol";

const T = 16;

/** Area index per tile (-1 outside every area); rooms are painted over plain areas, so a room inside an area wins. */
export function areaGrid(map: MapData) {
  const at = new Int16Array(map.w * map.h).fill(-1);
  for (let pass = 0; pass < 2; pass++)
    map.areas.forEach((a, i) => {
      if ((a.kind === "room") !== (pass === 1)) return;
      for (let y = a.y; y < a.y + a.h; y++) for (let x = a.x; x < a.x + a.w; x++) at[y * map.w + x] = i;
    });
  return at;
}

/**
 * The area named to the player for each area: itself, or for a desk room (derived from an assigned
 * desk, "auto") the last non-room area holding its top-left corner, -1 when none does.
 */
export function shownAreas(map: MapData) {
  return new Int16Array(map.areas.length).map((_, i) => {
    const a = map.areas[i];
    if (!a.auto) return i;
    return map.areas.findLastIndex((p) => p.kind !== "room" && a.x >= p.x && a.y >= p.y && a.x < p.x + p.w && a.y < p.y + p.h);
  });
}

/** The desk room the server derived from an assigned desk, or -1. */
export function deskRoom(map: MapData, p: Prop) {
  return map.areas.findIndex((a) => a.auto && a.id === `desk-${p.x}-${p.y}`);
}

/** The area index at world point (x, y) on a w x h tile grid, -1 outside the map or every area. */
export function areaIndex(g: { w: number; h: number; areaAt: Int16Array }, x: number, y: number) {
  const tx = Math.floor(x / T), ty = Math.floor(y / T);
  if (tx < 0 || ty < 0 || tx >= g.w || ty >= g.h) return -1;
  return g.areaAt[ty * g.w + tx];
}

/** The area to name for area index ai (a desk room shows as the area around it), or -1. */
export function shownArea(shownOf: Int16Array, ai: number) {
  return ai >= 0 ? shownOf[ai] ?? ai : -1;
}

/** What entering an area changed: nothing, the area only (a desk room in the same area), or the area shown too. */
export const SAME = 0, AREA = 1, SHOWN = 2;

/** Where the local player is: the area index (room access) and the area shown for it (the signboard). */
export class Whereabouts {
  area = -1;
  shown = -1;

  /** Moves to area ai: returns SAME, AREA or SHOWN (the signboard names a new area, or none when -1). */
  enter(ai: number, shownOf: Int16Array): number {
    if (ai === this.area) return SAME;
    this.area = ai;
    const shown = shownArea(shownOf, ai);
    if (shown === this.shown) return AREA;
    this.shown = shown;
    return SHOWN;
  }
}
