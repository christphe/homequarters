import { drawPetSheet, PET_H, PET_KINDS, PET_W } from "./pets";
import { drawSproutSheet } from "./sampleCreature";
import type { Ctx } from "./pixel";

// The sheets of the bundled pets plugin (plugins/bundled/hq-pets): the built-in pets and the
// seedling, one block of 4 rows (down, left, right, up) by 3 columns (idle, step A, step B) each, in
// PLUGIN_PET_KINDS order. Exported by e2e/export-art.mjs as pets.png (their own colours) and
// pets-tint.png (light greys that hq.setTint turns into any colour).

export const PLUGIN_PET_KINDS = [...PET_KINDS.slice(1), "seedling"] as const;

/** Both sheets: width 3 cells, height 4 rows per kind. */
export function drawPluginPetSheets(): { natural: HTMLCanvasElement; tint: HTMLCanvasElement } {
  const w = PET_W * 3, block = PET_H * 4;
  const natural = document.createElement("canvas");
  natural.width = w;
  natural.height = block * PLUGIN_PET_KINDS.length;
  const ctx = natural.getContext("2d", { willReadFrequently: true })!;
  for (let k = 1; k < PET_KINDS.length; k++) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = block;
    drawPetSheet(c.getContext("2d", { willReadFrequently: true })!, k);
    ctx.drawImage(c, 0, (k - 1) * block);
  }
  const sprout = document.createElement("canvas");
  sprout.width = w;
  sprout.height = block * 4; // every variant; the first one (meadow) is the plugin's
  drawSproutSheet(sprout.getContext("2d", { willReadFrequently: true })!);
  ctx.drawImage(sprout, 0, 0, w, block, 0, (PLUGIN_PET_KINDS.length - 1) * block, w, block);

  const tint = document.createElement("canvas");
  tint.width = natural.width;
  tint.height = natural.height;
  const tctx = tint.getContext("2d", { willReadFrequently: true })!;
  tctx.drawImage(natural, 0, 0);
  for (let k = 0; k < PLUGIN_PET_KINDS.length; k++) toTintable(tctx, 0, k * block, w, block);
  return { natural, tint };
}

/**
 * Turns one kind's block into greys a tint multiplies well: each pixel keeps its lightness, stretched so
 * the body's light tones come close to white (they take the chosen colour almost as is) while outlines,
 * eyes and shading stay dark. Transparency is kept.
 */
function toTintable(ctx: Ctx, x: number, y: number, w: number, h: number) {
  const img = ctx.getImageData(x, y, w, h);
  const d = img.data;
  const lum: number[] = [];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (l > 60) lum.push(l); // the body, not the outline
  }
  lum.sort((a, b) => a - b);
  const top = lum.length ? lum[Math.floor(lum.length * 0.85)] : 255; // a light body tone, not a highlight
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const g = Math.min(255, Math.round((l / top) * 205));
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, x, y);
}
