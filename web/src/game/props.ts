import type { Prop } from "../net/protocol";

// Built-in map props: their default footprint (tiles) and whether they block movement (the server's
// gamemap rules). PixiJS- and i18n-free so the unit tests load it under Node; labels live in mapModel.
export const PROP_DEFS: { t: string; w: number; h: number; solid: boolean }[] = [
  { t: "desk", w: 2, h: 1, solid: true },
  { t: "chair", w: 1, h: 1, solid: false },
  { t: "table", w: 3, h: 2, solid: true },
  { t: "couch", w: 3, h: 1, solid: false },
  { t: "plant", w: 1, h: 1, solid: true },
  { t: "bookshelf", w: 2, h: 1, solid: true },
  { t: "coffee", w: 1, h: 1, solid: true },
  { t: "whiteboard", w: 3, h: 1, solid: false },
  { t: "rug", w: 4, h: 3, solid: false },
  { t: "lamp", w: 1, h: 1, solid: true },
  { t: "reception_desk", w: 6, h: 1, solid: true },
  { t: "armchair", w: 1, h: 1, solid: false },
  { t: "bleachers", w: 4, h: 2, solid: false },
  { t: "court", w: 6, h: 4, solid: false },
  { t: "stairs", w: 2, h: 2, solid: false },
  { t: "banner", w: 1, h: 1, solid: false },
  { t: "scoreboard", w: 4, h: 1, solid: false },
  { t: "note", w: 1, h: 1, solid: true },
  { t: "embed", w: 2, h: 1, solid: true },
  { t: "image", w: 1, h: 1, solid: true },
  { t: "portal", w: 1, h: 1, solid: false },
  { t: "spotlight", w: 1, h: 1, solid: false },
];
const byType = new Map(PROP_DEFS.map((p) => [p.t, p]));

/** Built-in kinds that X uses (the server answers with their content). */
export const USABLE_KINDS = ["note", "embed", "image", "whiteboard"];

/** A plugin object's type ("<plugin>/<kind>"): never solid, its size always in the map (w, h). */
export const isPluginProp = (t: string) => t.includes("/");

/** Footprint in tiles: the prop's own w/h (always set on plugin objects), else the kind's default. */
export function propSize(p: Prop): [number, number] {
  const d = byType.get(p.t);
  return [p.w ?? d?.w ?? 1, p.h ?? d?.h ?? 1];
}

/** Blocks movement (plugin objects never do). */
export const isSolidProp = (t: string) => byType.get(t)?.solid ?? false;
