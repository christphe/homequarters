// Original palettes for this project (no third-party art). Slightly warm, saturated GBA-era tones.
// Indexes are stored in profiles: only ever append, never reorder. Any "#rrggbb" is accepted too (custom colour).
export const SKIN = [
  "#f8d8b8", "#ecc09a", "#d09868", "#a87048", "#7c4e30", "#523222",
  "#fde6d4", "#f2c9a8", "#e0aa7c", "#c08a5c", "#94603c", "#3a2218",
];
const HAIR_V1 = ["#3c2e48", "#5a3a28", "#8a5a30", "#e0b040", "#c04830", "#9a9aa8", "#3868b8", "#b04ca8"];
export const HAIR = [
  ...HAIR_V1,
  "#1c1820", "#7a4a2c", "#b07848", "#f0d890", "#e07830", "#ececf2", "#48a868", "#e86898",
];
// sixteen more colours for clothes and hats, after the eight each list started with
const CLOTH_MORE = [
  "#a03040", "#e87090", "#f8c8d8", "#c0e070", "#2e7a48", "#88d8f0", "#2850a0", "#b8a0e8",
  "#5a2a78", "#a06030", "#d8c098", "#707888", "#303038", "#141418", "#f0e6d0", "#e8c040",
];
export const SHIRT = ["#e05048", "#f0a038", "#f0d848", "#58c068", "#38c0b0", "#4890e0", "#8860d0", "#f0f0f4", ...CLOTH_MORE];
export const PANTS = ["#38405c", "#4a5a7a", "#7a5232", "#3d5a3d", "#5a3a5a", "#8a8a98", "#b08a5a", "#26262e", ...CLOTH_MORE];
// Hats start with the first eight hair colours so the retired "cap" hairstyle keeps its colour (hk = hc).
export const HAT_COLORS = [...HAIR_V1, ...CLOTH_MORE];

const HEX = /^#[0-9a-f]{6}$/;

/** A stored colour: a palette index, or a custom "#rrggbb". Anything else draws as the first entry. */
export function colorOf(v: number | string | undefined, palette: readonly string[]): string {
  if (typeof v === "string") return HEX.test(v) ? v : palette[0];
  return Number.isInteger(v) && v! >= 0 && v! < palette.length ? palette[v!] : palette[0];
}
