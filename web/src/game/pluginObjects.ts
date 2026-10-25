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
