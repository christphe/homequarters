# Plugin objects, plugin views and a chess plugin: design

Date: 2026-10-25. Status: draft for review.

## Intent

A member walks up to a chessboard standing on a table, presses X, and a window opens where two people play chess against each other while others watch. The game on each board is kept until somebody resets it.

Chess must be a **plugin** (`hq-chess`, bundled), not a built-in object like the whiteboard. Today a plugin cannot do this: it cannot put an object on the map, it never hears about X, and its modal only offers text, buttons and small widgets (at most 64 elements: a board of 64 squares does not fit). So this change extends the plugin API with three general pieces, and chess is their first user:

1. **Plugin objects**: a plugin declares map objects (kind, size, sprite) in its manifest; administrators place them with the map editor; they show and work only while the plugin runs.
2. **`onUse`**: pressing X next to a plugin object calls the plugin's server code, after Home Quarters checked reach and room access.
3. **Plugin views**: a visible, sandboxed iframe inside the plugin's modal, running the plugin's own compiled code, so a plugin can draw anything (a chessboard with drag and drop) without a new widget per use.

## Goals

- Any plugin can declare objects in `plugin.json`, place-able from the map editor while it runs.
- A plugin object is drawn from the plugin's PNG, can stand on top of furniture (a chessboard on a table), and is pressed with X like the whiteboard.
- `onUse(player, object)` in the plugin's server code, with the server enforcing reach and area access exactly as `doUse` does for built-in objects.
- `hq.ui.view(...)` in a plugin modal: a sandboxed iframe running a view script of the plugin, talking to the plugin's hidden client code (which talks to the server as today).
- `hq-chess`: take the White or Black seat (anybody else with the window open watches); move pieces by drag and drop, snapped to squares, no rules; live for everyone with the window open; the position and the two players saved per board; a seat kept by its player until a reset; reset by a seated player who has the window open, or by anybody when neither seated player has it open.

## Non-goals (this change)

- Chess rules: legal moves, turns, check, castling, en passant, promotion, end of game. Pieces go where they are dropped.
- Clock, move history, undo, resign, draw offers, inviting a player, leaving a seat without a reset. ("It's a first version, there are no griefers; we will do something more complete later.")
- Plugin objects that block movement, carry admin-edited content (`Data`), or act on walking onto them (like portals).
- Plugins adding objects at run time from code; objects come from the manifest only.
- Views that talk to the server directly or reach the page, the session, media or other plugins.
- Cleaning up the saved games of boards removed from the map.

## Anti-goals (a failure even if it works)

- A plugin object usable from across the office or from a locked room: reach and area access are the server's, never the plugin's or the browser's.
- A view that can read the page, the cookies, `window.__hq`, camera or microphone, or fetch hosts the manifest did not declare.
- A stopped or missing plugin leaving a dead object on the map that looks usable.
- Any per-frame message: dragging a piece sends one message on drop, not while dragging.
- Losing a game on server restart or when a plugin is turned off and on.
- Third-party chess art: pieces and board are original pixel art drawn in code (AGENTS.md invariant 10).

## Decisions taken with the user

- Objects of a plugin that is off or missing **disappear** (not drawn, X does nothing). Their entries stay in the saved map so they come back with the plugin, and the game saved for them is kept. *(Builder's call recorded: keeping the entries is ours; deleting them would lose placements and games on any failed restart.)*
- Objects are **live sprites in the PixiJS world**, not baked into the map texture by `tiles.ts`: turning a plugin on or off shows or hides them without re-baking, and the map never waits for a plugin's PNG. A chessboard must be placeable **on a table**.
- The view iframe talks **only to its plugin's hidden client code**, which relays to the server with the existing `hq.send` and its existing budget. One channel, one rate limit.
- **The game records its players** ("Michel White, Vincent Black"), saved with the position, so they survive a restart.
- **A seat is kept until a reset.** Closing the window, reloading the page or leaving the office makes the player *absent*, not unseated: when they open that board again they are back in their seat. A seated player **cannot leave voluntarily** (it would invalidate the game). Leaving a game takes a reset.
- A player is **present** while they have that board's window open.
- **Reset** puts everything back to zero: start position and both seats free, so anybody can then take a side. A seated player who is present may always reset; anybody may reset when neither seated player is present. This is also how an abandoned board is recovered.
- First version, no griefers.

## Constraints from the codebase

- Map props (`gamemap.Prop`) have a type `T` checked against `propDefaults` in `Map.Validate`; unknown types are refused. `Interactive()` gates `doUse` (`world/features.go`), which checks reach (`useReach`) and area access, then answers the client.
- The world is one goroutine per office; hooks (`OnPresence`, `OnAction`, ...) must not block. Plugin events reach the plugin host through queued events; plugin frames go back through `World.PluginFrame`.
- The plugin host (`internal/plugin`) knows each plugin's manifest; pages learn the running plugins from `/plugins` info and `{"t":"plgs"}`.
- A plugin's hidden iframe is built from `srcdoc` with the SDK inlined and a Content Security Policy limited to its own folder and its declared hosts (`web/src/plugins/host.ts`). Only `.png`, `.js`, `.json`, `.css` are served from `public/`; HTML is not.
- Plugin storage: `hq.kv`, values up to 4 KB, at most 1000 keys per plugin and office.
- Modal limits: 64 elements, 4 deep; slots 8; batches 30/s; client-to-server messages 8/s per page, 1500 bytes.
- The map editor (`web/src/ui/MapEditor.tsx`) lists built-in kinds; the wire map is the saved map minus `Data`.
- The working tree has uncommitted office-template work touching `map.go`, `tiles.ts`, `WorldView.ts`, `MapEditor`-adjacent files: build on it, do not revert it.

## Design

### 1. Plugin objects

**Manifest.**

~~~json
"objects": [{ "kind": "chessboard", "label": "Chessboard", "size": [1, 1],
              "sprite": "chessboard.png", "frame": [0, 0, 16, 16] }]
~~~

- `kind` matches `^[a-z][a-z0-9-]{0,31}$`, unique in the plugin; at most 8 objects per plugin.
- `size` is in tiles, 1-4 each way. `sprite` is a PNG of `public/`; `frame` optional (`[x, y, w, h]`, defaults to the whole image), drawn anchored at the bottom-left of the object's footprint, so it may rise above it (a tall object).
- `label` (1-40 characters) names it in the editor and is its default label.
- A manifest breaking these rules makes the plugin *Cannot run*, like any invalid manifest.

**On the map.** A placed object is a prop with `t = "<plugin>/<kind>"` (`hq-chess/chessboard`). `/` cannot appear in built-in types, so there is no clash. `Map.Validate` accepts a type of that shape (plugin name and kind both matching their patterns) whether or not the plugin is installed, with its size taken from `W`/`H` (required for these props, 1-4), no `Data`, no `To`. It is never solid, so it can sit on a table, which blocks on its own. The editor writes `W`/`H` from the manifest when placing it. The map stays valid when the plugin is uninstalled.

**Drawing.** The page draws plugin objects of running plugins as sprites of the plugin layer (`web/src/game/pluginLayer.ts`), depth-sorted with the baked props they stand on so a chessboard on a table shows on the table, and avatars north of the table stay behind both. Objects of a stopped or unknown plugin are not drawn and not "nearby" (no X hint). The world view's "nearby" search includes plugin objects of running plugins.

**Editor.** The palette shows the objects of running plugins under the plugin's title, with the sprite as icon. Objects of a plugin that is not running show in the editor as a dashed placeholder of their size with the type as text, so an administrator can still see and delete them.

### 2. `onUse`

- X next to a plugin object sends the existing `use` message. `doUse` treats a plugin prop as interactive, applies the same reach and area checks, and then raises `OnUse(officeID, player, plugin, kind, x, y)`, a non-blocking hook like `OnPresence`.
- The plugin host delivers it to that plugin if it runs (dropped otherwise) as a new server export: `onUse(player, { kind, x, y })`, under the usual 50 ms budget and error counting. `player` is `HQ.Player`, `x`/`y` the object's top-left tile, which identifies the object.
- Throttle: at most 4 uses a second per member, burst 8 (a held X key). A dropped use is silent.
- Invisible members are offline to plugins: their X on a plugin object does nothing.
- Nothing is sent to the browser by Home Quarters; the plugin answers with `hq.send` (for chess: "open board x,y").

### 3. Plugin views

**Manifest.** `"views": { "board": "board.ts" }`: names (`^[a-z][a-z0-9-]{0,31}$`, at most 4) to scripts in `public/`, compiled by esbuild like `client` (same import rules, 256 KB each), served at `/plugins/<name>/views/<view>.js`.

**In the modal.** A new UI element `hq.ui.view({ view, label, height, onMessage })`:

- `view` names a manifest view; `label` (1-40) is the iframe's accessible title; `height` is a preset, `small` | `medium` | `large`, the width being the modal's. At most one view per modal.
- The page creates `<iframe sandbox="allow-scripts">` with `srcdoc`, a view SDK inlined and a CSP as strict as the hidden iframe's (its own folder plus declared hosts for images and fetch; nothing else). No `allow-same-origin`, no forms, no popups, no top navigation.
- Redrawing the modal with the same view (same `view` and position) keeps the iframe and its state; it is not reloaded.

**Messages.** In the view, a global `hqView`: `hqView.send(msg)` and `hqView.onMessage(fn)`. In the plugin's client code, `onMessage` of the view element receives what the view sends, and `hq.ui.post(msg)` sends to the open view. JSON, at most 4 KB each way, 30 a second each way per view (drops with a console warning beyond). The page relays over MessageChannels and never interprets the content. The view cannot call any other `hq` function.

**Lifetime.** Closing the modal, another plugin's modal replacing it, or the plugin stopping on that page removes the iframe. A view that breaks a limit is removed (the modal stays) with a console warning.

### 4. `hq-chess`

**Files.** `plugins/bundled/hq-chess/`: `plugin.json` (one object `chessboard`, size 1x1, one view `board`), `main.ts`, `public/client.ts`, `public/board.ts`, `public/messages.ts`, `public/chessboard.png` (generated by a script from code, committed), tsconfigs like `hq-pets`.

**Saved per board**, in `hq.kv` under `board:<x>,<y>`: `{ "p": "<64 chars>", "w": { "id", "name" } | null, "b": ... }`. `p` is the position, a8..h1, one character per square (`KQRBNP` white, `kqrbnp` black, `.` empty); `w` and `b` are the seated players (the name as it was when they sat, shown while they are offline). Loaded lazily on first use, written on every change. Viewers (who has the window open) live in memory only.

**Server.**

- `onUse(player, {x, y})`: load or create the board, add the player to its viewers, send them `{ t: "open", x, y, state }`.
- Messages from the client (`{ t, x, y, ... }`, all checked):
  - `seat` with `side` `"w"` | `"b"`: only from a viewer of that board who holds no seat on it, and only for a free seat. Anything else is refused (a seated player cannot change side or leave). There is no Spectate message: a viewer without a seat is a spectator.
  - `move` with `from`, `to` (0-63): only a seated player, only a piece of their colour, `to != from`. The piece moves; whatever was on `to` is removed. No other check.
  - `reset`: allowed if the sender holds a seat on that board and is a viewer of it, or if neither seated player is a viewer. Puts the start position back and frees both seats.
  - `close`: the member closed the window: removed from viewers (their seat stays).
  - `hello`: sent by the client code when it starts on a page (`onLoad`, so also after a reload or a reconnect): the member is removed from every board's viewers, since no window of theirs can be open. *(Builder's call: a reload makes them absent at once rather than after the 10 s reconnect grace.)*
- `onLeave` (leaving, removed, or gone invisible) removes the member from every board's viewers; their seats stay.
- Every change sends the new state (position, seated players, whether each is present) to the board's viewers, collected and sent in `update()` as `hq-pets` does (retry when the budget is spent).
- A viewer is not removed when walking away (the plugin does not know positions); closing the window is what counts. *(Builder's call: acceptable for v1; the whiteboard's walk-away close is not available to plugins.)*

*Revised 2026-10-25 (after the user tried it): the window is full screen (`size: "full"`, the view `height: "full"`, as the Cards table); one row holds the seat buttons, Undo and Reset, then the holders' line, then the board, which takes the largest whole scale the view allows (3x at 1280 x 720, 5x at 1920 x 1080; a short screen keeps 2x and the view scrolls). The board saves `u` (the position and reserve before the last action) and `m` (that action's squares, `{from?, to?}`); `{ t: "undo", x, y }` from a seated player who has the window open puts `u` back (seats unchanged) and clears `u` and `m`, one level only; a refused undo resends the state to its sender; reset clears both. The state carries `u` (an undo is available), `m` and `undone` (the side whose player undid the last action, until the next change). The view tints the last action's squares (a move: both; a place: where it went; a stash: where it started) and announces "White undid the last move" (or Black).*

**Window.** Opened on `open`: a medium modal titled "Chess" with two buttons in a row, *White* and *Black* (no Spectate button: *removed by the user on 2026-10-25*, since everybody with the window open sees the board). The member's own seat is pressed. A seat held by someone shows that player's name and whether they are here ("White: Michel (away)") and is disabled. A seated member has both disabled (leaving takes a reset). Then a Reset button (enabled per the rule above), and the `board` view below them. Buttons stay native modal elements so they are accessible.

**Board view.** A canvas of 8x8 squares in pixel-art style, flipped for the Black player. Pieces drawn in code. Pointer events: drag a piece of your colour and drop it; it snaps to the square under the pointer, or back to its square when dropped outside the board. Click a piece then a square does the same (touch screens and people who cannot drag). The board is also keyboard-operable: it takes focus, arrow keys move a square cursor, Enter or Space picks up and drops, Escape cancels, and a live region in the view announces the square under the cursor and each move ("White: pawn e2 to e4"). *(Builder's call, from AGENTS.md's accessibility rules; it gets its own check in the `chess` scenario.)* Spectators and non-owners cannot pick pieces up. A move sends one message on drop. The view redraws from the state the server sends; until the server confirms, the moved piece is shown at its new square (optimistic), corrected by the next state.

### 3b. Object callbacks, dynamic objects, objects drawn by the plugin *(added by the user on 2026-10-25)*

Two independent manifest choices per object:

- **Who draws it.** With `sprite` (a PNG of `public/`), the page draws it, as before. With `"sprite": null` (or no `sprite`), the page draws nothing: the plugin's browser code draws it, as for pets (`hq.spawn` with any sheet, a PNG or image data drawn in code). X, the hint, reach and the editor work the same either way; the editor shows a plugin-drawn object as a labelled box of its size.
- **Whether it gets updates.** `"dynamic": true` means the object gets `onObjectUpdate`; without it, it gets only init and destroy.

Three callbacks in the plugin's browser code, for objects of this plugin placed on the map:

- `hq.onObjectInit(fn(obj))` for **every** object: when the plugin starts on the page (one call per object already placed) and when an object is added to the map.
- `hq.onObjectDestroy(fn(obj))` for every object: when it is removed from the map (or its kind is no longer declared). When the plugin stops, its sprites go anyway; no call.
- `hq.onObjectUpdate(fn(dt, obj))` **only for objects marked `dynamic`**, in the existing update tick (about 10 a second), in the same message as `onUpdate`: no extra message per object or per frame.

`obj` is `{ kind, x, y, w, h, px, py }`: tiles, plus the top-left corner in world pixels. An object is identified by `kind` and `x, y` (moving one in the editor is a destroy then an init). At most 64 dynamic objects of one plugin get updates; the rest get init and destroy only, with one console warning.

**Captured pieces and promotion.** *(Added by the user on 2026-10-25.)*

- **Reserve.** A capture puts the taken piece in a reserve, shown beside the board for everybody (white's captured pieces on one side, black's on the other), drawn with piece sprites **half the size** of the board's (redrawn in code at that size, not scaled down). A seated player may drag a piece of their colour from the reserve onto any square (whatever was there goes to the reserve), and drag one of their pieces off the board into the reserve. Still no rules. The reserve is saved with the game (`"r": "<captured pieces>"` in the board's kv value) and emptied by a reset. Keyboard and click-click reach the reserve too.
- **Promotion.** Dropping a pawn on the last rank (rank 8 for white, rank 1 for black) opens a small choice in the view: queen, rook, bishop, knight (the same half-size sprites), default queen, Escape keeps the pawn. The chosen piece is created whatever is already on the board (two queens are fine) and is sent as one move `{ from, to, promote }`. Not a rule check: a pawn may also stay a pawn.

**Playing badge.** *(Added by the user on 2026-10-25.)* A small chess-piece icon, white or black by the seat's colour, shows above the head of every **present** seated player, for everybody in the office. It goes away when the player closes the window (or a reset frees the seat). The icons are a PNG in the plugin's `public/`, drawn in code like the board sprite. The server broadcasts the list of present seated players (`{ t: "playing", list: [{ id, side }] }`) to every online member whenever it changes, and to a member when they join; each page attaches the matching sprite above those members with `hq.attach` (below).

**`hq.attach(id, memberId | null)`** *(new client API, for the badge)*: pins a spawned sprite of the plugin above that member's head, just above their name tag (the drawing's real top, `AvatarFrames.tall`), moving with them every frame without lag; hidden while the member is off screen; `null` detaches it (it stays where it is until moved or removed). An attached sprite ignores `moveTo`/`walkTo`/`follow` until detached.

**Text.** Plugin labels are plain English strings in the plugin, as for every plugin (not in `i18n.ts`).

## Protocol and docs touched

- No new WebSocket message for the client: `use` and `plg` frames carry everything. The plugin info sent to pages (`/plugins` list) gains `objects` (kind, label, size, sprite, frame) and `views` (names).
- `docs/plugins.md`, `docs/plugin-api.md`, `plugins/sdk/server.d.ts` and `client.d.ts` (plus a `view.d.ts` for `hqView`), `docs/protocol.md` (plugin info, prop type form), a new ADR `docs/decisions/0030-plugin-objects-and-views.md`, `docs/status.md` and the README status table, a `server/CHANGELOG.md` entry (added).

## Acceptance criteria and where each is observed

| # | Criterion | Seam |
| --- | --- | --- |
| 1 | A manifest with valid `objects`/`views` starts; each broken rule (bad kind, size 0 or 5, missing sprite, unknown view file, more than 8 objects) gives *Cannot run* with the rule | `internal/plugin` catalog tests |
| 2 | A map with `hq-chess/chessboard` props validates with or without the plugin installed; bad plugin or kind names, missing `W`/`H`, `Data` or `To` are refused | `gamemap` tests |
| 3 | X within reach of a plugin object calls `onUse` once with the member and the object; out of reach, from a locked area, invisible, or plugin off: no call | `world` and `plugin` tests |
| 4 | Plugin on: a chessboard the `chess` scenario places on a table of the map (through the map API, not in the shipped templates: bundled plugins start off, so a template board would stay hidden in new offices; *builder's call*) shows on top of it, with the X hint nearby; plugin off: it disappears and X does nothing; on again: back with its game | browser scenario `chess` + frames looked at |
| 5 | Two members open the same board; A takes White, B takes Black; a third, without a seat, watches and cannot move; White cannot move black pieces | browser scenario `chess` |
| 6 | A drag from e2 to e4 by White shows on all three windows within 1 s; dropping on an occupied square removes the piece there; a drop outside the board puts the piece back; click-then-click works | browser scenario `chess`, through the real controls |
| 7 | Seats: a seated player cannot change side or leave their seat; closing the window or reloading shows them "away" to the others within 1 s and they are back in their seat on reopening. Reset: a present seated player can; a spectator cannot while a seated player is present, and can once neither is; reset puts the start position back and frees both seats, which anyone can then take | browser scenario `chess` + server unit tests of `main.ts` logic |
| 8 | The position and the seated players survive a server restart and a plugin off/on | browser scenario `chess` (restart) |
| 9 | The view iframe is sandboxed without `allow-same-origin`, has the CSP, cannot read `parent.document`; its messages over 4 KB or 30/s are dropped | browser scenario `plugins` extension + `commands.ts` tests |
| 10 | One message per drop, none while dragging | browser scenario `chess` counts `plg` frames |
| 11 | The `a11y` scenario stays at zero axe violations with the chess window open; a move made with the keyboard only (arrows, Enter) reaches the other window and is announced | `a11y` and `chess` scenarios |
| 12 | The art is original and readable at the office's zoom (board on table; pieces in the window; the playing badge) | `capture-chess` frames and contact sheet, looked at |
| 13 | A present seated player shows a white or black piece badge above their name tag on every page (including pages far from the board, once the avatar is on screen); it follows them as they walk and disappears within 1 s of closing the window or a reset | browser scenario `chess` + frames looked at |

## Left to the builder

- Exact names of internal functions and messages, file layout inside `internal/plugin` and `web/src/plugins`.
- The depth rule's implementation for objects on furniture, as long as criterion 4 holds on the captured frames.
- The pixel art of the board sprite and pieces (within `docs/art-style.md`).
- Rate numbers above may be tuned if a test shows them wrong; record the change in the ADR.
