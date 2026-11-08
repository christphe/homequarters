import { isOwnedOffice, type Area, type MapData, type Prop } from "../net/protocol";

// Which door and desk buttons the page offers (ui/SocialControls.tsx): Lock and Release in the room I
// stand in, Knock and Enter anyway at a door the server keeps me out of. Pure so it is tested without a
// browser; the server decides what each button does (world/doors.go, world/desk.go).

/** px between my feet and a closed room's rectangle to get its Knock button. */
export const KNOCK_REACH = 40;

/** The buttons of the room I stand in: Lock (or Lock desk) and, for my own desk, Release desk. */
export function roomActions(map: MapData | null | undefined, here: number, me: number, role: string): { room: Area | null; lockable: boolean; myDesk: Prop | null } {
  const room = map && here >= 0 && map.areas[here]?.kind === "room" ? map.areas[here] : null;
  // an assigned office is always closed to strangers: there is nothing to lock or unlock; a desk is
  // locked by its owner (or an admin)
  const lockable = !!room && !isOwnedOffice(room) && (!room.auto || role === "admin" || !!room.access.users?.includes(me));
  // my own desk: its room is the desk and the rows in front of it, starting at the desk's tile
  const myDesk = room?.auto && room.access.users?.includes(me) ? map?.props.find((p) => p.t === "desk" && p.x === room.x && p.y === room.y) ?? null : null;
  return { room, lockable, myDesk };
}

/** The closed door I stand at, if any: Knock for everybody, Enter anyway (force) for an administrator.
 * Only a door the server keeps me out of (denied): not one I locked myself, was let in, or own. */
export function doorAt(map: MapData, denied: readonly number[], here: number, role: string, px: number, py: number): { index: number; area: Area; force: boolean } | null {
  const T = map.tile || 16;
  for (let index = 0; index < map.areas.length; index++) {
    const a = map.areas[index];
    if (!denied.includes(index) || index === here) continue;
    if (Math.hypot(Math.max(a.x * T - px, 0, px - (a.x + a.w) * T), Math.max(a.y * T - py, 0, py - (a.y + a.h) * T)) <= KNOCK_REACH) {
      return { index, area: a, force: role === "admin" };
    }
  }
  return null;
}
