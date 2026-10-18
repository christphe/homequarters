import { dark, light, px, type Ctx } from "./pixel";
import { outline, PET_H, PET_W } from "./pets";

// The creature of the sample plugin (plugins/sample-pet): a round seedling with a two-leaf sprout,
// drawn by code in the house style like the built-in pets. Original design; nothing is traced or
// extracted from any game. Exported to plugins/sample-pet/public/creatures.png by e2e/export-art.mjs.
// Sheet: 16 x 16 cells, 3 columns (idle, step A, step B) by 4 rows (down, left, right, up) per variant,
// variants stacked: 48 x 256 px.

export const SPROUT_VARIANTS = [
  { name: "meadow", body: "#a7d97a", leaf: "#3f9b4a", cheek: "#f0a0a0" },
  { name: "blossom", body: "#f7c6d6", leaf: "#d9507a", cheek: "#ff8fb0" },
  { name: "ember", body: "#f2ad5c", leaf: "#b5462a", cheek: "#ff9a7a" },
  { name: "frost", body: "#b3d8f5", leaf: "#4a7fd0", cheek: "#f4b8d0" },
] as const;

const EYE = "#241c34";
const SHADOW = "rgba(40,24,90,0.30)";

/** One cell: dir 0 down, 1 left, 3 up (right is the mirrored left); frame 0 idle, 1 and 2 steps. */
function drawSprout(ctx: Ctx, ox: number, oy: number, dir: number, frame: number, v: (typeof SPROUT_VARIANTS)[number]) {
  const r = (x: number, y: number, w: number, h: number, c: string) => px(ctx, ox + x, oy + y, w, h, c);
  const bob = frame === 0 ? 0 : -1;
  const shade = dark(v.body, 0.22);
  // shadow and feet
  r(4, 14, 8, 1, SHADOW);
  const lf = frame === 1 ? 1 : 0, rf = frame === 2 ? 1 : 0;
  r(5, 13 - lf, 2, 1 + lf, shade);
  r(9, 13 - rf, 2, 1 + rf, shade);
  // round body
  r(5, 7 + bob, 6, 1, v.body);
  r(4, 8 + bob, 8, 4, v.body);
  r(5, 12 + bob, 6, 1, shade);
  r(4, 11 + bob, 8, 1, shade);
  r(5, 8 + bob, 2, 1, light(v.body, 0.45)); // highlight
  // sprout: a stalk and two leaves that sway with the step
  const sway = frame === 1 ? -1 : frame === 2 ? 1 : 0;
  r(7 + (sway > 0 ? 1 : 0), 4 + bob, 1, 3, dark(v.leaf, 0.15));
  r(4 + sway, 3 + bob, 3, 2, v.leaf);
  r(5 + sway, 2 + bob, 2, 1, light(v.leaf, 0.3));
  r(9 + sway, 3 + bob, 3, 2, v.leaf);
  r(9 + sway, 2 + bob, 2, 1, light(v.leaf, 0.3));
  if (dir === 3) {
    r(6, 9 + bob, 4, 1, dark(v.body, 0.1)); // back seam, no face
    return;
  }
  if (dir === 0) {
    r(5, 9 + bob, 1, 2, EYE);
    r(10, 9 + bob, 1, 2, EYE);
    r(4, 11 + bob, 1, 1, v.cheek);
    r(11, 11 + bob, 1, 1, v.cheek);
    r(7, 11 + bob, 2, 1, dark(v.body, 0.35)); // smile
  } else {
    // facing left
    r(5, 9 + bob, 1, 2, EYE);
    r(4, 11 + bob, 1, 1, v.cheek);
    r(4, 10 + bob, 1, 1, dark(v.body, 0.35));
  }
}

/** Draws every variant's sheet, stacked (48 x 256). */
export function drawSproutSheet(ctx: Ctx) {
  const tmp = document.createElement("canvas");
  tmp.width = PET_W;
  tmp.height = PET_H;
  const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
  SPROUT_VARIANTS.forEach((v, i) => {
    const y0 = i * 4 * PET_H;
    for (let f = 0; f < 3; f++) {
      for (const dir of [0, 1, 3]) drawSprout(ctx, f * PET_W, y0 + dir * PET_H, dir, f, v);
      tctx.clearRect(0, 0, PET_W, PET_H);
      drawSprout(tctx, 0, 0, 1, f, v);
      ctx.save();
      ctx.translate(f * PET_W + PET_W, y0 + 2 * PET_H);
      ctx.scale(-1, 1);
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
    }
    for (let row = 0; row < 4; row++) for (let f = 0; f < 3; f++) outline(ctx, f * PET_W, y0 + row * PET_H);
  });
}
