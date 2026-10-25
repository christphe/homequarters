import type { MapData } from "../net/protocol";
import { t } from "../i18n";
import { PROP_DEFS, isSolidProp, propSize } from "./props";

export { propSize } from "./props";

const LABELS: Record<string, string> = {
  desk: "Desk",
  chair: "Chair",
  table: "Table",
  couch: "Couch",
  plant: "Plant",
  bookshelf: "Bookshelf",
  coffee: "Coffee machine",
  whiteboard: "Whiteboard",
  rug: "Rug",
  lamp: "Lamp",
  reception_desk: "Reception desk",
  armchair: t("prop.armchair"),
  bleachers: t("prop.bleachers"),
  court: t("prop.court"),
  stairs: t("prop.stairs"),
  banner: t("prop.banner"),
  scoreboard: t("prop.scoreboard"),
  note: t("prop.note"),
  embed: t("prop.embed"),
  image: t("prop.image"),
  portal: t("prop.portal"),
  spotlight: t("prop.spotlight"),
};

// a pc is not offered until a desk can be bare: a desk without one draws its own screen
export const PROP_TYPES: { t: string; w: number; h: number; solid: boolean; label: string }[] = PROP_DEFS.filter((p) => p.t !== "pc").map((p) => ({ ...p, label: LABELS[p.t] ?? p.t }));

/** Same rule as the server (gamemap.Compile): walls plus the footprint of solid props. */
export function computeSolid(map: MapData): string[] {
  const rows = map.walls.map((r) => Array.from(r, (c) => (c === "#" ? "1" : "0")));
  for (const p of map.props) {
    if (!isSolidProp(p.t)) continue;
    const [w, h] = propSize(p);
    for (let y = p.y; y < p.y + h; y++) for (let x = p.x; x < p.x + w; x++) if (rows[y]?.[x] !== undefined) rows[y][x] = "1";
  }
  return rows.map((r) => r.join(""));
}

export function cloneMap(m: MapData): MapData {
  return JSON.parse(JSON.stringify(m)) as MapData;
}

/** Payload accepted by PUT /api/map: the editable fields only (the server recomputes the rest). */
export function toWire(m: MapData) {
  return { version: m.version, w: m.w, h: m.h, walls: m.walls, props: m.props, areas: m.areas, spawn: m.spawn };
}
