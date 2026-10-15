import { Rectangle, Texture } from "pixi.js";
import type { AvatarSpec } from "../net/protocol";
import { BEARD_IDS, CELL_H, CELL_W, FEET_Y, drawSheet, HAIR_STYLE_IDS, HAT_IDS, LEGACY_CAP_STYLE, type Look } from "./art/characters";
import { LookCache } from "./lookCache";
import { colorOf, HAIR, HAT_COLORS, PANTS, SHIRT, SKIN } from "./palette";

// Procedural pixel-art avatars. One small canvas per distinct look (4 directions x
// 3 frames); all frames share one GPU texture, shared by everybody wearing that look and
// destroyed when the last of them changes look or leaves (see lookCache.ts).
// The painting itself lives in ./art/characters (pure canvas, no PixiJS).
export { CELL_H, CELL_W, FEET_Y };

/** [dir][frame] (dirs: 0 down, 1 left, 2 right, 3 up); `tall` is how far the drawing rises above the feet, in px. */
export type AvatarFrames = Texture[][] & { tall: number };

const cache = new LookCache<AvatarFrames>((frames) => frames[0][0].source.destroy());

export function avatarKey(a: AvatarSpec) {
  return `${a.sk}-${a.hs}-${a.hc}-${a.sh}-${a.pa}-${a.bd ?? 0}-${a.ht ?? 0}-${a.hk ?? 0}`;
}

/** The retired "cap" hairstyle as the editor shows it: bald + a cap in the hair colour (the server does the same). */
export function normaliseSpec(a: AvatarSpec): AvatarSpec {
  if (a.hs !== LEGACY_CAP_STYLE) return a;
  return a.ht ? { ...a, hs: 2 } : { ...a, hs: 2, ht: 1, hk: a.hc };
}

// out-of-range indexes draw as 0, like the server would store them
const idx = (v: number | undefined, n: number) => (Number.isInteger(v) && v! >= 0 && v! < n ? v! : 0);

function lookOf(a: AvatarSpec): Look {
  return {
    skin: colorOf(a.sk, SKIN),
    hair: colorOf(a.hc, HAIR),
    hairStyle: idx(a.hs, HAIR_STYLE_IDS.length),
    shirt: colorOf(a.sh, SHIRT),
    pants: colorOf(a.pa, PANTS),
    beard: idx(a.bd, BEARD_IDS.length),
    hat: idx(a.ht, HAT_IDS.length),
    hatColor: colorOf(a.hk, HAT_COLORS),
  };
}

/** Frames for person `id` wearing `a`; their previous look is released. */
export function avatarFramesFor(id: number, a: AvatarSpec): AvatarFrames {
  return cache.acquire(id, avatarKey(a), () => buildFrames(a));
}

/** Person `id` left the office: their look is freed unless somebody else wears it. */
export function releaseAvatar(id: number) {
  cache.release(id);
}

export const cachedLooks = () => cache.size;

// the highest opaque row of any frame, in cell rows
function topRow(canvas: HTMLCanvasElement): number {
  const d = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
  let top = CELL_H;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) top = Math.min(top, Math.floor(i / 4 / canvas.width) % CELL_H);
  return top;
}

function buildFrames(a: AvatarSpec): AvatarFrames {
  const canvas = document.createElement("canvas");
  canvas.width = CELL_W * 3;
  canvas.height = CELL_H * 4;
  drawSheet(canvas.getContext("2d", { willReadFrequently: true })!, lookOf(a));
  const base = Texture.from(canvas);
  base.source.scaleMode = "nearest";
  const frames = [] as unknown as AvatarFrames;
  frames.tall = FEET_Y - topRow(canvas);
  for (let dir = 0; dir < 4; dir++) {
    frames.push([]);
    for (let f = 0; f < 3; f++) {
      frames[dir].push(new Texture({ source: base.source, frame: new Rectangle(f * CELL_W, dir * CELL_H, CELL_W, CELL_H) }));
    }
  }
  return frames;
}

/** Draws the full 4-direction x 3-frame sheet (used by docs/asset generation). */
export function drawAvatarSheet(canvas: HTMLCanvasElement, a: AvatarSpec) {
  canvas.width = CELL_W * 3;
  canvas.height = CELL_H * 4;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawSheet(ctx, lookOf(a));
}

/** Draws one standing frame (used by the avatar editor UI). */
export function drawAvatarPreview(canvas: HTMLCanvasElement, a: AvatarSpec, dir = 0) {
  const sheet = document.createElement("canvas");
  drawAvatarSheet(sheet, a);
  canvas.width = CELL_W;
  canvas.height = CELL_H;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, CELL_W, CELL_H);
  ctx.drawImage(sheet, 0, dir * CELL_H, CELL_W, CELL_H, 0, 0, CELL_W, CELL_H);
}
