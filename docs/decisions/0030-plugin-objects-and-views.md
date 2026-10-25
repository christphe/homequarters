# 0030: Plugin map objects and views

Date: 2026-10-25. Status: accepted.

## Context

A plugin could draw sprites, buttons, a box and a modal, but it could not put anything on the map for members to use, and the modal had only form-like elements. The bundled Chess plugin needs a chessboard on a table that a member opens with X, a board to drag pieces on, and a badge above the head of the people playing.

## Decision

- **Objects are declared in the manifest** (`objects`, at most 8: `kind`, `label`, `size`, optional `sprite` and `frame`, optional `dynamic`). An administrator places them with the map editor. A placed object is a prop of type `<plugin>/<kind>` with `w` and `h` required, no `Data`, no `To`, never solid. The map stays valid when the plugin is removed; pages draw the objects of running plugins only.
- **Live sprites, not baked props.** The built-in props are painted into the baked map texture. A plugin object is a sprite of the plugin layer (or whatever the plugin draws from `onObjectInit`), so it appears and disappears with the plugin without rebaking the map, and the plugin can animate it. Callbacks `hq.onObjectInit`, `onObjectDestroy` and `onObjectUpdate`; update runs only for `"dynamic": true` objects, at most 64 per plugin, in the existing update tick.
- **X calls `onUse`.** The server checks reach and area access as for built-in objects and throttles to 4 a second per member (burst 8), dropping the rest silently. Invisible members reach no plugin.
- **Views relay through the client iframe.** A view is a script declared in `views` (at most 4, compiled like `client`, 256 KB) that runs in a second sandboxed iframe (`sandbox="allow-scripts"`, the same strict CSP) inside the modal. It never talks to the server: it talks to the plugin's own iframe through the host with `hqView.send` and `hq.ui.post`, and the plugin's iframe uses the existing plugin channel. So a view has no more reach than the plugin's browser code, the server sees one authenticated channel, and no new route or socket exists. Messages are JSON, at most 4096 bytes and 30 a second each way per view; over the limit they are dropped with a console warning.
- **`hq.attach`** pins a plugin sprite above a member's head; `hq.ui.button({ disabled })`; plugin iframes carry `lang` and `title`.
- **hq-chess** is the first user: a chessboard object, seats kept until a reset, presence = the board's window is open, no chess rules checked, a reserve of captured pieces, free promotion, a playing badge, one game saved per board in the plugin's key-value store (`board:<x>,<y>`). Later the same day, after the user tried it: the window takes the full screen (as the Cards table) with the pieces at the largest whole scale, the last action's squares are tinted, and either seated player can undo the last action, one level (the board saves the position before it, `u`, and its squares, `m`; boards saved before load without them).

## Alternatives

- **Baked props from plugins:** the map texture would be rebuilt when a plugin starts or stops and plugin art would need the painter API.
- **A view that talks to the server itself:** a new authenticated route or socket per view, and a second place to enforce limits.
- **Moves checked by the server with chess rules:** a rules engine to maintain for a social table game; players police each other as at a real table.

## Impact

- **Performance:** one sprite per placed object; updates only for dynamic objects (bounded at 64) in an existing message; view traffic is bounded at 30 messages a second each way, 4 KB each, and a drag sends one message, on drop. Not measured: no load or capacity test was run for this change.
- **Maintenance:** one more manifest section and iframe type, covered by Go tests, web unit tests and the `plugins`, `chess` and `a11y` browser scenarios.
- **Install:** none. No migration; `GET /api/plugins` entries gain `hosts`, `objects` and `views`; existing plugins work unchanged.
