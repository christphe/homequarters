// Avatar looks: the retired "cap" hairstyle and the editor's labels. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { BEARD_IDS, HAIR_STYLE_IDS, HAT_IDS, LEGACY_CAP_STYLE, normaliseLook, type Look } from "../src/game/art/look.ts";
import { hasKey } from "../src/i18n.ts";
import { colorOf, HAIR, HAT_COLORS, PANTS, SHIRT, SKIN } from "../src/game/palette.ts";

const base: Look = { skin: "#f8d8b8", hair: "#c04830", hairStyle: 0, shirt: "#4890e0", pants: "#38405c", beard: 0, hat: 0, hatColor: "#3c2e48" };

// mirrors server/internal/httpapi/avatar_test.go: hs 5 becomes bald + a cap in the hair colour
test("the old cap hairstyle draws as bald + a cap in the hair colour", () => {
  assert.deepEqual(normaliseLook({ ...base, hairStyle: LEGACY_CAP_STYLE }), { ...base, hairStyle: 2, hat: 1, hatColor: base.hair });
});

test("an explicit hat wins over the old cap; other styles are untouched", () => {
  assert.deepEqual(normaliseLook({ ...base, hairStyle: LEGACY_CAP_STYLE, hat: 6 }), { ...base, hairStyle: 2, hat: 6 });
  for (let hs = 0; hs < HAIR_STYLE_IDS.length; hs++) if (hs !== LEGACY_CAP_STYLE) assert.equal(normaliseLook({ ...base, hairStyle: hs }).hairStyle, hs);
});

test("every hair style, beard and hat the editor lists has an English label", () => {
  const missing = [
    ...HAIR_STYLE_IDS.filter(Boolean).map((id) => "hair." + id),
    ...BEARD_IDS.map((id) => "beard." + id),
    ...HAT_IDS.map((id) => "hat." + id),
  ].filter((k) => !hasKey(k));
  assert.deepEqual(missing, []);
});

test("the server's ranges match the client's lists", async () => {
  const fs = await import("node:fs");
  const go = fs.readFileSync(new URL("../../server/internal/httpapi/avatar.go", import.meta.url), "utf8");
  // a server range left behind turns new choices back into 0 on save
  const n = (name: string) => Number(go.match(new RegExp(String.raw`\b${name}\s*=\s*(\d+)`))?.[1]);
  assert.equal(n("nHair"), HAIR_STYLE_IDS.length);
  assert.equal(n("nBeard"), BEARD_IDS.length);
  assert.equal(n("nHat"), HAT_IDS.length);
  assert.equal(n("nSkin"), SKIN.length);
  assert.equal(n("nHairColor"), HAIR.length);
  for (const p of [SHIRT, PANTS, HAT_COLORS]) assert.equal(n("nCloth"), p.length);
});

test("palettes only grow: the first colours keep their index, and hats start with the first eight hair colours", () => {
  assert.deepEqual(SKIN.slice(0, 6), ["#f8d8b8", "#ecc09a", "#d09868", "#a87048", "#7c4e30", "#523222"]);
  assert.deepEqual(HAIR.slice(0, 8), ["#3c2e48", "#5a3a28", "#8a5a30", "#e0b040", "#c04830", "#9a9aa8", "#3868b8", "#b04ca8"]);
  assert.deepEqual(HAT_COLORS.slice(0, 8), HAIR.slice(0, 8), "the retired cap maps hk = hc");
  assert.deepEqual(SHIRT.slice(0, 8), ["#e05048", "#f0a038", "#f0d848", "#58c068", "#38c0b0", "#4890e0", "#8860d0", "#f0f0f4"]);
  assert.deepEqual(PANTS.slice(0, 8), ["#38405c", "#4a5a7a", "#7a5232", "#3d5a3d", "#5a3a5a", "#8a8a98", "#b08a5a", "#26262e"]);
  for (const p of [SKIN, HAIR, SHIRT, PANTS, HAT_COLORS]) assert.equal(new Set(p).size, p.length, "no duplicate swatch");
});

test("a colour is a palette index or a custom #rrggbb; anything else draws as the first entry", () => {
  assert.equal(colorOf(3, SKIN), SKIN[3]);
  assert.equal(colorOf("#12ab9f", SKIN), "#12ab9f");
  for (const bad of [-1, 99, 1.5, "#ABC", "red", "#12ab9", undefined]) assert.equal(colorOf(bad as never, SKIN), SKIN[0], String(bad));
});
