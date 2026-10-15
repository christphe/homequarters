import { normaliseLook, type Look } from "./look";
import { dark, deep, light, mix, px, rgb, type Ctx } from "./pixel";

// Overworld characters: "chibi" proportions (the head is over half of the sprite), 3/4 view,
// three walk frames per direction. The body is 16 x 24 px inside an 18 x 30 cell: a 1 px outline margin
// around it and 4 more rows on top, so hats and tall hair can rise above the head.
export const CELL_W = 18;
export const CELL_H = 30;
export const FEET_Y = 28; // y of the feet line inside a cell
const ORIGIN_Y = 6; // cell row of content y = 0; content y down to -6 is drawable above the head

export { BEARD_IDS, HAIR_STYLE_IDS, HAT_IDS, LEGACY_CAP_STYLE, normaliseLook, type Look } from "./look";

const SHOE = "#f2f0f6"; // white sneakers
const SOLE = "#8c88a4";
const EYE = "#241c34";
const TIE = "#e05048"; // hair ties and hat ribbons
const GOLD = "#f0c040";
const BADGE = "#f6f4ee";

type P = (x: number, y: number, w: number, h: number, c: string) => void;

// two-row sneaker: bright upper, grey sole
function shoe(R: P, x: number, y: number, w: number) {
  R(x, y, w, 1, SHOE);
  R(x, y + 1, w, 1, SOLE);
}

// Layout (content coordinates, y grows down; y -6..1 is room for spikes, buns and hat crowns):
//   head 12 x 11 at y2..12 · torso y13..17 · legs y18..19 · sneakers y20..21 · shadow y22..23

function headFront(R: P, k: Look) {
  const sk = k.skin;
  R(4, 2, 8, 1, sk);
  R(3, 3, 10, 1, sk);
  R(2, 4, 12, 8, sk);
  R(2, 11, 12, 1, dark(sk, 0.1));
  R(3, 12, 10, 1, dark(sk, 0.24));
  R(3, 4, 3, 1, light(sk, 0.18));
}

function faceFront(R: P, k: Look) {
  const bl = mix(k.skin, "#ff7c86", 0.38);
  R(5, 8, 1, 2, EYE);
  R(10, 8, 1, 2, EYE);
  R(3, 10, 2, 1, bl);
  R(11, 10, 2, 1, bl);
}

function hairTop(R: P, k: Look) {
  const h = k.hair, hl = light(h, 0.32), hd = dark(h, 0.3);
  R(4, 1, 8, 1, h);
  R(3, 2, 10, 1, h);
  R(2, 3, 12, 2, h);
  R(5, 1, 4, 1, hl);
  R(4, 2, 3, 1, hl);
  R(2, 4, 1, 1, hd);
  R(13, 4, 1, 1, hd);
}

const shaved = (k: Look) => mix(k.skin, k.hair, 0.3);

function hairFront(R: P, k: Look) {
  const h = k.hair, hd = dark(h, 0.3), hl = light(h, 0.32);
  switch (k.hairStyle) {
    case 2: // bald: just a shine
      R(5, 3, 3, 1, light(k.skin, 0.32));
      return;
    case 9: // balding: shiny crown, thin wisps down the temples
      R(5, 3, 3, 1, light(k.skin, 0.32));
      R(2, 5, 1, 4, h);
      R(13, 5, 1, 4, h);
      R(3, 5, 1, 2, h);
      R(12, 5, 1, 2, h);
      R(2, 8, 1, 1, hd);
      R(13, 8, 1, 1, hd);
      return;
    case 10: // mohawk: shaved sides, one crest
      R(4, 3, 2, 2, shaved(k));
      R(10, 3, 2, 2, shaved(k));
      R(6, -1, 4, 5, h);
      R(7, -1, 1, 4, hl);
      R(6, 4, 4, 1, hd);
      return;
    case 7: // afro: one round volume around the face
      R(4, -1, 8, 1, h);
      R(2, 0, 12, 1, h);
      R(1, 1, 14, 1, h);
      R(0, 2, 16, 3, h);
      R(0, 5, 2, 5, h);
      R(14, 5, 2, 5, h);
      R(4, 0, 4, 1, hl);
      R(2, 1, 3, 1, hl);
      R(1, 10, 1, 1, hd);
      R(14, 10, 1, 1, hd);
      R(2, 5, 12, 1, hd);
      return;
    case 8: // bob: blunt bangs, chin-length sides
      hairTop(R, k);
      R(3, 5, 10, 1, h);
      R(1, 4, 2, 8, h);
      R(13, 4, 2, 8, h);
      R(1, 11, 2, 1, hd);
      R(13, 11, 2, 1, hd);
      return;
    case 6: // ponytail: pulled back, no side locks
      hairTop(R, k);
      R(5, 5, 2, 1, h);
      R(9, 5, 2, 1, h);
      R(2, 5, 1, 1, hd);
      R(13, 5, 1, 1, hd);
      return;
  }
  hairTop(R, k);
  R(2, 5, 3, 2, h); // side locks
  R(11, 5, 3, 2, h);
  R(5, 5, 2, 1, h); // parted fringe
  R(9, 5, 2, 1, h);
  R(2, 6, 1, 1, hd);
  R(13, 6, 1, 1, hd);
  if (k.hairStyle === 1) {
    R(1, 5, 2, 9, h);
    R(13, 5, 2, 9, h);
    R(1, 12, 2, 2, hd);
    R(13, 12, 2, 2, hd);
  } else if (k.hairStyle === 3) {
    R(3, 0, 2, 1, h);
    R(7, -1, 2, 2, h);
    R(11, 0, 2, 1, h);
    R(7, -1, 1, 1, hl);
  } else if (k.hairStyle === 4) {
    R(5, -1, 6, 3, h);
    R(6, -1, 3, 1, hl);
    R(5, 1, 6, 1, hd);
  } else if (k.hairStyle === 11) {
    R(0, 5, 2, 1, TIE);
    R(14, 5, 2, 1, TIE);
    R(0, 6, 2, 8, h);
    R(14, 6, 2, 8, h);
    R(0, 13, 2, 1, hd);
    R(14, 13, 2, 1, hd);
  }
}

function hairBack(R: P, k: Look) {
  const h = k.hair, hd = dark(h, 0.3), hl = light(h, 0.32);
  switch (k.hairStyle) {
    case 2:
      R(5, 3, 3, 1, light(k.skin, 0.32));
      return;
    case 9: // a horseshoe of hair low on the back of the head
      R(5, 3, 3, 1, light(k.skin, 0.32));
      R(4, 6, 8, 1, h);
      R(2, 7, 12, 4, h);
      R(3, 11, 10, 1, hd);
      R(5, 7, 6, 1, hl);
      return;
    case 10:
      R(3, 3, 10, 1, shaved(k));
      R(2, 4, 12, 7, shaved(k));
      R(6, -1, 4, 12, h);
      R(7, -1, 1, 10, hl);
      return;
    case 7:
      R(4, -1, 8, 1, h);
      R(2, 0, 12, 1, h);
      R(1, 1, 14, 1, h);
      R(0, 2, 16, 9, h);
      R(1, 11, 14, 1, hd);
      R(4, 0, 4, 1, hl);
      R(2, 1, 3, 1, hl);
      return;
  }
  R(4, 1, 8, 1, h);
  R(3, 2, 10, 1, h);
  R(2, 3, 12, 9, h);
  R(3, 12, 10, 1, hd);
  R(2, 11, 12, 1, hd);
  R(5, 1, 4, 1, hl);
  R(4, 2, 3, 1, hl);
  R(6, 5, 4, 1, hl);
  if (k.hairStyle === 1) R(1, 5, 14, 9, h), R(2, 13, 12, 1, hd);
  if (k.hairStyle === 3) R(3, 0, 2, 1, h), R(7, -1, 2, 2, h), R(11, 0, 2, 1, h);
  if (k.hairStyle === 4) R(5, -1, 6, 3, h), R(6, -1, 3, 1, hl);
  if (k.hairStyle === 6) R(7, 9, 2, 1, TIE), R(7, 10, 2, 5, h), R(7, 14, 2, 1, hd);
  if (k.hairStyle === 8) R(1, 5, 14, 6, h), R(1, 11, 14, 1, hd);
  if (k.hairStyle === 11) R(0, 5, 2, 1, TIE), R(14, 5, 2, 1, TIE), R(0, 6, 2, 8, h), R(14, 6, 2, 8, h), R(0, 13, 2, 1, hd), R(14, 13, 2, 1, hd);
}

// facing left; the right-facing frames are the mirror image
function hairSide(R: P, k: Look) {
  const h = k.hair, hl = light(h, 0.32), hd = dark(h, 0.3), sk = k.skin;
  switch (k.hairStyle) {
    case 2:
      R(5, 3, 3, 1, light(sk, 0.32));
      return;
    case 9: // hair behind the ear and a short sideburn; the ear stays bare
      R(5, 3, 3, 1, light(sk, 0.32));
      R(8, 6, 1, 3, h);
      R(11, 5, 3, 6, h);
      R(12, 4, 2, 1, h);
      R(11, 10, 3, 1, hd);
      return;
    case 10:
      R(4, 3, 9, 2, shaved(k));
      R(12, 5, 1, 5, shaved(k));
      R(4, 0, 9, 2, h);
      R(5, -1, 2, 1, h);
      R(9, -1, 2, 1, h);
      R(12, 2, 2, 7, h);
      R(4, 0, 8, 1, hl);
      return;
    case 7:
      R(4, -1, 9, 1, h);
      R(2, 0, 12, 1, h);
      R(1, 1, 14, 1, h);
      R(1, 2, 15, 3, h);
      R(6, 5, 10, 6, h);
      R(1, 5, 2, 1, h);
      R(7, 11, 8, 1, hd);
      R(4, 0, 4, 1, hl);
      R(2, 1, 3, 1, hl);
      return;
  }
  hairTop(R, k);
  if (k.hairStyle === 8) {
    R(2, 5, 4, 1, h);
    R(7, 5, 7, 7, h);
    R(7, 11, 7, 1, hd);
    return;
  }
  R(8, 5, 6, 6, h); // hair falls behind the ear
  R(2, 5, 3, 1, h);
  R(12, 10, 2, 1, hd);
  if (k.hairStyle === 1) R(8, 11, 6, 4, h), R(8, 14, 6, 1, hd);
  if (k.hairStyle === 3) R(3, 0, 2, 1, h), R(7, -1, 2, 2, h), R(11, 0, 2, 1, h);
  if (k.hairStyle === 4) R(10, -1, 4, 4, h), R(10, -1, 2, 1, hl), R(10, 2, 4, 1, hd);
  if (k.hairStyle === 6) R(14, 6, 1, 1, TIE), R(14, 7, 2, 6, h), R(14, 12, 2, 1, hd);
  if (k.hairStyle === 11) R(13, 6, 2, 1, TIE), R(13, 7, 2, 7, h), R(13, 13, 2, 1, hd);
}

// stubble: the full beard's shape, see-through: a bit under half the hair colour over the skin under it
// (rows 11 and 12 are the jaw's shaded skin, so each row mixes with its own tone)
function stubble(R: P, k: Look, rects: [number, number, number, number][]) {
  const under = (y: number) => (y >= 12 ? dark(k.skin, 0.24) : y === 11 ? dark(k.skin, 0.1) : k.skin);
  for (const [x, y, w, h] of rects) for (let j = y; j < y + h; j++) R(x, j, w, 1, mix(under(j), k.hair, 0.45));
}

function beardFront(R: P, k: Look) {
  const c = k.hair, cd = dark(c, 0.3), cl = light(c, 0.2);
  switch (k.beard) {
    case 1:
      stubble(R, k, [[2, 9, 1, 2], [13, 9, 1, 2], [5, 10, 6, 1], [2, 11, 12, 1], [3, 12, 10, 1]]);
      return;
    case 2: // moustache: under the nose, ends drooping
      R(5, 11, 6, 1, c);
      R(5, 12, 1, 1, cd);
      R(10, 12, 1, 1, cd);
      return;
    case 3: // goatee: a thin line over the lip and a tuft on the chin
      R(6, 11, 4, 1, c);
      R(7, 12, 2, 1, c);
      R(7, 13, 2, 1, cd);
      return;
    case 4:
    case 5: {
      // a rounded mass: darker edges following its curve, a highlight on each cheek, symmetric
      const long = k.beard === 5;
      R(2, 9, 1, 2, cd); // sideburns
      R(13, 9, 1, 2, cd);
      R(5, 10, 6, 1, c); // moustache
      R(5, 10, 1, 1, cd);
      R(10, 10, 1, 1, cd);
      R(2, 11, 12, 1, c);
      R(2, 11, 1, 1, cd);
      R(13, 11, 1, 1, cd);
      R(3, 12, 10, 1, c);
      R(3, 12, 1, 1, cd);
      R(12, 12, 1, 1, cd);
      R(4, 11, 2, 1, cl); // cheeks
      R(10, 11, 2, 1, cl);
      if (!long) {
        R(4, 13, 8, 1, cd);
        return;
      }
      R(4, 13, 8, 1, c);
      R(4, 13, 1, 1, cd);
      R(11, 13, 1, 1, cd);
      R(5, 13, 1, 1, cl);
      R(10, 13, 1, 1, cl);
      R(5, 14, 6, 1, c);
      R(5, 14, 1, 1, cd);
      R(10, 14, 1, 1, cd);
      R(6, 15, 4, 1, cd);
      return;
    }
  }
}

function beardSide(R: P, k: Look) {
  const c = k.hair, cd = dark(c, 0.3), cl = light(c, 0.2);
  switch (k.beard) {
    case 1:
      stubble(R, k, [[8, 8, 1, 3], [2, 10, 3, 1], [2, 11, 8, 1], [3, 12, 7, 1]]);
      return;
    case 2:
      R(2, 11, 3, 1, c);
      R(2, 12, 1, 1, cd);
      return;
    case 3:
      R(2, 11, 2, 1, c);
      R(2, 12, 2, 1, c);
      R(3, 13, 1, 1, cd);
      return;
    case 4:
    case 5: {
      // in profile: lit at the front of the chin, darker toward the neck
      const long = k.beard === 5;
      R(8, 8, 1, 3, cd);
      R(2, 10, 3, 1, c);
      R(2, 11, 8, 1, c);
      R(3, 12, 7, 1, c);
      R(8, 11, 2, 2, cd);
      R(3, 12, 3, 1, cl);
      if (!long) {
        R(4, 13, 5, 1, cd);
        return;
      }
      R(3, 13, 6, 2, c);
      R(7, 13, 2, 2, cd);
      R(4, 13, 2, 1, cl);
      R(4, 15, 4, 1, cd);
      return;
    }
  }
}

// First hair row left visible under each hat (by HAT_IDS index): narrow crowns hide the hair beside them,
// headphones (3) hide nothing, the hijab (9) hides all of it.
const HAT_HAIR_TOP = [0, 1, 1, 0, 5, 4, 1, 2, 2, 99];

// Hats are drawn last. Views: 0 front, 3 back, 1 side (facing left).
function hat(R: P, k: Look, view: 0 | 1 | 3) {
  const c = k.hatColor, cl = light(c, 0.32), cd = dark(c, 0.3), cdd = dark(c, 0.45);
  const side = view === 1;
  switch (k.hat) {
    case 1: // cap; the exact pixels of the old "cap" hairstyle
      R(4, 1, 8, 1, c);
      R(3, 2, 10, 1, c);
      R(5, 1, 4, 1, cl);
      R(4, 2, 3, 1, cl);
      if (view === 0) {
        R(2, 3, 12, 3, c);
        R(2, 6, 12, 1, cd);
        R(3, 7, 10, 1, cdd);
        R(7, 3, 2, 2, BADGE);
      } else if (view === 3) {
        R(2, 3, 12, 6, c);
        R(3, 9, 10, 1, cd);
        R(6, 7, 4, 1, cd); // strap
      } else {
        R(2, 3, 12, 3, c);
        R(0, 6, 8, 1, cd); // brim points the way we face
        R(0, 7, 6, 1, cdd);
        R(9, 6, 5, 3, c);
      }
      return;
    case 2: {
      // knitted beanie with a folded, ribbed band and a pompom
      R(4, 0, 8, 1, c);
      R(3, 1, 10, 1, c);
      R(2, 2, 12, view === 3 ? 4 : 3, c);
      R(5, 0, 3, 1, cl);
      R(4, 1, 2, 1, cl);
      R(side ? 8 : 7, -1, 2, 1, cl);
      const y = view === 3 ? 6 : 5;
      R(2, y, 12, 2, cd);
      for (let x = 3; x < 14; x += 2) R(x, y, 1, 2, dark(c, 0.15));
      return;
    }
    case 3: // headphones
      if (side) {
        R(8, 0, 3, 1, c);
        R(9, 1, 2, 5, c);
        R(8, 6, 4, 4, cd);
        R(8, 6, 4, 1, cl);
        R(9, 7, 2, 2, c);
      } else {
        R(4, 0, 8, 1, c);
        R(5, 0, 3, 1, cl);
        R(3, 1, 1, 1, c);
        R(12, 1, 1, 1, c);
        R(2, 2, 1, 4, c);
        R(13, 2, 1, 4, c);
        R(1, 6, 2, 4, cd);
        R(13, 6, 2, 4, cd);
        R(1, 6, 2, 1, cl);
        R(13, 6, 2, 1, cl);
      }
      return;
    case 4: // bowler: round crown, short brim all around
      if (side) {
        R(4, -1, 6, 1, c);
        R(3, 0, 8, 1, c);
        R(3, 1, 9, 3, c);
        R(3, 4, 9, 1, cd);
        R(1, 5, 13, 1, c);
        R(4, 0, 3, 1, cl);
      } else {
        R(5, -1, 6, 1, c);
        R(4, 0, 8, 1, c);
        R(3, 1, 10, 3, c);
        R(3, 4, 10, 1, cd);
        R(1, 5, 14, 1, c);
        R(5, 0, 3, 1, cl);
        R(4, 1, 2, 1, cl);
      }
      R(view === 3 ? 3 : 2, 6, side ? 11 : 12, 1, cdd);
      return;
    case 5: // top hat: worn low, the brim on the forehead; a tall, wide crown with a ribbon
      if (side) {
        R(4, -5, 9, 10, c);
        R(4, 3, 9, 1, TIE);
        R(5, -5, 1, 8, cl);
        R(12, -5, 1, 8, cd);
        R(4, -5, 9, 1, cl);
        R(1, 4, 14, 1, c);
        R(2, 5, 12, 1, cdd);
      } else {
        R(3, -5, 10, 9, c);
        R(3, 3, 10, 1, TIE);
        R(4, -5, 1, 8, cl);
        R(12, -5, 1, 8, cd);
        R(3, -5, 10, 1, cl);
        R(0, 4, 16, 1, c);
        R(2, 5, 12, 1, cdd);
      }
      return;
    case 6: // beret: a flat disc that leans to one side
      if (side) {
        R(3, 1, 9, 1, c);
        R(2, 2, 12, 2, c);
        R(12, 4, 2, 1, c);
        R(3, 4, 9, 1, cd);
      } else {
        R(4, 1, 9, 1, c);
        R(2, 2, 13, 2, c);
        R(14, 4, 1, 1, c);
        R(3, 4, 10, 1, cd);
      }
      R(7, 0, 1, 1, cd);
      R(4, 2, 4, 1, cl);
      return;
    case 7: // tricorne: worn low, the brim on the forehead; a crown with a badge, corners turned up, gold trim
      R(5, -2, 6, 1, c);
      R(4, -1, 8, 3, c);
      R(5, -2, 3, 1, cl);
      R(4, -1, 1, 2, cl);
      if (side) {
        R(0, 0, 3, 2, c); // the front corner points the way we face
        R(12, -1, 3, 2, c);
        R(0, 0, 1, 1, GOLD);
        R(14, -1, 1, 1, GOLD);
        R(1, 2, 13, 2, c);
        R(1, 2, 13, 1, GOLD);
        R(2, 4, 11, 1, cdd);
      } else {
        R(0, -1, 2, 1, c); // corners turned up on both sides
        R(0, 0, 4, 2, c);
        R(14, -1, 2, 1, c);
        R(12, 0, 4, 2, c);
        R(0, -1, 2, 1, GOLD);
        R(14, -1, 2, 1, GOLD);
        R(1, 2, 14, 2, c);
        R(1, 2, 14, 1, GOLD);
        R(2, 4, 12, 1, cdd);
        if (view === 0) R(7, 0, 2, 2, BADGE);
      }
      return;
    case 8: // party hat: a cone sitting on the crown (the same from every side), lit from the left
      R(7, -6, 2, 1, BADGE); // pompom
      R(6, -5, 4, 1, BADGE);
      R(9, -5, 1, 1, dark(BADGE, 0.15));
      R(7, -4, 2, 2, c);
      R(6, -2, 4, 2, c);
      R(5, 0, 6, 2, c);
      R(4, 2, 8, 1, c); // rim on the head's top row
      R(5, 3, 6, 1, cd); // the rim's near half, lower than its ends
      R(7, -4, 1, 2, cl); // light edge
      R(6, -2, 1, 2, cl);
      R(5, 0, 1, 2, cl);
      R(8, -4, 1, 2, cd); // shaded edge
      R(9, -2, 1, 2, cd);
      R(10, 0, 1, 2, cd);
      R(7, -2, 1, 1, GOLD); // dots
      R(8, 0, 1, 1, GOLD);
      R(6, 1, 1, 1, GOLD);
      R(9, 2, 1, 1, GOLD);
      return;
    case 9: {
      // hijab: snug over the skull with a dark underscarf at the forehead, framing the face, wrapped
      // under the chin and close around the neck, then falling over the shoulders and chest
      const band = deep(c, 0.7);
      R(4, 1, 8, 1, c);
      R(3, 2, 10, 1, c);
      R(2, 3, 12, 2, c);
      R(5, 1, 3, 1, cl);
      R(4, 2, 2, 1, cl);
      if (view === 0) {
        R(4, 4, 8, 1, band);
        R(2, 5, 1, 8, c); // framing the cheeks, down to the jaw
        R(13, 5, 1, 8, cd);
        R(3, 11, 1, 1, c);
        R(12, 11, 1, 1, cd);
        R(3, 12, 10, 1, c); // wrapped under the chin
        R(3, 13, 10, 1, c); // over the shoulders
        R(3, 14, 6, 1, c); // one side falls longer across the chest
        R(4, 15, 4, 1, cd);
        R(9, 13, 3, 1, cd); // fold
        R(8, 14, 1, 1, cd);
      } else if (view === 3) {
        R(2, 5, 12, 7, c);
        R(5, 0, 5, 1, c); // gathered at the back of the head
        R(3, 12, 10, 1, cd);
        R(3, 13, 10, 1, c);
        R(5, 13, 1, 1, cd);
        R(10, 13, 1, 1, cd);
      } else {
        R(11, 1, 3, 1, c); // gathered at the back of the head
        R(12, 2, 3, 3, c);
        R(13, 2, 1, 1, cl);
        R(2, 4, 2, 1, band);
        // everything behind the face, edge sloping from the cheek down under the chin
        R(7, 5, 7, 8, c);
        R(6, 10, 1, 3, c);
        R(5, 11, 1, 2, c);
        R(4, 12, 1, 1, c);
        R(7, 5, 1, 5, cd);
        R(6, 10, 1, 1, cd);
        R(5, 11, 1, 1, cd);
        R(13, 5, 1, 7, cd);
        R(4, 13, 8, 1, c); // around the neck, then down the chest
        R(4, 14, 5, 1, c);
        R(5, 15, 3, 1, cd);
        R(9, 13, 1, 1, cd);
      }
      return;
    }
  }
}

function torso(R: P, k: Look, x: number, w: number, collar: boolean) {
  const s = k.shirt;
  R(x, 13, w, 5, s);
  R(x, 13, w, 1, light(s, 0.3));
  R(x, 14, 1, 3, light(s, 0.15));
  R(x, 17, w, 1, dark(s, 0.32));
  R(x + w - 1, 14, 1, 3, dark(s, 0.2));
  if (collar) R(x + w / 2 - 1, 13, 2, 1, k.skin);
}

function arm(R: P, k: Look, x: number, dy = 0) {
  R(x, 14 + dy, 2, 2, dark(k.shirt, 0.14));
  R(x, 14 + dy, 2, 1, k.shirt);
  R(x, 16 + dy, 2, 1, k.skin);
}

function legsFront(R: P, k: Look, frame: number) {
  const p = k.pants;
  const lUp = frame === 1, rUp = frame === 2;
  R(5, 18, 3, lUp ? 1 : 2, p);
  R(8, 18, 3, rUp ? 1 : 2, dark(p, 0.14));
  shoe(R, 4, lUp ? 19 : 20, 4);
  shoe(R, 8, rUp ? 19 : 20, 4);
  R(5, 18, 1, 1, light(p, 0.15));
}

export function drawChar(ctx: Ctx, ox: number, oy: number, dir: number, frame: number, k: Look) {
  const R: P = (x, y, w, h, c) => px(ctx, ox + 1 + x, oy + ORIGIN_Y + y, w, h, c);
  // under a hat, hair never pokes out above its brim (spikes, buns, crests, the top of an afro)
  const top = HAT_HAIR_TOP[k.hat] ?? 0;
  const H: P = top
    ? (x, y, w, h, c) => {
        if (y < top) (h -= top - y), (y = top);
        if (h > 0) R(x, y, w, h, c);
      }
    : R;
  R(3, 22, 10, 1, "rgba(40,24,90,0.30)");
  R(4, 23, 8, 1, "rgba(40,24,90,0.18)");

  if (dir === 0) {
    legsFront(R, k, frame);
    torso(R, k, 4, 8, true);
    arm(R, k, 2, frame === 2 ? 1 : 0);
    arm(R, k, 12, frame === 1 ? 1 : 0);
    if (k.hairStyle === 1) H(1, 5, 2, 9, k.hair), H(13, 5, 2, 9, k.hair);
    headFront(R, k);
    faceFront(R, k);
    beardFront(R, k);
    hairFront(H, k);
    hat(R, k, 0);
  } else if (dir === 3) {
    legsFront(R, k, frame);
    torso(R, k, 4, 8, false);
    arm(R, k, 2, frame === 1 ? 1 : 0);
    arm(R, k, 12, frame === 2 ? 1 : 0);
    headFront(R, k);
    hairBack(H, k);
    hat(R, k, 3);
  } else {
    // dir 1 = facing left; dir 2 is the mirror image, produced by the caller
    const p = k.pants;
    if (frame === 0) {
      R(6, 18, 4, 2, p);
      shoe(R, 5, 20, 5);
    } else if (frame === 1) {
      R(8, 18, 3, 2, dark(p, 0.15));
      shoe(R, 8, 20, 4);
      R(4, 18, 3, 1, p);
      shoe(R, 3, 19, 4);
    } else {
      R(4, 18, 3, 2, dark(p, 0.15));
      shoe(R, 3, 20, 4);
      R(8, 18, 3, 1, p);
      shoe(R, 8, 19, 4);
    }
    torso(R, k, 5, 6, false);
    const swing = frame === 1 ? -1 : frame === 2 ? 1 : 0;
    R(6 + swing, 14, 3, 2, dark(k.shirt, 0.16));
    R(6 + swing, 14, 3, 1, k.shirt);
    R(6 + swing, 16, 3, 1, k.skin);
    const sk = k.skin;
    R(4, 2, 8, 1, sk);
    R(3, 3, 10, 1, sk);
    R(2, 4, 12, 8, sk);
    R(2, 11, 12, 1, dark(sk, 0.1));
    R(3, 12, 10, 1, dark(sk, 0.24));
    R(2, 4, 3, 1, light(sk, 0.18));
    R(4, 8, 1, 2, EYE);
    R(3, 10, 2, 1, mix(sk, "#ff7c86", 0.38));
    R(9, 7, 2, 3, dark(sk, 0.2)); // ear
    beardSide(R, k);
    hairSide(H, k);
    hat(R, k, 1);
  }
}

/**
 * Adds a 1px outline around opaque pixels, per cell so nothing bleeds between rows.
 * The outline takes a very dark version of the neighbouring colour instead of flat black,
 * which keeps hair, skin and clothes reading as separate shapes.
 */
export function outlineCell(ctx: Ctx, cx: number, cy: number) {
  const img = ctx.getImageData(cx, cy, CELL_W, CELL_H);
  const d = img.data;
  const src = new Uint8ClampedArray(d);
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < CELL_W && y < CELL_H && src[(y * CELL_W + x) * 4 + 3] >= 200 ? (y * CELL_W + x) * 4 : -1);
  const [dr, dg, db] = rgb("#120e1c");
  for (let y = 0; y < CELL_H; y++)
    for (let x = 0; x < CELL_W; x++) {
      const i = (y * CELL_W + x) * 4;
      if (src[i + 3] >= 200) continue;
      const n = [at(x, y + 1), at(x - 1, y), at(x + 1, y), at(x, y - 1)].find((v) => v >= 0);
      if (n === undefined) continue;
      const t = 0.7;
      d[i] = src[n] + (dr - src[n]) * t;
      d[i + 1] = src[n + 1] + (dg - src[n + 1]) * t;
      d[i + 2] = src[n + 2] + (db - src[n + 2]) * t;
      d[i + 3] = 255;
    }
  ctx.putImageData(img, cx, cy);
}

/** Draws the whole 3x4 sheet (rows: down, left, right, up; columns: idle, step A, step B). */
export function drawSheet(ctx: Ctx, look: Look) {
  const k = normaliseLook(look);
  const tmp = document.createElement("canvas");
  tmp.width = CELL_W;
  tmp.height = CELL_H;
  const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
  for (let f = 0; f < 3; f++) {
    for (const dir of [0, 1, 3]) drawChar(ctx, f * CELL_W, dir * CELL_H, dir, f, k);
    // right-facing = mirrored left-facing
    tctx.clearRect(0, 0, CELL_W, CELL_H);
    drawChar(tctx, 0, 0, 1, f, k);
    ctx.save();
    ctx.translate(f * CELL_W + CELL_W, 2 * CELL_H);
    ctx.scale(-1, 1);
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
  }
  for (let r = 0; r < 4; r++) for (let f = 0; f < 3; f++) outlineCell(ctx, f * CELL_W, r * CELL_H);
}
