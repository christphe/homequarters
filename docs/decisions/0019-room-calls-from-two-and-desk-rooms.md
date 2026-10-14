# 0019: Room calls start with two people; assigned desks are small rooms

Date: 2026-10-14. Status: accepted.

## Context

The individual desks stand 4 tiles apart, chair to chair: exactly the 64 px proximity join radius. Two neighbours sitting at their desks were pulled into a call. Tightening the radius for the whole office did not fit either: people at the edge of a desk's aisle still lined up within reach, and the social area wants the wider radius.

A room had a second problem: walking into one alone joined its call, so the browser reached the SFU and, with consent given, captured the microphone for an empty room.

## Decision

- **A room's call starts with two people.** A person alone in a room belongs to its group (capacity and the dwell timers work as before) but gets no `conv` join and no media token, and the SFU membership snapshot leaves the room out, so the reconciler removes anybody who reaches it anyway. The second person to enter starts the call for both. When a room drops back to one person, that person gets `conv` leave and SFU access is revoked: the capture stops, and they stay in the room. This applies to every room: meeting rooms, private offices and desk rooms.
- **An assigned desk is a room.** When the server compiles a map, each desk with an `assign` that is not already inside a room gets a derived area. It covers the desk and the two rows in front of it (the chair and the tile behind it), as wide as the desk, so the aisles stay open. It is `kind: "room"`, `access: open`, capacity 4, floor `desk_mat`, named after the desk's label, with `auto: true`. Desk rooms are never stored as such: compiling drops any stale one and derives them again, so assigning or unassigning a desk in the editor adds or removes its room, and maps saved before this change get desk rooms with no migration. Desk rooms name their owner in `access.users`: the owner (or an admin) may lock the desk, always walks in even when it is locked, and alone (with admins) answers knocks.
- **The client hides desk rooms as places.** A desk room is drawn with its own floor so the desk's space is visible. It gets no label or banner (the desk already shows "Desk of ..."). The area indicator and the minimap count it as the area around it, and the editor ignores it.

- **Administrators no longer walk through closed doors without noticing.** A locked room, an assigned office or a locked desk stops them like anybody else; they can knock, and they get a second button, "Enter anyway (admin)" (`force`), which admits them until the room is empty. The people inside are told (`frc`) and the activity log records `room.force` with the room id. Rooms open only to admins are not closed doors and behave as before.

## Alternatives

- Smaller proximity radii everywhere (join 34 px, leave 44 px): fixes neighbours, but changes every open area. Rejected in favour of rooms where people actually sit.
- Twelve fixed desk rooms in the starter office: also changes unassigned desks, and shows twelve area names. Rooms only for assigned desks need no labels and follow assignments.

## Impact

- Performance: fewer SFU participants (nobody is connected alone in a room) and no capture for empty rooms. A desk room is one more area in the grid (at most 64 areas per map, as before).
- Maintenance: code that sends a `conv` join or lists SFU members must use `group.live()`. Desk rooms live in `gamemap.withDeskRooms`.
- Installation: none. Existing maps get desk rooms for their assigned desks on the next start.
