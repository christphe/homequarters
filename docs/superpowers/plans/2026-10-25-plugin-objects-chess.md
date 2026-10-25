# Plugin objects, plugin views and hq-chess Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task also follows the repository's gauntlet (`.agents/skills/gauntlet/SKILL.md`): red check first, `scripts/gauntlet.sh <scenarios>` to `GATES GREEN`.

**Goal:** Let plugins put objects on the map that X opens, show a sandboxed view of their own in their modal, and ship `hq-chess`, a two-player chessboard without rules.

**Architecture:** Map props of type `<plugin>/<kind>` are validated by `gamemap` whatever plugins are installed; the world's `doUse` checks reach and access then raises a non-blocking `OnUse` hook that the plugin host turns into the plugin's `onUse` export. Pages draw plugin objects of running plugins as sprites in the entity layer. A new modal element `view` is a second sandboxed iframe running the plugin's compiled view script; it talks only to the plugin's hidden client iframe through the page. `hq-chess` keeps one board per object in `hq.kv`.

**Tech Stack:** Go (world, gamemap, plugin host on QuickJS, esbuild), TypeScript (PixiJS world, React UI, plugin SDK), Node test runner, Puppeteer e2e (`e2e/run.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-25-plugin-objects-chess-design.md` (read it first; this plan argues from it).

**Branch:** `feat/plugin-chess`, based on `feat/office-templates` (`f081e49`). Worktree: `.claude/worktrees/plugin-chess`.

## Global Constraints

- Everything in English (code, comments, docs, commit messages). Player-facing strings of Home Quarters go through `web/src/i18n.ts`; plugin strings stay plain English in the plugin.
- Plugin prop type: `^<plugin>/<kind>$`, plugin matching `^[a-z][a-z0-9-]{0,31}$`, kind matching `^[a-z][a-z0-9-]{0,31}$`; `W`, `H` required, 1-4; no `Data`, no `To`; never solid.
- Manifest `objects`: at most 8, `kind` unique, `size` `[w, h]` each 1-4, `label` 1-40 characters, `sprite` a `.png` of `public/` that exists, `frame` optional `[x, y, w, h]` (w, h 1-128).
- Manifest `views`: at most 4, names `^[a-z][a-z0-9-]{0,31}$`, each a `.ts`/`.js` inside `public/`, compiled like `client` (256 KB cap), served at `/plugins/<name>/views/<view>.js`.
- `onUse` throttle: 4 a second per member, burst 8, silent drop. Invisible members never reach a plugin.
- View messages: JSON, at most 4096 bytes each way, 30 a second each way per view; over the limit dropped with a console warning. One view per modal. View iframe: `sandbox="allow-scripts"` only, CSP as strict as the hidden iframe's (`host.ts` `policy()`).
- Chess kv key `board:<x>,<y>`, value `{ "p": <64 chars a8..h1, "KQRBNP"/"kqrbnp"/".">, "w": {id,name}|null, "b": {id,name}|null }`.
- Chess rules from the spec, verbatim: a seat is kept until a reset; a seated player cannot change side or spectate; present = has that board's window open; reset allowed to a present seated player, or to anybody when neither seated player is present; reset = start position + both seats free.
- No per-frame network: a drag sends one message on drop. No content in logs. No new unbounded queue.
- Invariant 10: original art drawn in code. Protocol changes update `web/src/net/protocol.ts`, `docs/protocol.md` and world tests together.
- Commit only files of this change; never `git add -A` (shared checkout habits).

## Review Focus

1. **A map holding objects of a plugin whose manifest no longer declares that kind** (plugin updated): not drawn, no X hint, `onUse` never called, map still saves. Test: Task 5 (`objectsFor` skips unknown kinds) and Task 3 (`Host.Use` drops unknown kinds).
2. **Two players dropping at the same time on the same board**: the server applies them in order; every open window converges on the server's position within 1 s. Test: Task 8 Go test (`TestChessMovesApplyInOrder`) and the e2e check of Task 9.
3. **A view sending garbage** (non-JSON-able, over 4 KB, 100 a second): dropped with a warning, the plugin keeps running, the modal stays. Test: Task 6 unit test of `checkViewMessage` + e2e `plugins` addition.
4. **A board removed from the map and placed again on the same tile**: its saved game comes back (documented, accepted). A board moved elsewhere starts fresh. Test: Task 8 Go test `TestChessBoardKeyIsItsTile`.
5. **X between a chessboard and a built-in object** (board on a table next to a whiteboard): the nearest one wins, as today. Test: Task 5 unit test of `nearestUsable`.

---

### Task 1: Plugin prop types in the map

**Files:**
- Modify: `server/internal/gamemap/map.go` (Prop helpers near `IsContent`/`Interactive` ~l.94-98, `Size` ~l.162, `Validate` prop loop ~l.217-257)
- Test: `server/internal/gamemap/map_test.go` (create `plugin_prop_test.go` if `map_test.go` is crowded)

**Interfaces:**
- Produces: `func (p Prop) PluginKind() (plugin, kind string, ok bool)`; `Interactive()` true for plugin props; `Size()` returns `W`, `H` for plugin props; `Validate` accepts them.

- [ ] **Step 1: Write the failing tests** `TestPluginPropValidates` (table-driven): `{T:"hq-chess/chessboard",X:1,Y:1,W:1,H:1}` valid with no plugin anywhere; refused: `"hq-chess/"`, `"/chessboard"`, `"Hq/x"`, `"a/b/c"`, `W:0`, `W:5`, missing `H`, `Data:"x"`, `To:&Point{}`, out of bounds. `TestPluginPropIsInteractiveNotSolid`: `Interactive()` true; compiled collision grid has no solid tile at its footprint.
- [ ] **Step 2: Run** `cd server && go test ./internal/gamemap -run PluginProp` → FAIL (unknown type).
- [ ] **Step 3: Implement** `PluginKind` (split on the single `/`, both halves matching the name regex) and branch `Validate` before the `propDefaults` lookup; `Size` uses `W`/`H` when `PluginKind` ok; solidity stays false (absent from `propDefaults`).
- [ ] **Step 4: Run** `cd server && go test ./internal/gamemap` → PASS (template fixture tests included).
- [ ] **Step 5: Commit** `git add server/internal/gamemap && git commit -m "Map props of type <plugin>/<kind> for plugin objects"`

### Task 2: Manifest objects and views, served to pages

**Files:**
- Modify: `server/internal/plugin/catalog.go` (Manifest, `load` checks), `server/internal/plugin/compile.go` (`compiled.views map[string][]byte`), `server/internal/plugin/host.go` (`func (h *Host) View(name, view string) ([]byte, bool)`), `server/internal/httpapi/plugins.go` (`pluginEntry`, `listPlugins`, route `GET /plugins/{name}/views/{view}`)
- Test: `server/internal/plugin/catalog_test.go`, `server/internal/httpapi/plugins_test.go` (or the existing plugin route test file)

**Interfaces:**
- Produces (Go): `type Object struct { Kind, Label, Sprite string; Size [2]int; Frame *[4]int }`; `Manifest.Objects []Object` (`json:"objects"`), `Manifest.Views map[string]string` (`json:"views"`); `func (i *Info) Object(kind string) (Object, bool)`.
- Produces (HTTP): `/api/plugins` entries gain `"objects": [{kind,label,size,sprite,frame?}]` and `"views": ["board"]` (names only). `GET /plugins/<name>/views/<view>.js` serves the compiled view like `pluginClient` (same headers, ETag, 404 unless running).

- [ ] **Step 1: Write the failing tests** in `catalog_test.go`, using `write(t, root, files)`: a plugin with one valid object and one view loads with `Err == ""` and `Object("chessboard")` found; each broken rule gives an `Err` naming it: bad kind, duplicate kind, size `[0,1]`, size `[5,1]`, 9 objects, missing sprite file, sprite not `.png`, label 41 characters, view name `"Board"`, view file missing, view outside `public/`, 5 views. A view importing outside `public/` fails to compile (same rule as `client`).
- [ ] **Step 2: Run** `cd server && go test ./internal/plugin -run 'Object|View'` → FAIL.
- [ ] **Step 3: Implement** the checks in `load` (after settings), compile each view in `code()` with `bundle(pub, pub, file, api.FormatIIFE, "", api.PlatformBrowser)`, `Host.View`, the route and the entry fields.
- [ ] **Step 4: Write and run the HTTP test**: running plugin → `GET /api/plugins` lists its objects and views; `GET /plugins/<n>/views/board.js` 200 with `text/javascript`; unknown view or stopped plugin 404. `cd server && go test ./internal/plugin ./internal/httpapi` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Plugin manifests declare map objects and views"` (only the files above).

### Task 3: X on a plugin object reaches the plugin (`onUse`)

**Files:**
- Modify: `server/internal/world/features.go` (`doUse`), `server/internal/world/world.go` (`OnUse` field next to `OnPresence`; per-player use bucket on `Player`), `server/internal/plugin/instance.go` (`evUse`, `exportNames` gains `onUse`, the export error message lists it), `server/internal/plugin/host.go` (`Use`), `server/internal/httpapi/plugins.go` (`pluginHost` wires `w.OnUse`)
- Test: `server/internal/world/features_test.go`, `server/internal/plugin/host_test.go`

**Interfaces:**
- Consumes: `Prop.PluginKind()` (Task 1), `Info.Object(kind)` (Task 2).
- Produces: `World.OnUse func(officeID int64, userID uint32, name, role, plugin, kind string, x, y int)` (must not block); `func (h *Host) Use(p Player, plugin, kind string, x, y int)`; plugin export `onUse(player, { kind, x, y })`.

- [ ] **Step 1: Write the failing world tests** `TestUsePluginObject` in `features_test.go`, on a map with `{T:"demo/thing",X:..,Y:..,W:1,H:1}`: a player within `useReach` pressing use → `OnUse` called once with `("demo","thing",x,y)` and no `obj` frame; out of reach, inside a locked area they may not enter, or invisible → no call; 20 uses in one tick → at most 8 calls (burst), then 4 a second.
- [ ] **Step 2: Write the failing host test** `TestUseCallsOnUse` with `newHost(t, map[string]string{...})`: a plugin whose manifest declares object `thing` and whose `onUse` does `hq.send(p.id, {k: o.kind, x: o.x, y: o.y})` → the sink gets it; `Use` with an undeclared kind, or for a stopped plugin → nothing; an exception in `onUse` counts as an error like any export.
- [ ] **Step 3: Run** `cd server && go test ./internal/world -run UsePlugin && go test ./internal/plugin -run UseCalls` → FAIL.
- [ ] **Step 4: Implement**: in `doUse`, after reach and area checks, a plugin prop calls `w.OnUse` if set and the player is not invisible and the bucket allows; `Host.Use` looks up the running instance and `Info.Object(kind)`, posts `event{kind: evUse, p, data: {"kind","x","y"} JSON}`; `handle` calls `onUse` with `in.actor = e.p.ID`. Wire in `pluginHost`.
- [ ] **Step 5: Run** `cd server && go vet ./... && go test -race ./internal/world ./internal/plugin ./internal/httpapi` → PASS.
- [ ] **Step 6: Commit** `git commit -m "Pressing X next to a plugin object calls the plugin's onUse"`

### Task 4: SDK types and plugin docs for objects, onUse and views

**Files:**
- Modify: `plugins/sdk/server.d.ts` (`Exports.onUse?(player: Player, object: { kind: string; x: number; y: number }): void`), `plugins/sdk/client.d.ts` (`UI.view(opts: { view: string; label: string; height?: "small" | "medium" | "large"; onMessage?: (msg: any) => void }): UINode`, `UI.post(msg: unknown): void`, `UINode.type` gains `"view"`), create `plugins/sdk/view.d.ts` (global `hqView: { send(msg: unknown): void; onMessage<T = unknown>(fn: (msg: T) => void): void }`), `docs/plugins.md` (sections "Objects on the map", "Views", `onUse` row, layout tree, limits tables), `docs/plugin-api.md` (same, reference form)

- [ ] **Step 1: Write** the declarations and docs from the spec's §1-3 and the Global Constraints values.
- [ ] **Step 2: Run** `cd web && pnpm exec tsc -p ../plugins/bundled/hq-pets && pnpm exec tsc -p ../plugins/bundled/hq-pets/public` → PASS (no regression). `cd site && node build.mjs && node check.mjs` → PASS.
- [ ] **Step 3: Commit** `git commit -m "Document plugin objects, onUse and views"`

### Task 5: Pages draw plugin objects and offer X on them; the editor places them

**Files:**
- Create: `web/src/game/pluginObjects.ts`
- Modify: `web/src/net/protocol.ts` (`PluginObjectSpec`), `web/src/plugins/manager.ts` (keeps `objects` of every running entry, including plugins without client code, and calls `view.setPluginObjects`), `web/src/game/WorldView.ts` (`updateNearby` uses `nearestUsable`; `setPluginObjects`; objects redraw on map change), `web/src/game/mapModel.ts` (`propSize` handles plugin props: `w`/`h`), `web/src/ui/MapEditor.tsx` (palette group per running plugin; placeholder for objects of plugins not running), `web/src/i18n.ts` (editor strings: group heading, placeholder text)
- Test: `web/test/pluginObjects.test.ts`

**Interfaces:**
- Consumes: `/api/plugins` `objects` (Task 2).
- Produces: `interface PluginObjectSpec { plugin: string; kind: string; label: string; size: [number, number]; sprite: string; frame?: [number, number, number, number] }`; `function objectsFor(props: Prop[], specs: PluginObjectSpec[]): { prop: Prop; spec: PluginObjectSpec }[]` (only props whose `plugin/kind` is declared by a running plugin); `function nearestUsable(props: Prop[], specs: PluginObjectSpec[], x: number, y: number, reach: number): Prop | null` (built-in usable kinds plus `objectsFor`, nearest by the existing rectangle distance); `WorldView.setPluginObjects(specs: PluginObjectSpec[]): void`.

- [ ] **Step 1: Write the failing unit tests**: `objectsFor` drops a prop of a stopped plugin and one whose kind the manifest no longer declares; `nearestUsable` returns the chessboard when it is nearer than a whiteboard, the whiteboard when nearer, `null` beyond 20 px; `propSize` of `{t:"hq-chess/chessboard",w:1,h:1}` is `[1,1]`.
- [ ] **Step 2: Run** `node --test web/test/pluginObjects.test.ts` → FAIL.
- [ ] **Step 3: Implement**: sprites in `entLayer` (texture from `<base><sprite>` cut to `frame`), anchored at the bottom-left of the footprint, `zIndex = (y + h) * 16` so avatars north of a table stay behind the board on it; removed when the spec list drops the plugin; `dirty` set on change. `interact()` keeps sending `use` with the prop's `x, y`. Editor: placing writes `w`/`h` from the spec; a plugin prop of a non-running plugin is drawn in the editor as a dashed rectangle with its type, erasable.
- [ ] **Step 4: Run** `node --test web/test/pluginObjects.test.ts && cd web && pnpm exec tsc --noEmit && node ../scripts/lint-web.mjs` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Pages draw plugin objects and offer X next to them; the editor places them"`

### Task 6: Plugin views in the modal

**Files:**
- Create: `web/src/plugins/viewSdk.js` (the `hqView` global, inlined in the view's srcdoc like `sdk.js`), `web/src/ui/PluginViewFrame.tsx`
- Modify: `web/src/plugins/commands.ts` (`UINode` gains `{ type: "view"; view: string; label: string; height: "small"|"medium"|"large"; message?: string }`; `Cmd` gains `{ op: "post"; d: unknown }`; `LIMITS.viewBytes = 4096`, `LIMITS.viewRate = 30`; at most one view per tree; `export function checkViewMessage(d: unknown): string | null`), `web/src/plugins/sdk.js` (`ui.view`, `ui.post`, view messages delivered to the `onMessage` callback of the view node), `web/src/plugins/host.ts` (`policy()` reused for the view; `views: string[]` from the entry; relays `post` to the open view and view messages to the hidden iframe as `{ t: "cb", id: message, v }`), `web/src/ui/PluginUI.tsx` (`case "view"` renders `PluginViewFrame`, keyed by plugin + view so a redraw keeps the iframe), `web/src/styles.css` (view heights)
- Test: `web/test/pluginView.test.ts`; e2e `e2e/scenarios/plugins.mjs` + fixture `e2e/fixtures/plugins/installed/ui-demo` (add a `views` entry `echo` that echoes and tries `parent.document`)

**Interfaces:**
- Consumes: `/api/plugins` `views` and `/plugins/<n>/views/<v>.js` (Task 2).
- Produces: plugin client API `hq.ui.view({ view, label, height, onMessage })`, `hq.ui.post(msg)`; view API `hqView.send(msg)`, `hqView.onMessage(fn)`.

- [ ] **Step 1: Write the failing unit tests**: `parseBatch` accepts a modal with one `view` node of a declared shape, refuses two views in one modal, a label of 41 characters, an unknown height; `checkViewMessage` refuses a 4097-byte message and non-JSON (a function, a cycle) and accepts `{t:"move",from:52,to:36}`.
- [ ] **Step 2: Run** `node --test web/test/pluginView.test.ts` → FAIL.
- [ ] **Step 3: Implement** the view iframe: `sandbox="allow-scripts"`, `title=label`, `srcdoc` = CSP meta (same `policy()`), `viewSdk.js` inlined, `<script src="/plugins/<n>/views/<v>.js">`; handshake over a `MessageChannel` as `host.ts` does; per-direction rate window of 30/s; removed on modal close, on another plugin's modal, on plugin stop.
- [ ] **Step 4: Extend the e2e `plugins` scenario**: open ui-demo's modal with the `echo` view; a message round-trips view → client → view; `parent.document` access throws inside the view; 100 messages in one second → at most 30 delivered and the plugin still runs; closing the modal removes the iframe.
- [ ] **Step 5: Run** `node --test web/test/pluginView.test.ts && scripts/gauntlet.sh plugins` → `GATES GREEN`.
- [ ] **Step 6: Commit** `git commit -m "Plugin views: a sandboxed iframe of the plugin in its modal"`

### Task 6b: `hq.attach`, a sprite above a member's head

**Files:**
- Modify: `web/src/plugins/commands.ts` (`Cmd` gains `{ op: "attach"; id: string; player: number | null }`, player 1..2^32-1 or null), `web/src/plugins/sdk.js` (`hq.attach(id, memberId)`), `web/src/game/pluginLayer.ts` (attached entities: position each frame from the member's drawn position and head top; hidden while off screen; ignore moveTo/walkTo/follow while attached), `web/src/game/WorldView.ts` (whatever `LayerHost` needs to expose: the member's drawn feet position and `AvatarFrames.tall` head top, read from what already places name tags), `plugins/sdk/client.d.ts` (`attach(id: string, memberId: number | null): void`), `docs/plugins.md` and `docs/plugin-api.md` (one row each)
- Test: `web/test/pluginView.test.ts` or a new `web/test/pluginAttach.test.ts` (command validation); e2e check lands in Task 9

**Interfaces:**
- Produces: plugin client API `hq.attach(id, memberId | null)`; the sprite's bottom centre sits 2 px above the top of the member's name tag.

- [ ] **Step 1: Write the failing tests**: `parseBatch` accepts `{op:"attach",id:"b",player:7}` and `{op:"attach",id:"b",player:null}`, refuses player 0, 1.5, "7", 2^32.
- [ ] **Step 2: Run** `node --test web/test/pluginAttach.test.ts` → FAIL.
- [ ] **Step 3: Implement** the command, the SDK call and the layer behaviour (set `dirty` when an attached sprite moves; no per-frame allocation).
- [ ] **Step 4: Run** `node --test 'web/test/*.test.ts' && cd web && pnpm exec tsc --noEmit && pnpm exec vite build && cd .. && node scripts/lint-web.mjs` → PASS.
- [ ] **Step 5: Commit** `git commit -m "hq.attach: a plugin sprite above a member's head"`

### Task 7: hq-chess game logic

**Files:**
- Create: `plugins/bundled/hq-chess/public/game.ts`, `plugins/bundled/hq-chess/public/messages.ts`
- Test: `web/test/chess.test.ts`

**Interfaces:**
- Produces (`game.ts`): `type Side = "w" | "b"`; `interface Seat { id: number; name: string }`; `interface Board { p: string; w: Seat | null; b: Seat | null }`; `const START = "rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR"` (index 0 = a8, 63 = h1); `newBoard(): Board`; `parseBoard(s: string | null): Board` (anything invalid → `newBoard()`); `sideOf(piece: string): Side | null`; `seatOf(b: Board, id: number): Side | null`; `take(b: Board, side: Side, who: Seat): boolean`; `move(b: Board, who: number, from: number, to: number): boolean`; `canReset(b: Board, who: number, present: ReadonlySet<number>): boolean`; `reset(b: Board): void`; `squareName(i: number): string` (52 → `"e2"`).
- Produces (`messages.ts`): `ToServer = {t:"hello"} | {t:"seat",x,y,side:Side} | {t:"move",x,y,from,to} | {t:"reset",x,y} | {t:"close",x,y}`; `ToClient = {t:"open"|"state", x, y, s: { p: string; w: (Seat & {here:boolean}) | null; b: (Seat & {here:boolean}) | null }}`; `ViewIn = { s: ToClient["s"]; me: number }`; `ViewOut = { t: "move"; from: number; to: number }`.

- [ ] **Step 1: Write the failing tests**: `take` refuses a taken seat and a member already seated on the other side; `move` by White of `52→36` works, of a black piece fails, by a spectator fails, `from===to` fails, out of 0..63 fails, onto a black piece removes it; `canReset` true for a present seated player, false for a spectator while a seated player is present, true for anybody when both seated players are absent or seats are empty, false for an absent seated player while the other is present; `reset` gives `START` and empty seats; `parseBoard` of `null`, `"{"`, a 63-char `p`, a `p` with `"x"` → new board.
- [ ] **Step 2: Run** `node --test web/test/chess.test.ts` → FAIL.
- [ ] **Step 3: Implement** `game.ts` (pure, no `hq`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "hq-chess: board, seats and reset rules"`

### Task 8: hq-chess plugin (server, client, view, sprite)

**Files:**
- Create: `plugins/bundled/hq-chess/plugin.json` (name `hq-chess`, title `Chess`, objects `[{kind:"chessboard",label:"Chessboard",size:[1,1],sprite:"chessboard.png"}]`, views `{board:"board.ts"}`, server `main.ts`, client `client.ts`), `main.ts`, `public/client.ts`, `public/board.ts`, `public/chessboard.png`, `tools/sprite.mjs` (writes the PNG with `node:zlib`, no dependency), `tsconfig.json`, `public/tsconfig.json` (includes `../../../sdk/view.d.ts` for `board.ts`)
- Modify: `scripts/gauntlet.sh` and `.github/workflows/ci.yml` (`plugin-types` lists `hq-chess` and `hq-chess/public`)
- Test: `server/internal/plugin/chess_test.go` (real plugin through `Scan` of `../../../plugins`, like `sample_test.go`)

**Interfaces:**
- Consumes: `game.ts`, `messages.ts` (Task 7), `onUse` (Task 3), `hq.ui.view`/`hq.ui.post`/`hqView` (Task 6).

- [ ] **Step 1: Write the failing Go tests**: `TestChessOpensOnUse` (`Use` → that member gets `{t:"open",x,y,s}` with the start position); `TestChessSeatsMovesAndPresence` (A seat w, B seat b, A move 52→36 → both get `state` with `here:true`; B `close` → A's state shows B `here:false`; C cannot reset while A present; A `close` → C resets → seats null); `TestChessHelloMakesAbsent`; `TestChessSurvivesRestart` (same `memKV`, new host: position and seats kept, nobody present); `TestChessMovesApplyInOrder`; `TestChessBoardKeyIsItsTile`; `TestChessIgnoresMalformed` (wrong types, unknown board never opened, 0 errors counted).
- [ ] **Step 2: Run** `cd server && go test ./internal/plugin -run Chess` → FAIL.
- [ ] **Step 3: Implement `main.ts`**: boards loaded lazily from `hq.kv`; `viewers: Map<string, Set<number>>` in memory; messages need the sender to be a viewer of `x,y` (except `hello`); changes collected per board and sent to its viewers in `update()`, kept for the next tick when a send returns `false`; `kv.set` on every board change.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Implement `client.ts`**: `onLoad` sends `hello`; on `open`/`state` draws the modal `Chess` (medium): a row of White/Black/Spectate buttons with the rules of the spec's "Window" paragraph, Reset (enabled by `canReset`), and `hq.ui.view({ view: "board", label: "Chessboard", height: "large", onMessage })`; posts `{ s, me }` to the view on each state; `onClose` sends `close`.
- [ ] **Step 6: Implement `board.ts`**: canvas 8x8, pixel-art pieces drawn in code, flipped when `me` is Black; pointer drag with snap, drop outside → back; click-click; keyboard (arrows, Enter/Space, Escape) with an `aria-live` region announcing `"<Side>: <piece> e2 to e4"`; one `hqView.send({t:"move",from,to})` per drop; optimistic redraw corrected by the next state.
- [ ] **Step 6b: Playing badge**: the server keeps the list of present seated players and broadcasts `{ t: "playing", list: [{ id, side }] }` to everyone when it changes (collected in `update()`), and sends it to a member in `onJoin`; `client.ts` spawns one badge sprite per listed member (`badge-<id>`, anim `w` or `b`) and `hq.attach`es it, removing badges no longer listed. Go test `TestChessPlayingList` (seat + open → listed; close → unlisted; reset → empty; a joining member gets the list).
- [ ] **Step 7: Generate the sprites** `node plugins/bundled/hq-chess/tools/sprite.mjs` → writes `public/chessboard.png` (16x16 board seen from above, 1 px dark outline, matches `docs/art-style.md`) and `public/badges.png` (two 7x9 piece icons, white and black, 1 px dark outline, readable over any floor).
- [ ] **Step 8: Run** `cd web && pnpm exec tsc -p ../plugins/bundled/hq-chess && pnpm exec tsc -p ../plugins/bundled/hq-chess/public && cd ../server && go test -race ./internal/plugin` → PASS.
- [ ] **Step 9: Commit** `git commit -m "hq-chess: a chessboard two members play on, without rules"`

### Task 9: Browser checks for chess

**Files:**
- Create: `e2e/scenarios/chess.mjs`, `e2e/scenarios/capture-chess.mjs` (copy of `capture-plugin-pet.mjs`, not in the default suite)
- Modify: `e2e/run.mjs` (`all` gains `"chess"`), `e2e/scenarios/a11y.mjs` (axe with the chess window open)

- [ ] **Step 1: Write `chess.mjs`** (admin enables `hq-chess` with `PUT /api/admin/plugins/hq-chess`, puts a `hq-chess/chessboard` 1x1 on the bottom row of a table of the map through `PUT /api/map`, then three members A, B, C walk next to it). Checks, each through the real controls with the modal open: board sprite drawn and X hint shown (criterion 4); X opens `Chess`; A White, B Black, C Spectate, C cannot pick a piece, A cannot pick a black piece (5); real mouse drag e2→e4 by A seen by B and C within 1 s, capture on an occupied square, drop outside returns, click-click works (6); exactly one `plg` frame per drop (count on A's socket) (10); keyboard-only move by B reaches A and the live region announces it (11); B closes → A sees "away"; C Reset disabled; A closes → C resets → seats free (7); server restart → board, seats back (8); plugin off → sprite gone and X does nothing; on → back with its game (4); while A and B have the window open, C's page shows a white badge above A and a black badge above B, the badge follows A when A walks, and disappears within 1 s after A closes the window (13).
- [ ] **Step 2: Run** `cd e2e && node run.mjs chess` → every check passes. Sanity: make `canReset` always return `true`, rerun, check 7 fails; revert.
- [ ] **Step 3: Run** `cd e2e && node run.mjs capture-chess` and look at the frames: board readable on the table at the default zoom, avatars north of the table behind it, pieces readable in the window (12).
- [ ] **Step 4: Run** `scripts/gauntlet.sh chess a11y plugins` → `GATES GREEN`.
- [ ] **Step 5: Commit** `git commit -m "Browser checks for the chess plugin"`

### Task 10: Decision record, status, changelog

**Files:**
- Create: `docs/decisions/0030-plugin-objects-and-views.md` (why live sprites over baked props, why views relay through the client iframe, limits, performance/maintenance/install impact)
- Modify: `docs/protocol.md` (plugin entry fields, prop type form), `docs/status.md` and the README status table (measured vs not run), `server/CHANGELOG.md` via `fchange added "Plugins can put objects on the map that X opens, and show a view of their own in their window; the bundled Chess plugin uses both (#N)" --pkg server`, `site/build.mjs` `NAV` if a page is added

- [ ] **Step 1: Write** the ADR and doc updates.
- [ ] **Step 2: Run** `scripts/gauntlet.sh` (whole suite) → `GATES GREEN`; `cd site && node build.mjs && node check.mjs` → PASS.
- [ ] **Step 3: Commit** `git commit -m "ADR 0030, status and changelog for plugin objects and views"`
- [ ] **Step 4: Gauntlet critics** (UX, invariants, regression) per `.agents/skills/gauntlet/SKILL.md` against the spec's acceptance criteria; loop until no blocker or major.
