import type { PluginObjectSpec, Prop } from "../net/protocol";
import { USABLE_KINDS, propSize } from "./props.ts";

export type { PluginObjectSpec };

// Map objects that plugins declare (manifest "objects"), placed as props of type "<plugin>/<kind>".
// Only those of running plugins are drawn and usable; the rest stay in the map, untouched. Pure (no
// PixiJS) so the unit tests load it under Node.

const T = 16;

/** The props whose "<plugin>/<kind>" a running plugin declares, with that declaration. */
export function objectsFor(props: Prop[], specs: PluginObjectSpec[]): { prop: Prop; spec: PluginObjectSpec }[] {
  if (specs.length === 0) return [];
  const byType = new Map(specs.map((s) => [s.plugin + "/" + s.kind, s]));
  const out: { prop: Prop; spec: PluginObjectSpec }[] = [];
  for (const prop of props) {
    const spec = byType.get(prop.t);
    if (spec) out.push({ prop, spec });
  }
  return out;
}

/** The usable prop nearest to (x, y) in px, measured to its rectangle, within reach px; or null. */
export function nearestUsable(props: Prop[], specs: PluginObjectSpec[], x: number, y: number, reach: number): Prop | null {
  const usable = new Set(objectsFor(props, specs).map((o) => o.prop));
  let best: Prop | null = null;
  let bestD = reach;
  for (const p of props) {
    if (!USABLE_KINDS.includes(p.t) && !usable.has(p)) continue;
    const [w, h] = propSize(p);
    const d = Math.hypot(Math.max(p.x * T - x, 0, x - (p.x + w) * T), Math.max(p.y * T - y, 0, y - (p.y + h) * T));
    if (d <= bestD) { bestD = d; best = p; }
  }
  return best;
}

// ---- what a plugin's browser code is told about its placed objects (onObjectInit/Destroy/Update) ----

/** One placed object of a plugin, as its browser code sees it: tiles, plus the top-left in world px. */
export interface PlacedObject { kind: string; x: number; y: number; w: number; h: number; px: number; py: number }

/** At most this many dynamic objects of one plugin ride on its updates (the rest get init and destroy only). */
export const MAX_DYNAMIC = 64;

/** The placed objects of one plugin whose kind its manifest declares, in map order. */
export function placedObjects(props: Prop[], specs: PluginObjectSpec[], plugin: string): PlacedObject[] {
  const own = specs.filter((s) => s.plugin === plugin);
  return objectsFor(props, own).map(({ prop, spec }) => {
    const [w, h] = propSize(prop);
    return { kind: spec.kind, x: prop.x, y: prop.y, w, h, px: prop.x * T, py: prop.y * T };
  });
}

const objKey = (o: PlacedObject) => `${o.kind}@${o.x},${o.y}`;

/** What changed between two lists of placed objects. An object is "kind@x,y": a move is a destroy then
 *  an init, and so is a resize. */
export function objectChanges(prev: PlacedObject[], next: PlacedObject[]): { init: PlacedObject[]; destroy: PlacedObject[] } {
  const before = new Map(prev.map((o) => [objKey(o), o]));
  const after = new Map(next.map((o) => [objKey(o), o]));
  const same = (a: PlacedObject, b: PlacedObject | undefined) => !!b && a.w === b.w && a.h === b.h;
  return {
    destroy: prev.filter((o) => !same(o, after.get(objKey(o)))),
    init: next.filter((o) => !same(o, before.get(objKey(o)))),
  };
}

/** The placed objects of dynamic kinds that get onObjectUpdate: the first MAX_DYNAMIC in map order;
 *  over: how many more there are. */
export function dynamicObjects(placed: PlacedObject[], specs: PluginObjectSpec[]): { objects: PlacedObject[]; over: number } {
  const kinds = new Set(specs.filter((s) => s.dynamic).map((s) => s.kind));
  const all = placed.filter((o) => kinds.has(o.kind));
  return { objects: all.slice(0, MAX_DYNAMIC), over: Math.max(0, all.length - MAX_DYNAMIC) };
}
