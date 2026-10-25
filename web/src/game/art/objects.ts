import type { MapData, Prop } from "../../net/protocol";
import { DEPTH_OBJECTS, T, deskOf, drawObject, propRect } from "./tiles";

/** One depth sprite: its cell in the atlas, where it goes on the map (world px) and its depth. */
export interface DepthPiece {
  t: string;
  sx: number;
  sy: number;
  w: number;
  h: number;
  x: number;
  y: number;
  z: number;
}

const ATLAS_W = 1024;

/** The box a depth object may paint: a desk rises above its tile (its top, a screen), a pc spreads
 * around the point it is centred on (screen, keyboard and mouse). */
function paintBox(p: Prop) {
  const r = propRect(p);
  if (p.t === "pc") {
    const cx = r.x + T / 2 + (p.dx ?? 0), top = r.y + (p.dy ?? 0);
    return { x: cx - T, y: top - T, w: 2 * T, h: 2 * T };
  }
  return { x: r.x, y: r.y - T, w: r.w, h: r.h + T };
}

/**
 * The desks and pcs drawn alone, each kept only where the finished bake shows exactly that pixel: where
 * something baked later covers the object (a neighbour rising over it), the sprite stays transparent,
 * so with nobody around the office looks as baked. Desks sort by their front edge, a pc just above its
 * desk. One cell per placed object, packed in rows.
 */
export function depthAtlas(map: MapData, baked: HTMLCanvasElement): { canvas: HTMLCanvasElement; pieces: DepthPiece[] } {
  const W = map.w * T, H = map.h * T;
  const bake = baked.getContext("2d")!.getImageData(0, 0, W, H).data;
  const scratch = document.createElement("canvas");
  const sctx = scratch.getContext("2d", { willReadFrequently: true })!;
  const cells: { piece: DepthPiece; data: ImageData }[] = [];
  for (const p of map.props) {
    if (!DEPTH_OBJECTS.has(p.t)) continue;
    const desk = p.t === "pc" ? deskOf(map.props, p) : p;
    if (!desk) continue;
    const b = paintBox(p);
    const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y), x1 = Math.min(W, b.x + b.w), y1 = Math.min(H, b.y + b.h);
    if (x1 <= x0 || y1 <= y0) continue;
    scratch.width = x1 - x0;
    scratch.height = y1 - y0; // also clears it
    sctx.setTransform(1, 0, 0, 1, -x0, -y0); // map pixels, so seeded details (a mug) match the bake
    drawObject(sctx, p, map.props);
    const img = sctx.getImageData(0, 0, scratch.width, scratch.height);
    const d = img.data;
    // keep what the bake shows of the object; trim to what is kept
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = 0; y < scratch.height; y++)
      for (let x = 0; x < scratch.width; x++) {
        const i = (y * scratch.width + x) * 4, j = ((y0 + y) * W + x0 + x) * 4;
        if (d[i + 3] === 255 && d[i] === bake[j] && d[i + 1] === bake[j + 1] && d[i + 2] === bake[j + 2] && bake[j + 3] === 255) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        } else d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
      }
    if (maxX < 0) continue;
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const out = new ImageData(w, h);
    for (let y = 0; y < h; y++) out.data.set(d.subarray(((minY + y) * scratch.width + minX) * 4, ((minY + y) * scratch.width + minX + w) * 4), y * w * 4);
    const dr = propRect(desk);
    cells.push({ piece: { t: p.t, sx: 0, sy: 0, w, h, x: x0 + minX, y: y0 + minY, z: dr.y + dr.h + (p.t === "pc" ? 0.5 : 0) }, data: out });
  }
  // shelf packing
  let x = 0, y = 0, row = 0;
  for (const c of cells) {
    if (x + c.piece.w > ATLAS_W) { x = 0; y += row; row = 0; }
    c.piece.sx = x;
    c.piece.sy = y;
    x += c.piece.w;
    row = Math.max(row, c.piece.h);
  }
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_W;
  canvas.height = Math.max(1, y + row);
  const ctx = canvas.getContext("2d")!;
  for (const c of cells) ctx.putImageData(c.data, c.piece.sx, c.piece.sy);
  return { canvas, pieces: cells.map((c) => c.piece) };
}
