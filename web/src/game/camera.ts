// The camera, no PixiJS: the integer scale and its zoom steps (remembered behind an injected storage),
// the pan, where the world sits on screen, and the interest radius the visible map needs from the
// server. Screen sizes come in as arguments; nothing here allocates per frame.

// Reference view in world pixels. A 240x160 handheld screen would be 15x10 tiles; an office wants a little more room.
export const VIEW_REF_W = 320;
export const VIEW_REF_H = 200;
export const MAX_SCALE = 8;
// world px kept inside the interest radius beyond what is visible: a sprite drawn above its feet,
// and my predicted position running ahead of the server's
export const VIEW_PAD = 24;
const ZOOM_KEY = "hq.zoom";

/** The automatic scale for a W x H screen: the reference view scaled by a whole number, 2 to 6. */
export function autoScale(width: number, height: number) {
  return Math.max(2, Math.min(6, Math.floor(Math.min(width / VIEW_REF_W, height / VIEW_REF_H))));
}

/**
 * Camera offset c (screen px, one axis) moved as little as possible so the visible map stays within
 * R world px of the player at p; when the window is wider than 2R both ends cannot hold: centre on p.
 */
export function reachClamp(c: number, W: number, S: number, p: number, R: number, mapLen: number) {
  const hi = p - R > 0 ? (R - p) * S : Infinity; // the map's near end is out of reach: c at most this
  const lo = p + R < mapLen ? W - (p + R) * S : -Infinity; // the far end is out of reach: c at least this
  if (lo > hi) return W / 2 - p * S;
  return Math.min(hi, Math.max(lo, c));
}

/** Where the zoom is remembered between visits. */
export interface ZoomStore {
  read(): number;
  write(zoom: number): void;
}

/** A ZoomStore over a Storage (localStorage), reached through `storage` so that a blocked one only means no memory. */
export function zoomStore(storage: () => Pick<Storage, "getItem" | "setItem">): ZoomStore {
  return {
    read() {
      try {
        return Math.round(Number(storage().getItem(ZOOM_KEY))) || 0;
      } catch {
        return 0;
      }
    },
    write(zoom) {
      try {
        storage().setItem(ZOOM_KEY, String(zoom));
      } catch {
        // storage blocked: the zoom is just not remembered
      }
    },
  };
}

export class Camera {
  /** Screen px per world px: whole numbers keep pixel art crisp. */
  S = 3;
  /** Whole steps away from the automatic scale (wheel); negative = farther. */
  zoom: number;
  /** Pan (left-drag with a mouse): world px added to the followed position; moving recentres. */
  panX = 0;
  panY = 0;
  /** Where the world's origin is on screen (whole screen px). */
  x = 0;
  y = 0;
  /** The server's area of interest (hello): its cell size (0 = not known yet), default and largest radius in cells. */
  cellPx = 0;
  aoi = 0;
  aoiMax = 0;
  private viewCells = 0; // radius last asked for (0 = the server default)
  private store: ZoomStore;

  constructor(store: ZoomStore) {
    this.store = store;
    this.zoom = store.read();
  }

  /** From hello: the server's interest grid, which bounds how far out the map may zoom. */
  setInterest(cellPx: number, aoi: number, aoiMax: number) {
    this.cellPx = cellPx;
    this.aoi = aoi;
    this.aoiMax = Math.max(aoi, aoiMax);
    this.viewCells = -1; // tell each new connection, even when it is the default
  }

  /** Smallest and largest scale for a W x H screen. */
  range(width: number, height: number): [number, number] {
    const auto = autoScale(width, height);
    // Farthest out: half the visible map must fit the largest radius the server grants, or people
    // near the screen edge would be missing. Before hello (unknown radius) only the automatic scale.
    const reach = this.aoiMax * this.cellPx - VIEW_PAD;
    const lo = this.cellPx ? Math.min(auto, Math.max(1, Math.ceil(Math.max(width, height) / (2 * reach)))) : auto;
    return [lo, Math.max(auto, MAX_SCALE)];
  }

  /** Sets the scale for a W x H screen: the automatic one moved by the zoom, within range; returns it. */
  fit(width: number, height: number) {
    // integer zoom keeps pixel art crisp; the reference view is a handheld-style screen scaled by
    // whole numbers, then moved by the wheel within what the server's area of interest can fill
    const auto = autoScale(width, height);
    const [lo, hi] = this.range(width, height);
    this.S = Math.max(lo, Math.min(hi, auto + this.zoom));
    return this.S;
  }

  /** Zooms by whole scale steps (positive = closer) and returns the scale in use. */
  zoomBy(steps: number, width: number, height: number) {
    this.zoom += steps;
    this.fit(width, height);
    if (!this.cellPx) return this.S; // limits are not known before hello: keep the remembered zoom
    this.zoom = this.S - autoScale(width, height); // forget steps past a limit
    this.store.write(this.zoom);
    return this.S;
  }

  /** Sets the pan so that the camera sits at screen offset (camX, camY) while following world point (fx, fy). */
  panTo(camX: number, camY: number, width: number, height: number, fx: number, fy: number) {
    this.panX = (width / 2 - camX) / this.S - fx;
    this.panY = (height / 2 - camY) / this.S - fy;
  }

  /**
   * Places the camera on a W x H screen following world point (px, py) (where my avatar is drawn), on
   * a map of mapW x mapH world px. Returns whether it moved.
   */
  follow(width: number, height: number, px: number, py: number, mapW: number, mapH: number) {
    const S = this.S;
    // The middle of the screen may go anywhere on the office but never past its edges: at the top of
    // the office the open space sits mid-screen, clear of the toolbars, with at most half a screen of
    // margin beyond the map. Following me, I stay in the middle; a pan stops at the office's edge.
    const vx = Math.max(0, Math.min(mapW, px + this.panX)), vy = Math.max(0, Math.min(mapH, py + this.panY));
    let cx = width / 2 - vx * S, cy = height / 2 - vy * S;
    // Never show map farther from me than the server's largest interest radius reaches: zoomed far
    // out next to a map edge the camera stops following the edge and shows a margin instead of
    // people the server does not send. A no-op whenever the visible map is already within reach.
    if (this.cellPx) {
      const R = this.aoiMax * this.cellPx - VIEW_PAD;
      cx = reachClamp(cx, width, S, px, R, mapW);
      cy = reachClamp(cy, height, S, py, R, mapH);
    }
    const x = Math.round(cx), y = Math.round(cy);
    const moved = x !== this.x || y !== this.y;
    this.x = x;
    this.y = y;
    return moved;
  }

  /**
   * The interest radius (server cells) the visible map needs around me at (px, py), when it differs
   * from the last one asked for; -1 when nothing needs asking. The server subscribes whole cells
   * around the player's cell, so a radius of r cells reaches at least r cells of pixels from the
   * player in every direction; asking for the distance to the farthest visible map pixel keeps the
   * request steady while walking (no flip-flop at cell boundaries).
   */
  view(width: number, height: number, px: number, py: number, mapW: number, mapH: number) {
    if (!this.cellPx) return -1;
    const S = this.S;
    const left = Math.max(0, -this.x / S), right = Math.min(mapW, (width - this.x) / S);
    const top = Math.max(0, -this.y / S), bottom = Math.min(mapH, (height - this.y) / S);
    const far = Math.max(px - left, right - px, py - top, bottom - py);
    const need = Math.max(this.aoi, Math.min(this.aoiMax, Math.ceil((far + VIEW_PAD) / this.cellPx - 1e-6)));
    if (need === (this.viewCells || this.aoi)) return -1;
    this.viewCells = need;
    return need;
  }
}
