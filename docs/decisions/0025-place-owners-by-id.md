# 0025: Desks and offices store their owners' ids; names are joined when shown

Date: 2026-10-19. Status: accepted.

## Context

A desk or a private office belongs to members: the map stores their user ids (`Prop.Assign`, `Access.Users` of an office), and the server decides everything from those ids. But the map also stored their names: assigning a desk wrote "<name>'s desk" into its label, and assigning an office appended " · <name>" to the office name. Those copies went stale:

- a member who renamed themselves kept their old name on their desk and office;
- a member removed by an administrator kept their desk and office: the id stayed in the map, so the desk could not be taken, nobody could free it but an administrator in the editor, and it kept showing the removed person's name.

## Decision

- **The map stores ids only.** A desk keeps its own label ("Desk 3"), shown again once it is free, and an owned office keeps its own name ("Office 2"); an assigned desk is shown under its owner's name instead of its label. The names older versions wrote are dropped once, when an office's map is loaded (`gamemap.Unname`: an assigned desk's "<name>'s desk" label and the " · <name>" suffix of owned offices only, so a room an administrator names "Lab · 3D printers" keeps its name).
- **Names are joined when shown.** The server sends `owners` (user id to name, for every member a place belongs to) with `hello` and with every `map` frame, and an `own` frame when one of them renames themselves (`PUT /api/profile` tells every running office). The client builds "<name>'s desk" and "Office 2 · <name>" from them (`web/src/game/places.ts`); the server builds the same titles for the messages that name a place (conversation join, locate, knocks). Online people fill the gaps, so the editor's preview names a person it has just assigned.
- **Ownership follows membership.** `gamemap.Owners` lists the owners of a map and `store.MemberNames` joins them with the office's memberships: an id that is not a member gets no name. Removing a member frees their desk and office seat at once in the running world, which saves the map and writes `map.free` to the activity log. When the office's world starts, places kept by non-members (removed before this change) are freed, the cleaned map is saved and `map.clean` is logged. `PUT /api/map` checks owners under the map lock and drops a place given to somebody who is not a member: an editor draft opened before a removal saves without that place instead of failing, and cannot hand it back.

## Alternatives

- **Rewrite the stored names on every rename and removal.** Smaller, but every place a name is copied to needs its own update, and a missed one shows a stale name; a rename would also resend the whole map to everybody.
- **A table of places with a foreign key to memberships** (`ON DELETE CASCADE`). The cleanest join on paper, but desks and offices live in the map JSON, which the editor moves, deletes and recreates freely: keeping a table in step with it costs more than one function that frees a removed member's places.
- **Ignore non-members wherever ownership is checked** instead of freeing their places. Every check (desk rooms, claims, one place per person, "back to my desk", the editor) would need the membership list; one cleanup on removal keeps the map true.

## Impact

- Performance: `owners` holds at most one name per desk and office owner (a few hundred bytes on a large office) in `hello` and `map`; a rename is one small frame to the people online, not a map reload. Removing a member compiles the map once in the world goroutine, as a desk claim does.
- Maintenance: code that names a desk or an office must use `areaTitle`/`deskTitle` (client) or `World.areaTitle` (server), never the stored label or name.
- Installation: none. Existing maps are cleaned on first load ("map cleaned" in the log, `map.clean` in the activity log); a desk held by a member removed earlier becomes free.
- Limit: if freeing a removed member's places fails (the world does not answer within 10 seconds, or the save fails), the removal still succeeds and the error is logged; the places are freed the next time the office's world starts.
