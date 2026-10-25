// Packing of the depth sprites' atlas (art/objects.ts), apart so the unit tests load it under Node.

export const ATLAS_W = 1024;
/** Within what every GPU takes as a texture: an object that does not fit gets no depth sprite (it stays
 * baked), so a map of thousands of wide desks cannot make a texture the GPU refuses. */
export const ATLAS_MAX_H = 4096;

/** Places cells in rows, in order; null for a cell that does not fit. */
export function packCells(sizes: { w: number; h: number }[]): ({ sx: number; sy: number } | null)[] {
  let x = 0, y = 0, row = 0;
  return sizes.map(({ w, h }) => {
    if (w > ATLAS_W) return null;
    if (x + w > ATLAS_W) {
      x = 0;
      y += row;
      row = 0;
    }
    if (y + h > ATLAS_MAX_H) return null;
    const at = { sx: x, sy: y };
    x += w;
    row = Math.max(row, h);
    return at;
  });
}
