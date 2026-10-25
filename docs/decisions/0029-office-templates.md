# 0029: Office templates an administrator can switch to, of any size

Date: 2026-10-25. Status: accepted.

## Context

Every office started from one starter map (60x46: reception, twelve desks, four meeting rooms, six private offices) and could only be changed tile by tile in the map editor. A team that wants an open space of islands, many small meeting rooms and a break room had to draw it themselves. The world also refused any map of another size until a restart: its spatial grid was sized once.

## Decision

- **Templates are Go code.** `gamemap.Templates` lists `loft` (the existing starter map, unchanged), `lodge` (77x51) and `manor` (85x51), named after kinds of homes from the smallest. Lodge and Manor come from one generator (`wideOffice`): an arena with stands over a walled-up extension, 2-tile corridors on both sides, a welcome area (the spawn) and a break room over an open space of islands, three meeting rooms on the right, mini meeting rooms along a bottom hall. Every wall is one tile and every door two. Manor has 48 desks in 8 islands, 7 mini rooms and 12 conversation corners; Lodge 36 desks, 5 wider mini rooms and 8 corners. Tests check sizes, counts, centring, that every area and every desk's seat can be walked to from the spawn and that the extension cannot.
- **Islands of back-to-back desks.** An island is 3x2 zones of 3x3, each with a 3x1 desk and a chair. A desk now has `up`: its seat is above it, so its desk room ([decision 0019](0019-room-calls-from-two-and-desk-rooms.md)) is the desk and the two rows above. Each zone is exactly one desk room. The client draws such a desk with the screen's back towards the viewer.
- **Conversation corners are rooms without walls.** A duo corner (3x3: armchair, small table, armchair, room for people watching a game) and a couch corner (4x4: four couches around a 2x2 table) are open rooms whose id starts with `corner-`: walking in joins their call, as in any room. The id prefix only lets the template list count them apart from meeting rooms.
- **Couches are seats**: they no longer block movement, in every map, so people sit on them as on chairs (a couch corner is walked into from any side).
- **New furniture**, drawn in code: `armchair`, `bleachers` (stands; not solid, people may sit in them), `court` (the arena's field, drawn under the furniture), `stairs`, and wall decoration (`banner`, `scoreboard`), a couch turned upright or upside down next to a table, desks and tables of any size.
- **The area limit goes from 64 to 128** per map: Manor has 29 drawn areas plus up to 48 desk rooms.
- **Switching is one admin action.** Admin > Office lists the templates with a summary computed from the map (desks, rooms, corners, private offices), the one whose walls the office has marked in use. `POST /api/admin/map/template {template}` replaces the whole map, after a confirmation that says so: rooms, furniture, notes, websites, whiteboards and editor changes are gone. It is rate limited with map edits, saved, and audited as `map.template` (template id, map revision, desks kept and lost; no content).
- **Desk assignments carry over by number.** Desks are numbered in map order, leaving out desks inside a drawn room. The owner of the old map's k-th desk takes the new k-th desk; private-office owners and people whose number the new map does not have then take the free desks in order. When desks run out, the highest numbers lose theirs. Removed members get nothing.
- **A map of another size is swapped by reconnecting everybody.** `World.ReplaceMap` moves each online player to a free tile near the new spawn, disconnects them as an eviction does (close code 4003, the client reconnects at once), then rebuilds the spatial grid for the new size. Stored last positions are forgotten first, so nobody comes back at a place of the old map, and whiteboards are wiped (in memory and stored): they are keyed by tile, so a board of the new map at the same tile, perhaps in a room open to more people, would show the old strokes. A demo's scheduled reset now takes the same path when an administrator chose a layout of another size. Room calls, locks and knocks end. Same-size edits keep using `ReloadMap`, which keeps calls that did not change.
- `web/dev/<template>-map.json` and `site/assets/map-<template>.png` are generated from the templates; a Go test fails when a fixture is stale.

## Alternatives

- **Templates as JSON files** an operator could add: no tests on their geometry, and the counts and centring rules of the generator would be hand-kept. Code keeps one generator for Lodge and Manor. An admin can still edit any template afterwards with the map editor.
- **Resizing the grid in place** without disconnecting anybody: every player's cell, subscription range and the entities each client knows would have to be rebuilt consistently. Reconnecting reuses the join path, which already does all of it, for an action an admin takes rarely and confirms.
- **Remembering which template an office uses** in the database: a migration for a label that goes stale as soon as the editor changes the map. The list compares walls instead.

## Impact

- **Performance:** Manor is 85x51 tiles against 60x46 (57 % more tiles); the tick and proximity costs do not depend on map size (spatial grid, interest areas), the baked map texture grows accordingly (1360x816 px). Up to 128 areas per map: per-area work is a head count pass every few seconds and the room lookup per tile, both bounded. A template switch costs everybody one reconnection. No new measurement was made.
- **Maintenance:** one generator and its tests; the world has one more event path (`ReplaceMap`). The client handles maps of any size already.
- **Install:** none. No migration; offices keep their map until an administrator switches.
