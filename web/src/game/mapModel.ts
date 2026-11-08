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

/** The editor's "Assign desk or office" tool, clicked at tile (x, y) of the draft with a person picked
 * (uid), or Nobody (0). A desk there gets uid, or is freed by Nobody; elsewhere inside a private office,
 * the office gets uid, or nobody. One desk or office per person: whatever uid had before is freed.
 * Only the owner's id is stored; the office and the desk show their owner's current name (places.ts).
 * Returns whether the draft changed. */
export function assignPlace(d: MapData, x: number, y: number, uid: number): boolean {
  const p = d.props.find((q) => {
    if (q.t !== "desk") return false;
    const [w, h] = propSize(q);
    return x >= q.x && x < q.x + w && y >= q.y && y < q.y + h;
  });
  const office = p ? undefined : d.areas.find((a) => a.kind === "room" && a.access.mode === "office" && x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h);
  if (office) {
    if (uid) freePlaces(d, uid);
    office.access = { mode: "office", users: uid ? [uid] : [] };
    return true;
  }
  if (p && uid) {
    freePlaces(d, uid);
    p.assign = uid;
    return true;
  }
  if (p?.assign) { // Nobody frees the desk (and the server drops its room)
    delete p.assign;
    return true;
  }
  return false;
}

/** Frees whatever desk or private office a person had in the draft (the server allows one per person). */
function freePlaces(d: MapData, uid: number) {
  for (const p of d.props) {
    if (p.t === "desk" && p.assign === uid) delete p.assign;
  }
  for (const a of d.areas) {
    if (a.kind === "room" && a.access.mode === "office" && a.access.users?.includes(uid)) {
      a.access = { mode: "office", users: a.access.users.filter((u) => u !== uid) };
    }
  }
}
