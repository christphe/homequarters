# 0020: Members take and release a free desk themselves; unchanged rooms keep their call across map changes

Date: 2026-10-16. Status: accepted.

## Context

Only an administrator could assign a desk, from the map editor. In a small team that is a chore for the administrator, and a newcomer had no way to settle in: Ctrl+D just said "You have no desk or office yet".

Giving a desk changes the map, and a map change used to dissolve every room call in the office, because room groups are keyed by area index and indexes may move. A desk claimed by one person would have cut every meeting in progress.

## Decision

- **A button next to a free desk.** A member who has no desk and no private office sees "Take this desk" when they stand within 20 px of a free desk that is not inside a room (the same reach as pressing X on an object). It asks for confirmation, because only an administrator can give the desk to someone else afterwards.
- **The server decides.** `POST /api/desk {x, y}` asks the running world, which checks the member is connected, stands next to that desk, the desk is free and not inside a room, and the member has no desk or office (`gamemap.OnePlacePerPerson`'s rule). The desk is then named "<name>'s desk", and releasing it drops that name, as the map editor does. The world applies the new map at once (everybody receives it, and the desk room of [decision 0019](0019-room-calls-from-two-and-desk-rooms.md) appears); the server then saves it like an editor save, so the claim survives a restart, and writes `desk.claim` (the desk's tile, no content) to the activity log. Claims share the editor's rate limit. Map changes (editor saves, claims, demo resets) take one server lock so the saved map is always the last one applied.
- **Rooms keep their call across a map change when they did not change.** On a map reload, a room group whose area still exists with the same id, place and rules follows it to its new index; the others dissolve as before, and anybody whom a new room now covers leaves their old room's call. The SFU room name comes from the area id, so a kept call does not reconnect.
- **A button to give it back.** In their own desk room, next to "Lock desk", the owner gets "Release desk". After a confirmation, `POST /api/desk/release` frees the desk if it is theirs and they stand in its room; the world applies it (the desk room, its lock and its call go), the map is saved and `desk.release` is logged.
- Desks inside a room (the private offices' desks) are left to administrators: the room is the place, and an office is assigned as a whole.

## Alternatives

- A WebSocket message instead of an HTTP call: the world goroutine must not write to the database, so the save would need a new hook and queue. The HTTP handler already does exactly this for editor saves.

## Impact

- Performance: a claim compiles the map once inside the world goroutine (a 60x46 map, well under a millisecond; at most 200x200), rate limited per person. Keeping room calls avoids SFU reconnects for everybody on any map change.
- Maintenance: code that keys state by area index must remap it in `doReloadMap` (room groups do; locks and knocks are keyed by area id).
- Installation: none. An editor open during a claim still saves its own copy of the map, which drops the claim; the activity log shows both.
