// Avatar looks: the retired "cap" hairstyle and the editor's labels. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { BEARD_IDS, HAIR_STYLE_IDS, HAT_IDS, LEGACY_CAP_STYLE, normaliseLook, type Look } from "../src/game/art/look.ts";
import { hasKey } from "../src/i18n.ts";

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
});
