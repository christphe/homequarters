// How desks and offices are named on screen. The map stores only who a place belongs to (user ids);
// names are joined here, from the server's owner names (hello, map, "own"), so a rename shows at once
// and no stale name is ever stored.
import { isOwnedOffice, type Area, type Prop } from "../net/protocol";
import { t } from "../i18n";

/** A member's current name, or undefined when it is not known (yet). */
export type NameOf = (id: number) => string | undefined;

/** An assigned desk is "<owner>'s desk"; a free one shows its own label, if any. */
export function deskTitle(p: Prop, nameOf: NameOf): string {
  const n = p.assign ? nameOf(p.assign) : undefined;
  return n ? t("place.deskOf", { name: n }) : p.label ?? "";
}

/** A desk room is named after its owner, an owned office lists its owners ("Office 2 · Ana"). */
export function areaTitle(a: Area, nameOf: NameOf): string {
  const names = (a.access.users ?? []).map(nameOf).filter((n): n is string => !!n);
  if (!names.length) return a.name;
  if (a.auto) return t("place.deskOf", { name: names[0] });
  if (isOwnedOffice(a)) return t("place.officeOf", { office: a.name, name: names.join(", ") });
  return a.name;
}

/** Owner names as the server sends them (keyed by the id as a string). */
export const ownerMap = (o: Record<string, string> | undefined) => new Map(Object.entries(o ?? {}).map(([id, n]) => [Number(id), n]));
