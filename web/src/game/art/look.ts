// What an avatar wears, by wire index (see docs/protocol.md). No imports: unit tests load it directly.
/** Hair styles by wire index. 5 is the retired "cap" style: drawn as bald + cap (see normaliseLook). */
export const HAIR_STYLE_IDS = ["short", "long", "bald", "spiky", "bun", "", "ponytail", "afro", "bob", "balding", "mohawk", "pigtails"] as const;
export const LEGACY_CAP_STYLE = 5;
export const BEARD_IDS = ["none", "stubble", "moustache", "goatee", "full", "long"] as const;
export const HAT_IDS = ["none", "cap", "beanie", "headphones", "bowler", "tophat", "beret", "tricorne", "clown", "hijab"] as const;

export interface Look {
  skin: string;
  hair: string;
  hairStyle: number; // index into HAIR_STYLE_IDS
  shirt: string;
  pants: string;
  beard: number; // index into BEARD_IDS, drawn in the hair colour
  hat: number; // index into HAT_IDS
  hatColor: string;
}

/** Avatars saved with the old "cap" hairstyle keep their exact pixels: bald + a cap in the hair colour. */
export function normaliseLook(k: Look): Look {
  if (k.hairStyle !== LEGACY_CAP_STYLE) return k;
  return k.hat ? { ...k, hairStyle: 2 } : { ...k, hairStyle: 2, hat: 1, hatColor: k.hair };
}
