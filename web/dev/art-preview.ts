// Dev-only page: renders the procedural art without a server.
// Open /dev/art-preview.html under Vite (pnpm exec vite). e2e/export-art.mjs reads window.artExport
// to write the sprite sheets and the baked map used by the README and the website.
import { drawPluginPetSheets } from "../src/game/art/pluginPets";
import { drawSproutSheet, SPROUT_VARIANTS } from "../src/game/art/sampleCreature";
import { bakeMapCanvas } from "../src/game/art/tiles";
import { BEARD_IDS, CELL_H, CELL_W, drawSheet, HAIR_STYLE_IDS, HAT_IDS, LEGACY_CAP_STYLE, type Look } from "../src/game/art/characters";
import { drawPetSheet, PET_H, PET_KINDS, PET_W } from "../src/game/art/pets";
import { HAIR, HAT_COLORS, PANTS, SHIRT, SKIN } from "../src/game/palette";
import map from "./default-map.json";

const params = new URLSearchParams(location.search);
const scale = Number(params.get("s") ?? 4);

// name, skin, hair style, hair colour, shirt, pants  (indexes into palette.ts). These ten are pixel goldens:
// site/assets/sheet-*.png must not change when the painter grows (bruno and cap-green use the retired cap style 5).
const CAST: [string, number, number, number, number, number][] = [
  ["marina", 2, 1, 0, 4, 1],
  ["bruno", 4, 5, 4, 1, 7],
  ["carla", 0, 4, 3, 6, 3],
  ["diego", 1, 3, 6, 5, 0],
  ["elisa", 3, 0, 7, 2, 4],
  ["fabio", 5, 2, 1, 0, 2],
];
const extra: [string, number, number, number, number, number][] = [
  ["short-blue", 1, 0, 1, 4, 1],
  ["long-blond", 0, 1, 3, 2, 5],
  ["cap-green", 2, 5, 2, 3, 6],
  ["bun-plum", 3, 4, 7, 6, 4],
];

const sheets: Record<string, string> = {};
const host = document.getElementById("sheets")!;
for (const [name, sk, hs, hc, sh, pa] of [...CAST, ...extra]) {
  const c = document.createElement("canvas");
  c.width = CELL_W * 3;
  c.height = CELL_H * 4;
  drawSheet(c.getContext("2d", { willReadFrequently: true })!, { skin: SKIN[sk], hairStyle: hs, hair: HAIR[hc], shirt: SHIRT[sh], pants: PANTS[pa], beard: 0, hat: 0, hatColor: HAT_COLORS[0] });
  sheets[name] = c.toDataURL("image/png");
  c.style.width = c.width * scale + "px";
  host.appendChild(c);
}
// Wardrobe: every hair style, beard and hat, idle frame in the four directions.
const wardrobe = document.getElementById("wardrobe")!;
const base: Look = { skin: SKIN[1], hair: HAIR[1], hairStyle: 0, shirt: SHIRT[5], pants: PANTS[0], beard: 0, hat: 0, hatColor: HAT_COLORS[0] };
const section = (title: string) => {
  const h = document.createElement("h3");
  h.textContent = title;
  wardrobe.appendChild(h);
};
const item = (label: string, k: Look) => {
  const sheet = document.createElement("canvas");
  sheet.width = CELL_W * 3;
  sheet.height = CELL_H * 4;
  drawSheet(sheet.getContext("2d", { willReadFrequently: true })!, k);
  const c = document.createElement("canvas");
  c.width = CELL_W * 4;
  c.height = CELL_H;
  const ctx = c.getContext("2d")!;
  for (let d = 0; d < 4; d++) ctx.drawImage(sheet, 0, d * CELL_H, CELL_W, CELL_H, d * CELL_W, 0, CELL_W, CELL_H);
  c.style.width = c.width * (scale / 2) + "px";
  const fig = document.createElement("figure");
  const cap = document.createElement("figcaption");
  cap.textContent = label;
  fig.append(c, cap);
  wardrobe.appendChild(fig);
};
section("Hair styles");
HAIR_STYLE_IDS.forEach((id, i) => i !== LEGACY_CAP_STYLE && item(id, { ...base, hairStyle: i, hair: HAIR[(i % 7) + 1] }));
section("Beards (in the hair colour)");
BEARD_IDS.forEach((id, i) => i > 0 && item(id, { ...base, beard: i, hairStyle: i === 5 ? 9 : 0, hair: HAIR[[0, 1, 2, 5, 4, 5][i]], skin: SKIN[i % 6] }));
section("Hats (own colour; hair above the crown is hidden)");
HAT_IDS.forEach((id, i) => i > 0 && item(id, { ...base, hat: i, hatColor: HAT_COLORS[[0, 6, 4, 0, 0, 0, 4, 0, 7, 6][i]], hairStyle: [0, 0, 1, 3, 0, 8, 0, 1, 2, 1][i], beard: i === 7 ? 4 : 0 }));
section("Combinations");
item("legacy cap (hs 5)", { ...base, hairStyle: LEGACY_CAP_STYLE, hair: HAIR[4] });
item("afro + beanie", { ...base, hairStyle: 7, hat: 2, hatColor: HAT_COLORS[3], skin: SKIN[4] });
item("mohawk + headphones", { ...base, hairStyle: 10, hat: 3, hatColor: HAT_COLORS[6], hair: HAIR[7] });
item("pigtails + beret", { ...base, hairStyle: 11, hat: 6, hatColor: HAT_COLORS[4], hair: HAIR[3], skin: SKIN[0] });
item("balding + long beard", { ...base, hairStyle: 9, beard: 5, hair: HAIR[5], skin: SKIN[2] });
item("afro + hijab", { ...base, hairStyle: 7, hat: 9, hatColor: HAT_COLORS[7], skin: SKIN[4] });
item("pigtails + hijab", { ...base, hairStyle: 11, hat: 9, hatColor: HAT_COLORS[5], skin: SKIN[0] });
item("bun + top hat + goatee", { ...base, hairStyle: 4, hat: 5, beard: 3, hair: HAIR[0] });
section("Hard cases: beards on skin close to the hair colour, look-alikes, hats over tall hair");
for (const [sk, hc] of [[5, 0], [4, 0], [4, 1], [3, 5], [2, 3], [1, 3]]) for (let b = 1; b < BEARD_IDS.length; b++) item(`skin ${sk}, hair ${hc}: ${BEARD_IDS[b]}`, { ...base, skin: SKIN[sk], hair: HAIR[hc], beard: b });
item("fair skin, blond: stubble", { ...base, skin: SKIN[1], hair: HAIR[3], beard: 1 });
item("balding", { ...base, hairStyle: 9 });
item("bald + headphones", { ...base, hairStyle: 2, hat: 3 });
for (const hs of [3, 4, 10, 6, 7]) for (const ht of [3, 4, 5]) item(HAIR_STYLE_IDS[hs] + " + " + HAT_IDS[ht], { ...base, hairStyle: hs, hat: ht, hatColor: HAT_COLORS[6], hair: HAIR[4] });

const pets: Record<string, string> = {};
for (let k = 1; k < PET_KINDS.length; k++) {
  const c = document.createElement("canvas");
  c.width = PET_W * 3;
  c.height = PET_H * 4;
  c.className = "pet";
  drawPetSheet(c.getContext("2d", { willReadFrequently: true })!, k);
  pets[PET_KINDS[k]] = c.toDataURL("image/png");
  c.style.width = c.width * scale + "px";
  host.appendChild(c);
}
const sc = document.createElement("canvas");
sc.width = PET_W * 3;
sc.height = PET_H * 4 * SPROUT_VARIANTS.length;
sc.className = "pet";
drawSproutSheet(sc.getContext("2d", { willReadFrequently: true })!);
sc.style.width = sc.width * scale + "px";
sc.title = "sample plugin creature (plugins/bundled/hq-pets)";
host.appendChild(sc);
// the bundled pets plugin's sheets: their own colours, and the light greys a tint colours
const plug = drawPluginPetSheets();
for (const c of [plug.natural, plug.tint]) {
  c.className = "pet";
  c.style.width = c.width * scale + "px";
  c.title = "plugins/bundled/hq-pets";
  host.appendChild(c);
}
const mc = bakeMapCanvas({ ...(map as object), tile: 16, solid: [] } as never);
mc.style.width = mc.width * (scale / 2) + "px";
mc.id = "map";
document.getElementById("map")!.replaceWith(mc);
(window as unknown as { artExport: unknown }).artExport = { sheets, pets, sprout: sc.toDataURL("image/png"), pluginPets: plug.natural.toDataURL("image/png"), pluginPetsTint: plug.tint.toDataURL("image/png"), map: mc.toDataURL("image/png") };
(window as unknown as { ready: boolean }).ready = true;
