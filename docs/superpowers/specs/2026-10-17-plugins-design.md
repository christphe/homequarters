# Plugins: design

Date: 2026-10-17. Status: draft for review.

## Intent

Let the operator of a Home Quarters office add small features without forking: a plugin is a folder on the server with server code in **Lua** and/or browser code in **JavaScript**. The browser code never touches PixiJS, React, the session or media directly: it runs in a sandboxed iframe and asks the page to do things through a small message API ("load this animated sprite", "spawn it here", "follow this avatar", "show this button"). The page does the drawing and animation.

The scope of this change is the **plugin engine** only, sized by one target: *just enough to add a pet that follows its owner, outside the built-in pets*. A sample plugin (`sample-pet`) proves it end to end. Later work (not now): plugin modals and richer UI, a tower defense, a third-party "token companion" plugin and its desktop agent.

## Goals

- Operator-installed plugins: folders under a configured directory, read at start. No upload, no install UI.
- An administrator enables or disables each installed plugin from the admin dialog. A new plugin is **disabled** until enabled. Changes are audited and take effect live (no restart).
- Server API in Lua, in the spirit of LÖVE: `load`, `update(dt)`, player join/leave, messages from the plugin's browser code, HTTP routes under the plugin's prefix, a small persistent key-value store.
- Browser API in the iframe: retained-mode sprites (load, spawn, move, follow, animate, remove), messages to and from the plugin's Lua, buttons in a "Plugins" side-panel tab, a low-rate `update(dt, world)` with visible avatars.
- Static assets of a plugin served from its `public/` folder only.
- One sample plugin in the repo: an original creature that follows every member, with a "different pet" button and the choice remembered across restarts.

## Non-goals

- Untrusted plugins. Plugins are trusted code installed by the operator; the sandboxing below is for robustness and API discipline, not a security boundary against a hostile author on the server side.
- Plugin modals, forms, HTML panels, sounds, map edits, media access, chat hooks, positions on the server.
- Hot reload of a plugin's files while the server runs (re-enable reloads it; see below), a plugin registry or marketplace.
- Translations of plugin-provided strings.

## Anti-goals (a failure even if it works)

- A plugin can make the office slow, kick players or crash the server or the page. Every queue stays bounded, every Lua call has a time budget, and a misbehaving plugin is stopped and reported, not tolerated.
- Per-frame traffic: no message per display frame between iframe and page, and none on the network.
- Plugin JS able to reach the session cookie, `window.__hq`, media devices or the DOM of the page.
- Any Pokémon or other third-party game asset in the repository (AGENTS.md invariant 10). The sample creature is original, drawn in code.

## Constraints from the codebase

- The world is one goroutine per office, lock-free, fed by `post`ed events; outbound frames go through the bounded `p.out` channel (`sendShared` kicks a slow client when full, `sendCopy` drops). Hooks (`OnLeave`, `OnChat`, ...) must not block.
- WebSocket: JSON text frames, inbound frame limit 2048 bytes, per-connection rate buckets in `httpapi/ws.go`; unknown `t` is ignored.
- The roster is office-wide (`t:"p"`); positions arrive through the area of interest (`t:"w"`). Each client simulates pets locally from the owner's drawn position (`petFollow.ts`).
- The page renders on demand (ADR 0017): anything that changes the picture must set `dirty`.
- No CSP today; `secureHeaders` sets nosniff, referrer and permissions policies.
- Single office per server (`cfg.OfficeSlug`); the world starts lazily in `Server.worldFor`.

## Design

### Installation and configuration

- `HQ_PLUGINS_DIR`: directory scanned at start. Empty (default) disables the feature entirely: no routes, no admin tab content, no client work. `scripts/dev.sh` sets it to the repository's `plugins/`; the Docker image ships `plugins/` at `/app/plugins` and sets the variable (operators mount their own folder over it). Production keeps working without it.
- Each subfolder with a `plugin.json` is a plugin:

```json
{ "name": "sample-pet", "title": "Sample pet", "version": "1.0.0",
  "description": "An original creature that follows every member.",
  "server": "main.lua", "client": "client.js" }
```

  `name` must match `^[a-z][a-z0-9-]{0,31}$` and the folder name. `server` is a Lua file in the plugin folder (optional); `client` is a file inside `public/` (optional); at least one is required. An invalid manifest, a missing file or a Lua syntax error makes the plugin **broken**: listed in the admin dialog with its error, cannot be enabled. Files are read once when the plugin starts (at boot if enabled, or when enabled); editing them takes effect on disable + enable.

### Server runtime (`internal/plugin`)

- VM: [gopher-lua](https://github.com/yuin/gopher-lua) (pure Go, MIT, no cgo). Libraries opened: base (without `dofile`, `loadfile`, `load`, `loadstring`, `require`, `collectgarbage`), `string`, `table`, `math`. No `io`, `os`, `package`, `debug`, `channel`, `coroutine` (coroutine is allowed if it costs nothing to add; builder's call). `math.random` is seeded per plugin.
- **One goroutine per running plugin owns its `LState`**, mirroring the world: everything (callbacks, HTTP requests, messages) is an event in a bounded inbox (256). `update(dt)` runs at 10 Hz.
- **Time budget**: every callback runs under a context with a 50 ms deadline (`L.SetContext`). A callback over budget, a Lua stack overflow or a runtime error in `load` stops the plugin (state `crashed`, error kept for the admin dialog, logged with the plugin name). A runtime error in other callbacks is logged and counted; more than 10 errors in a minute crashes the plugin. A full inbox drops the event and counts it (players' join/leave are never dropped: they have their own slot so the plugin's view of who is online stays right; builder's call how).
- Memory: gopher-lua cannot cap heap usage. Bounded registry and call stack sizes are set; heap is a documented known limit (trusted code).
- Each office world gets its own set of running plugin instances (there is one office today).

### Lua API

Callbacks the plugin may define as globals:

| Callback | When |
| --- | --- |
| `load()` | once, when the plugin starts |
| `update(dt)` | 10 times a second, `dt` in seconds |
| `on_join(player)` | a member appears in the office (first connection, not a reconnect within the grace) |
| `on_leave(player)` | the member left (after the grace, or evicted) |
| `on_message(player, msg)` | the plugin's browser code of that player called `hq.send(msg)` |
| `unload()` | before the plugin stops (disable, server stop); best effort, same budget |

`player` is a table `{ id = <member id>, name = "...", role = "admin"|"member" }`. No positions on the server in this version.

Presence rules (settled during review):

- **Invisible is offline for plugins**, as it is for the roster and for waves: an invisible member gets no `on_join`, is not in `hq.players()` and cannot be the target of `hq.send` (the call is a no-op returning false). Switching to invisible calls `on_leave`; leaving invisible calls `on_join`. Messages from an invisible member's own browser code still reach `on_message` (they only reveal the member to the plugin, not to others), and the plugin cannot broadcast them as online. This needs the world to report status changes to and from invisible to the plugin host.
- **Members already online when a plugin starts** (enabled while people are in, restarted after a crash, server start with reconnecting players) get `on_join` right after `load()`, so plugins have one code path.

The `hq` global:

- `hq.send(player_id, msg)` and `hq.broadcast(msg)`: send a JSON-serialisable Lua table (or string, number, boolean) to that player's / every online player's copy of this plugin's browser code. Encoded size ≤ 4 KB. **Budget**: per recipient, all plugins together, at most 10 messages per second (token bucket, burst 20); over budget or over size the call raises a Lua error (so it is never silent). **A plugin never kicks a player** (settled during review): the world delivers a plugin frame only while the recipient's outbound queue is under half full; otherwise the frame is dropped, counted in a per-plugin metric and logged (rate-limited log line with plugin name and member id, no content). Plugins that need certainty resynchronise, as the sample does with `sync` on load.
- `hq.players()`: array of online players (same shape as `player`).
- `hq.kv.get(key)`, `hq.kv.set(key, value)`, `hq.kv.delete(key)`: persistent per plugin and office. Key ≤ 128 bytes, value is a string ≤ 4 KB (plugins encode with `hq.json`), at most 1000 keys per plugin; over limits raise an error. Backed by SQLite, read through an in-memory copy loaded at start, writes queued to the store worker (bounded; a full queue raises an error).
- `hq.json.encode(v)`, `hq.json.decode(s)`.
- `hq.route(method, path, fn)`: during `load()` only. `method` is GET or POST, `path` a fixed path such as `/mine` (no patterns in this version) served at `/plugins/<name>/api<path>`. `fn(req)` gets `{ player = player, body = "<string>", query = { k = v } }` and returns `status, body` where body is a string (`text/plain`) or a table (JSON). Only a signed-in member reaches a plugin route (the same `s.session(r)` check as the rest of `/api`, 401 otherwise); POST bodies ≤ 16 KB; a per-member limiter (5/s, burst 10) per plugin. The request waits for the plugin goroutine up to 1 s (503 on timeout). A disabled or crashed plugin answers 404.
- `hq.log(...)`: structured log line with the plugin name. Authors are told not to log message content (AGENTS.md invariant 9).
- `hq.now()`: seconds since the plugin started (float).

### World and protocol

- New world hook `OnJoin(officeID, userID, name, role)` beside `OnLeave`, called when a player is added (not on reattach). Both feed the plugin host non-blockingly.
- New world entry points to deliver plugin frames on the world goroutine: send to one member, broadcast to all online members. Frames are pre-encoded once and shared.
- Server → client: `{"t":"plg","pl":"<plugin>","d":<json>}`.
- Client → server: `{"t":"plg","pl":"<plugin>","d":<json>}` (keys chosen not to collide with the shared `inMsg` fields `n` and `b`) within the 2048-byte frame limit. Own rate bucket (10/s, burst 20) with strikes like the other buckets. Messages for a plugin that is not running are ignored.
- Server → client `{"t":"plgs"}`: the set of running plugins changed; the client refetches the list.
- `GET /api/plugins` (signed-in member): running plugins `[{name, title, client: "/plugins/<name>/assets/<file>" | null}]`.
- `docs/protocol.md`, `web/src/net/protocol.ts` and world tests change together.

### Assets

- `GET /plugins/<name>/assets/<path>` serves files under the plugin's `public/` folder only, for a **running** plugin (404 otherwise). No session needed: the sandboxed iframe has an opaque origin and gets no cookies, and the folder is public by name.
- Allowed extensions: `.png`, `.js`, `.json`, `.css`; ≤ 1 MB each. `..`, absolute paths, dot-files and symlinks leaving `public/` are refused. `Cache-Control: no-cache` with an ETag; `Access-Control-Allow-Origin: *` so module scripts load in the opaque-origin iframe; `X-Content-Type-Options: nosniff`.
- The Lua files are never served (they are outside `public/`).
- Vite's dev proxy forwards `/plugins` to the Go server.

### Browser host (`web/src/plugins/`)

- On `hello` (and on `plgs`) the session fetches `GET /api/plugins`, starts a host per plugin with a `client` and stops hosts no longer listed.
- **Iframe**: hidden (0×0, `aria-hidden`), `sandbox="allow-scripts"` only (opaque origin), content from `srcdoc`: the plugin SDK (a small script maintained in the web code and inlined) followed by `<script src="<client url>">` (classic or module script, both work). Handshake: the SDK posts `ready` to the parent with `"*"`; the parent checks `event.source` is that iframe and transfers one end of a `MessageChannel`. All later traffic goes through the port (messages queue until `start()`, so nothing is lost at load). A plugin whose handshake does not arrive within 10 s is stopped with a console warning.
- **Bounded traffic**: the SDK sends at most one batch of commands per JS task (microtask flush), at most 512 commands per batch, and the host accepts at most 30 batches per second per plugin; over limits the host stops that plugin on this page (iframe removed, sprites and buttons removed, console warning). The host never queues unboundedly toward the iframe either: `update` ticks are skipped while the previous one is unanswered.
- **Rendering**: one container per plugin inside `entLayer`'s depth sorting (sprites sort with avatars and pets by feet y). Coordinates are world pixels (feet point), like avatars. The host animates: `moveTo` walks at a given speed, `follow` uses `petFollow.ts` (with the gap made a parameter) against the owner's drawn position; a followed owner who is not visible hides the sprite and reseeds it when they reappear. Frame animation advances on the page's clock. The host sets `dirty` only when a plugin sprite's position or frame changes.
- **Textures**: `loadSprite` fetches the PNG in the page (same origin), slices it into frames, `nearest` scaling, cached per plugin and destroyed when the plugin stops. Limits: 32 sprites per plugin, 2048×2048 px per image, 256 live entities per plugin.
- **Buttons**: plugins declare buttons; the page renders them with React in a "Plugins" tab of the side panel, shown only while at least one button exists. Labels are plain text ≤ 40 chars, rendered escaped; the button's accessible name is its label. A click is sent to the iframe. Plugin labels are a documented exception to the i18n dictionary rule; the tab's own title goes through `i18n.ts`.
- A stopped plugin (disabled, removed from the list, over limits) loses its iframe, sprites, textures and buttons immediately.

### Browser SDK (inside the iframe)

Global `hq`; names are provisional, behaviour is not:

- `hq.onLoad(fn)`, `hq.onUpdate(fn(dt, world))` at 10 Hz with `world = { me: <id>, avatars: [{ id, name, x, y, dir, moving }] }` (visible avatars only, drawn positions), `hq.onMessage(fn(msg))` from the plugin's Lua, `hq.onButton(fn(id))`.
- `hq.send(msg)` to the plugin's Lua (encoded ≤ 1500 bytes, else throws).
- `hq.loadSprite(key, path, { frameW, frameH, anims: { name: { row, frames: [..], fps } } })`: `path` relative to the plugin's `public/`.
- `hq.spawn(id, key, { x, y, anim })`, `hq.remove(id)`.
- `hq.moveTo(id, x, y, { speed })`, `hq.follow(id, playerId, { gap })`, `hq.stop(id)`.
- `hq.setAnim(id, name)`, `hq.setFlip(id, bool)`, `hq.setVisible(id, bool)`.
- `hq.addButton(id, label)`, `hq.removeButton(id)`.

Calls are fire-and-forget commands batched to the host; errors in the plugin's own code are reported to the page console with the plugin name.

### Administration

- Migration `009_plugins.sql`: `plugins(office_id, name, enabled, updated_at, PK(office_id, name))` and `plugin_kv(office_id, plugin, key, value, PK(office_id, plugin, key))`.
- `GET /api/admin/plugins`: installed plugins `[{name, title, version, description, state: "disabled"|"running"|"crashed"|"broken", error}]`.
- `PUT /api/admin/plugins/{name}` `{enabled: bool}`: starts or stops the plugin, persists the flag, audits `plugin.enable` / `plugin.disable` with the plugin name as target, broadcasts `plgs`. Enabling a crashed plugin restarts it. A broken plugin cannot be enabled (409).
- Admin dialog: a "Plugins" tab listing installed plugins with their state, error and an enable/disable switch. Audit lines get i18n keys.
- Disabling stops the VM (calling `unload`), unregisters its routes (404), stops serving its assets and tells clients (`plgs`). Its KV data is kept.

### Sample plugin `plugins/sample-pet/`

- `plugin.json`, `main.lua`, `public/client.js`, `public/creatures.png`, and the script that paints `creatures.png` from code.
- The creature is **original**, painted with the pixel helpers in `web/src/game/art/` in the house style: four variants (colour or shape), 16×16 cells, idle and two walk frames per facing, like the built-in pets. The PNG is committed; the script makes it reproducible.
- Lua: on `on_join`, the member gets their stored variant or a random one (stored in KV) and every online client is told `{t:"set", id, v}`; on `on_leave`, `{t:"del", id}`; on `on_message` `{t:"sync"}` it replies with every online member's variant; on `{t:"reroll"}` it picks a different variant, stores it and broadcasts. Route `GET /mine` returns `{variant}`.
- JS: on load, `loadSprite`, `addButton("reroll", "Different pet")`, `send({t:"sync"})`; on `set`, spawn or update the creature and `follow` its owner on the side opposite the built-in pet's gap (a larger gap is enough); on `del`, remove it.

## Evidence (acceptance criteria)

1. With `HQ_PLUGINS_DIR` unset, nothing changes: existing suite green, `/api/plugins` returns an empty list, no iframe in the page.
2. The admin opens Admin → Plugins, sees `sample-pet` disabled, enables it through the switch; an audit row appears.
3. Two members online: each sees a sample creature following the other within ~1 s, walking the owner's trail and not glued to them (frame capture checked by eye, plus distance metrics as in the `movement` scenario).
4. Clicking "Different pet" in the Plugins tab changes the clicker's creature on both pages; after a server restart, the clicker still has that variant.
5. `GET /plugins/sample-pet/api/mine` answers the variant for a signed-in member and 401 without a session; `/plugins/sample-pet/assets/../main.lua` and `/plugins/sample-pet/assets/main.lua` are 404.
6. Disabling removes creatures and the tab from both pages without reload; routes and assets answer 404.
7. Go tests: invisible members are not announced to plugins (no `on_join`, not in `hq.players()`, `on_leave` when going invisible); `on_join` replayed for members online when a plugin starts; a flood toward a slow client never kicks it; manifest validation and broken plugins; sandbox (no `io`/`os`/`load`); an infinite loop in `update` crashes only that plugin within the budget and the world keeps ticking; error-rate crash; send budget and size raise errors; KV limits and persistence; route auth, size and timeout; enable/disable audit and live effect; world `OnJoin`/`OnLeave` delivery; `plg` rate bucket.
8. Browser: the iframe cannot read `parent.document`, cookies or `window.__hq` (scenario asserts the attempt throws); a plugin flooding commands is stopped on that page while the office keeps working; an idle page with the sample plugin still draws ~4 frames/s (render on demand kept).
9. `a11y` scenario: zero axe violations with the Plugins tab and the admin Plugins tab open.

## Documentation

- ADR `docs/decisions/0022-plugins.md` (performance, maintenance and install impact).
- `docs/plugins.md`: authoring guide (folder layout, manifest, Lua API, browser API, limits, trust model), registered in the site `NAV`.
- `docs/protocol.md`, `docs/status.md`, README status table, `deploy/README.md` (the plugins folder), `THIRD_PARTY_LICENSES.md` (gopher-lua).

## Left to the builder

- Exact Go type names and file split inside `internal/plugin`, how the plugin host reaches the world (hook wiring in `worldFor`).
- How join/leave events get their guaranteed slot in the inbox.
- SDK delivery mechanics (raw import of a plain JS file into the bundle, or equivalent) as long as it ends up in `srcdoc`.
- The creature's look, within the art style guide.
- Prometheus counters for plugin errors, dropped events and messages (nice to have).

## Part 2: plugin UI and app tokens (2026-10-17)

Asked by the user after part 1: "APIs to generate tokens and the UI for a copyable text; the Plugins screen shows each plugin's name in a button that opens a modal the plugin configures; plugins can add a button where they want, at anchor points: right panel, bottom bar, top action bar, minimap, top right, and a screen anchor; a plugin can open a modal by itself and choose its size and position." The driving use: a desktop companion (like PokeTokenBar) posts a member's state to a plugin route, which needs a per-member token the member copies from the plugin's modal.

### UI model (decided)

- **Declarative, drawn by Home Quarters in React.** The SDK reads like React (props and callbacks) but callbacks stay in the iframe: the page receives a tree with callback ids and sends events back. Plugin code never runs in the page.
- **Anchors** (`hq.ui.slot(id, anchor, props)`, `hq.ui.unslot(id)`): `topbar`, `topright`, `bottombar`, `sidebar` (an entry in the side panel's Plugins tab, labelled with the plugin's title unless given a label), `minimap` (a button over the minimap) are buttons `{ label, icon?, onClick }`; `screen` is a floating box `{ corner, dx, dy, content }` on the map (corner top-left / top-right / bottom-left / bottom-right; offsets clamped; at most 240 x 160 px; below the bars and dialogs). At most 8 slots per plugin.
- **Modal** (`hq.ui.modal(props, content)`, `hq.ui.close()`): opened whenever the plugin wants; size `small` / `medium` / `large`, place `center` / `right` (a side sheet). Presets, not pixels, so phones keep working. One plugin modal at a time on the page; Escape and the close button always work and the plugin gets `onClose`. Calling `hq.ui.modal` again while open replaces its content (update).
- **Components** (first set, enough for the token flow): `text(string, { muted })`, `button({ label, onClick, primary })`, `copy({ label, value })` (read-only field + Copy button), `image({ src, alt })` (a PNG from the plugin's `public/`, at most 128 px), `row(children)`, and `appToken()` (below). Limits: 64 nodes, depth 4, text 500 chars, labels 1-40 chars trimmed, copy values 2000 chars, 256 live callbacks.
- The part-1 `addButton` / `removeButton` API and its button list are replaced by anchors (not released yet, no compatibility needed).

### App tokens (decided: managed by Home Quarters)

- A plugin opts in with `"appTokens": true` in its manifest.
- `appToken()` renders Home Quarters' own widget: "Create token" → the token shown once in a copy field; afterwards "Replace" and "Revoke", with the creation date. One token per member, plugin and office; creating a new one replaces the old.
- HTTP (session required, plugin running with `appTokens`): `GET /api/plugins/{name}/token` → `{exists, createdAt}`; `POST` → `{token}` (once); `DELETE` → revoke. Audited as `plugin.token.create` / `plugin.token.revoke`, target the plugin name. Rate limited with the plugin route limiter.
- Storage: migration 010, `app_tokens(office_id, user_id, plugin, token_hash UNIQUE, created_at, last_used_at)`, SHA-256 of a 32-byte random token prefixed `hqp_`; removing a member deletes their tokens, and a lookup requires a current membership.
- Routes: `hq.route(method, path, fn, { token: true })` also accepts `Authorization: Bearer hqp_...` for that plugin only; `req.player` is the token's member. Without the option, a token gets 401. Tokens are never logged.

### Sample plugin, updated

- `sidebar` entry "Sample pet" → modal with the "Different pet" button and an app token section: "Use this token to change your seedling from a script: `curl -X POST -H 'Authorization: Bearer <token>' -d 2 <office>/plugins/sample-pet/api/variant`" (route `POST /variant`, `{ token: true }`, body 0-3).
- A `screen` widget at bottom-left: "Your seedling: <variant name>".

### Evidence (part 2)

10. Each anchor shows a plugin button through the real UI; clicking it runs the plugin's callback (scenario).
11. The sample's sidebar entry opens its modal; "Different pet" in the modal works; Escape closes it and the plugin is told.
12. Create token in the modal → copy field shows a `hqp_` token; `POST /plugins/sample-pet/api/variant` with it from outside the browser changes the creature on another member's page; revoke → 401; a session cookie alone on that route still works; a token on a route without `{ token: true }` → 401; a removed member's token → 401 (Go).
13. Validation (unit): node limits, unknown component, bad anchor, oversized text, blank label refused.
14. `a11y` audits the plugin modal and anchors at zero violations; frames of each anchor at 1280x720, 800x450 and 390x844 looked at.

## Part 3: TypeScript instead of Lua (2026-10-18)

The user: "go quickjs; we need a typed language, untyped languages are over; and we should ship a .d.ts for the SDK". Decided after the runtime spike (`bench/plugin-runtime`, measured: QuickJS twice as slow per call as gopher-lua but ~35 µs for a sample tick, ~0.45 MB per plugin, and a per-plugin memory cap that gopher-lua cannot give).

- **Server code is TypeScript (or JavaScript) run by QuickJS** (`modernc.org/quickjs`, pure Go). `"server": "main.ts"` is bundled by esbuild (a Go library) when the plugin starts: imports of other files inside the plugin folder are allowed, nothing outside it. Lua and gopher-lua are removed (nothing released depends on them).
- **Module shape:** the plugin exports `load`, `update(dt)`, `onJoin(player)`, `onLeave(player)`, `onMessage(player, msg)`, `unload` (all optional). The global `hq` keeps the same functions and semantics: `send`, `broadcast` (return false when the budget is spent), `players`, `kv.get/set/delete`, `route(method, path, fn, { token })` (in `load` only), `log`, `now`. JSON is native.
- **Limits:** 50 ms per call (QuickJS interrupt), 10 errors a minute, a 16 MB heap cap per plugin (out of memory stops it), the same queues and budgets. No timers, no I/O, no network: QuickJS without its std/os modules. Promise jobs run right after each call, within a budget of their own; an async throw counts as an error. After review: recursion capped at a few thousand calls (Go stack), only the known exports allowed, frames checked as valid JSON, imports checked on the files actually read, compiled code at most 256 KB with a 1 s start budget, route replies at most 1 MB, the cache keyed by file contents.
- **Browser code may be TypeScript too:** `"client": "client.ts"` (in `public/`) is compiled by the server when the plugin starts and served as JavaScript; a `.js` client still works.
- **Types:** `plugins/sdk/server.d.ts` and `plugins/sdk/client.d.ts` describe both globals; the sample plugin has a `tsconfig.json` using them. The gauntlet type-checks the sample and the e2e fixture with `tsc`, so the declarations cannot drift from the code that uses them. The server does not type-check at load (esbuild strips types); editors and `tsc` do.
- **Go 1.27** (required by modernc.org/quickjs): `server/go.mod`, the Dockerfile and CI move to it.
- **Docs:** ADR 0022 is updated in place (nothing is merged yet); the guide and the API reference move to TypeScript.

Evidence: the part 1-2 Go tests, rewritten for TypeScript, pass with `-race` (sandbox, budget, error rate, memory cap, presence, KV, routes, tokens, the sample's robustness); `tsc` passes on the sample and the fixture; the `plugins` and `a11y` scenarios pass; the whole suite is run before pushing.
