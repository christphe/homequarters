# Plugin API reference

The exact contract of a Home Quarters plugin: the manifest, the TypeScript API on the server, the TypeScript API in the browser, and the HTTP and WebSocket surface they use. For how to write and install a plugin, read the [Plugins guide](plugins.md). The design and its reasons are in decisions [0022](decisions/0022-plugins.md) and [0023](decisions/0023-plugin-ui-and-app-tokens.md).

Everything here was built and tested on 2026-10-17. Limits are enforced: breaking one has the effect listed.

## Manifest (`plugin.json`)

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | yes | `^[a-z][a-z0-9-]{0,31}$`, equal to the folder name. |
| `title` | string | no | Shown to administrators and as the default label of the plugin's `sidebar` entry. Defaults to `name`. |
| `version` | string | no | Shown to administrators. |
| `description` | string | no | One line under the title in Administration > Plugins, at most 160 characters (more goes in `longDescription`). |
| `server` | string | one of `server`/`client` | A `.ts` or `.js` file in the plugin folder, compiled with its imports when the server starts. |
| `client` | string | one of `server`/`client` | A `.ts` or `.js` file inside `public/`, compiled with its imports and served at `/plugins/<name>/client.js`. |
| `appTokens` | boolean | no | Members may create an app token for this plugin; needed for routes declared with `{ token: true }`. |
| `longDescription` | string | no | At most 2000 characters, shown by the About button of the plugin's row in Administration > Plugins; blank lines separate paragraphs. |
| `settings` | array | no | At most 16 `{ key, label, type: "number", min, max, default, help }`: whole numbers within ±1,000,000, `min <= default <= max`, key `^[a-z][a-zA-Z0-9]{0,31}$`, label 1-40 characters, `help` (optional) up to 200, shown under the field. Drawn behind the plugin's gear button in Administration > Plugins. |
| `externalHosts` | string array | no | At most 8 host names (lower case, no scheme or port, like `raw.githubusercontent.com`) the plugin's browser code may fetch from, over https. Shown to administrators in Administration > Plugins and enforced: the iframe's Content Security Policy allows its own folder and these hosts, nothing else. |

A plugin whose manifest or files are invalid is listed as `broken` with the reason. Turning it on reads it again, so fixing the files is enough.

## Server (TypeScript)

The server module is compiled by esbuild (TypeScript or JavaScript, ES2020 output, with the files it imports from the plugin's folder) and run by QuickJS through `modernc.org/quickjs` (pure Go). There is no I/O: no `require`, no file system, no network, no timers. `console.log` (and `info`, `warn`, `error`) is `hq.log`. Exports and route handlers may be `async`: the promise jobs a call starts run right after it, within its budget, and an async throw counts as an error. Nothing outside can be awaited (no network, no timers). Types: [`plugins/sdk/server.d.ts`](../plugins/sdk/server.d.ts).

### Exports

All optional; any other export stops the plugin from starting. Each call has a 50 ms budget, the top level and `load()` together 1 s.

| Export | Called |
| --- | --- |
| `load()` | Once when the plugin starts, after the module's top level ran. The only place `hq.route` works. An error here stops the plugin. |
| `update(dt)` | About every 100 ms; `dt` is the time since the last call, in seconds. |
| `onJoin(player)` | A member becomes visible-online: they joined, or came back from invisible. Replayed for every member online right after `load()`. |
| `onLeave(player)` | The member left (after the 10 s reconnect grace), was removed, or went invisible. |
| `onMessage(player, msg)` | That member's page sent `hq.send(msg)`. `msg` is the parsed JSON (`unknown`: check it). |
| `onSettings()` | An administrator changed a setting; `hq.settings()` has the new values. |
| `unload()` | Before the plugin stops (turned off, server stopping). |

`player` is `{ id: number, name: string, role: "admin" | "member" }`. A member who reconnects or renames does not trigger `onJoin` again; the new name appears in `hq.players()` and in later calls.

### `hq`

| Function | Returns | Throws |
| --- | --- | --- |
| `hq.send(id, msg)` | `true`; `false` if the member is not online or the send budget is spent | `msg` over 4 KB as JSON |
| `hq.broadcast(msg)` | `true`; `false` if the budget of any online member is spent | same |
| `hq.players()` | the visible-online members | |
| `hq.kv.get(key)` | string, or `null` | |
| `hq.kv.set(key, value)` | nothing | value not a string, key not 1-128 bytes, value over 4 KB, a 1001st key, storage queue full |
| `hq.kv.delete(key)` | nothing | storage queue full |
| `hq.route(method, path, handler, opts)` | nothing | after the plugin loaded, method not `GET`/`POST`, path not a fixed `/...` of at most 64 characters, `{ token: true }` without `appTokens`, a handler that is not a function |
| `hq.log(...parts)` | nothing | |
| `hq.now()` | seconds since the plugin started | |
| `hq.settings()` | `{ key: value }` for every declared setting: the stored value clamped to the declared range, else the default | |
| `hq.expose(name, fn)` | nothing | not in `load()`, name not `^[a-z][a-zA-Z0-9]{0,31}$`, more than 16 hooks, `fn` not a function |
| `hq.plugins.call(plugin, hook, args)` | a Promise of the hook's answer | thrown at once: in `load()`, calling itself, arguments over 4 KB or not JSON, 64 calls already waiting. The Promise rejects if the plugin is off, busy, does not expose the hook, the hook throws or answers over 4 KB, or after 2 s |

A hook is `fn(caller, args)`, maybe async, returning JSON of at most 4 KB. `caller` is `{ plugin, member }`: the calling plugin, and the member whose request, message, arrival or departure it was handling when it called (set by Home Quarters; `null` in `update()` or after an awaited answer). The hook runs on the callee's goroutine under the same time budget as any call, and its errors count against the callee.

`msg` values are sent with `JSON.stringify`: `undefined` becomes `null`, and what JSON cannot carry (functions, `NaN`) is dropped or becomes `null` as `JSON.stringify` does.

### Routes

`hq.route("GET" | "POST", "/path", handler, { token: true })` serves `/plugins/<name>/api/path`.

- `handler(req)` gets `{ player, body: string, query: { name: first value } }` and returns `{ status, body }` or nothing.
  - `status` is 200 when missing or outside 100-599.
  - A string `body` is sent as `text/plain`, any other value as `application/json`, a missing or `null` body as an empty body.
- **Who can call it:** a signed-in member, whose session cookie makes them `req.player`. With `{ token: true }`, an app holding a member's app token for this plugin (`Authorization: Bearer hqp_...`) can call it too, and `req.player` is that member. Anybody else gets 401.
- **Answers Home Quarters gives for you:**

| Status | When |
| --- | --- |
| 404 | The plugin is not running, or has no such route. |
| 401 | A token on a route without `{ token: true }`. |
| 413 | A POST body over 16 KB. |
| 429 | More than 5 requests a second per member and plugin (burst 10). |
| 503 | No answer within 1 s, or the plugin's inbox is full. |
| 500 | The handler threw. |

### Limits and what breaking them does

| Limit | Effect |
| --- | --- |
| 50 ms per call | The plugin stops (state `crashed`, error shown to administrators). |
| 16 MB of memory per plugin | The plugin stops. |
| A few thousand nested calls | A `RangeError`, counted like any error. |
| 1 s for the top level and `load()` | The plugin does not start. |
| Route replies of 1 MB | A 500, counted as an error. |
| 10 errors a minute | The 11th stops the plugin. |
| Messages to a member: 10 a second, burst 20, all plugins together | `hq.send` / `hq.broadcast` return `false`; counted, logged at most every 10 s. |
| A member's connection half backed up | The frame is dropped and counted (`hq_plugin_frames_dropped_total`); nobody is ever disconnected for plugin traffic. |
| Inbox of 256 events | Further browser messages and route calls are dropped (routes answer 503). Presence changes are never dropped: they are coalesced per member. |
| Compiled code | 256 KB per side; imports only of `.ts`, `.tsx`, `.js`, `.mjs`, `.json` files inside the plugin's folder (checked on the files actually read, after links and `package.json` fields); server code never in `public/`; at most 2000 files per plugin, `node_modules` and dot folders ignored. |

## Browser (TypeScript)


The browser code runs in a hidden iframe with `sandbox="allow-scripts"`, after the SDK, and gets one global, `hq`. It has no access to the page, its cookies, its storage, the camera or the microphone. Every call below is queued and sent to the page as one batch per task. Types: [`plugins/sdk/client.d.ts`](../plugins/sdk/client.d.ts).

### Lifecycle and messages

| Function | Meaning |
| --- | --- |
| `hq.onLoad(fn)` | `fn()` once the page connected to the plugin. Also after every reconnection of the page, because the plugin is restarted then. |
| `hq.onUpdate(fn)` | `fn(dt, world)` about every 100 ms, skipped while the previous one runs. `world = { me: id, avatars: [{ id, name, x, y, dir, moving }] }`: the avatars on screen, world pixels at the feet, `dir` 0 down, 1 left, 2 right, 3 up. |
| `hq.onMessage(fn)` | `fn(msg)` for each `hq.send` / `hq.broadcast` of your server code. |
| `hq.send(msg)` | To your server code's `onMessage`. Throws if `msg` is not JSON or over 1500 bytes. The page sends at most 8 a second for all its plugins (burst 16) and drops the rest with a console warning. |

### Sprites

| Function | Meaning |
| --- | --- |
| `hq.loadSprite(key, path, { frameW, frameH, anims })` | A PNG of `public/` (at most 2048 px a side, 4096 frames), cut into `frameW` x `frameH` cells (1-256 px). `anims = { name: { row, frames: [col, ...], fps } }` (up to 32 animations, 64 frames each, fps 0-60). |
| `hq.loadSprite(key, image, { frameW, frameH, anims })` | `image` is image data the plugin made or downloaded: a `Blob` (an image type, at most 1 MB) or an `ImageBitmap`. It reaches the page over the plugin's port; the page decodes it with the same limits as a PNG (2048 px a side, 4096 frames). An invalid one is not drawn and logs a console warning, like a missing PNG; the plugin goes on. |
| `hq.loadSprite(key, path, { frameW, frameH, from })` | With `from`, a PNG of that plugin's `public/shared/` (the path must start with `shared/`); that folder is the only part of a plugin's `public/` other plugins can draw. |
| `hq.spawn(id, key, { x, y, anim })` | Puts sprite `id` with sheet `key` at `x, y` (world px, bottom centre of the frame), standing still. Without `x, y`, a new sprite waits for `follow` or `moveTo` to place it, and an existing one keeps its place and what it does (only its sheet changes). |
| `hq.remove(id)` | Takes it away. |
| `hq.moveTo(id, x, y, { speed })` | Walks there in a straight line at `speed` px/s (1-1000, default 72); stops at the first wall. |
| `hq.follow(id, memberId, { gap, beside })` | Walks that member's trail `gap` px behind (0-200, default 36); rests `beside` px to their side (0-120, default 22); with `roam` (0-48) it potters about their feet instead, a new free spot every 5-10 s, chosen from the sprite's id and the clock so every page shows the same. If the sprite is already on the map elsewhere, it first walks back along a path around walls. Hidden while the member is off screen. |
| `hq.stop(id)` | Stands still. |
| `hq.setAnim(id, name)` | Plays that animation while standing (until it moves). |
| `hq.setFlip(id, on)`, `hq.setVisible(id, on)` | Mirrors it, shows or hides it. |
| `hq.walkTo(id, x, y, { speed })` | Walks there along a path around walls (the page's path search, bounded); somewhere it cannot reach, it stays where it is. |
| `hq.follow(id, { sprite }, { gap, beside })` | Follows another sprite of the same plugin the way it would follow a member; it waits while that sprite is gone or hidden. A sprite cannot follow itself. |
| `hq.setLabel(id, text, { owner })` | One line, 1-24 characters with no control characters, drawn above the sprite only while a mouse is over it (never on touch); `null` removes it. `owner` (a member id) adds that member's current name under it, in brackets. |
| `hq.setTint(id, colour)` | Multiplies its colours by `"#rrggbb"`; `null` removes the tint. A sheet drawn in light greys takes any colour this way. |

Automatic animations: `walk-<facing>` or `walk` while moving, `idle-<facing>` or `idle` while standing; facings `down`, `left`, `right`, `up`.

### Interface (`hq.ui`)

| Function | Meaning |
| --- | --- |
| `hq.ui.slot(id, anchor, { label, icon, pressed, onClick })` | A button at `topbar`, `topright`, `bottombar`, `sidebar` or `minimap`. `label` 1-40 characters (default: the plugin's title); `icon` a PNG of `public/` shown instead of the label (the label stays its accessible name); `pressed` marks a toggle as on. Same `id` again: redrawn. |
| `hq.ui.slot(id, "screen", { corner, dx, dy, content })` | A box on the map at `top-left`, `top-right`, `bottom-left` or `bottom-right`, `dx`/`dy` 0-200 px from it, at most 240 x 160 px, under Home Quarters' own bars and dialogs. |
| `hq.ui.unslot(id)` | Removes a button or box. |
| `hq.ui.modal({ title, size, place, onClose }, content)` | Opens the plugin's modal or redraws it. `size`: `small`, `medium` (default), `large`. `place`: `center` (default), `right`. One plugin modal at a time on a page. |
| `hq.ui.close()` | Closes it. `onClose` runs whenever it closes, whoever closed it. |

Content elements (a `content` array, at most 64 elements, nested at most 4 deep):

| Element | Meaning |
| --- | --- |
| `hq.ui.text(text, { muted })` | A paragraph, up to 500 characters. |
| `hq.ui.button({ label, onClick, primary, pressed })` | A button, label 1-40 characters. |
| `hq.ui.copy({ label, value })` | A read-only field with a Copy button, value up to 2000 characters. |
| `hq.ui.image({ src, alt })` | A PNG of `public/`, shown at most 128 px. |
| `hq.ui.row(children)` | Its children side by side. |
| `hq.ui.appToken()` | Home Quarters' token widget for this plugin (needs `appTokens`). |
| `hq.ui.sprite({ src, frame, scale, tint, alt })` | One cell `[x, y, w, h]` (w and h 1-128) of a PNG of `public/` (`src`), or of a sheet the plugin loaded (`sheet`: its key, image data included; one of the two), scaled 1-6 (default 2), tinted by `"#rrggbb"` if given; `alt` up to 40 characters. `hq.ui.button` accepts the same `sprite` (without `alt`), drawn before its label. |
| `hq.ui.color({ label, value, onChange })` | A colour picker; `value` is `"#rrggbb"`. `onChange(colour)` gets the colour (lower case) while it is being chosen, at most every 250 ms, and the final one at once. `hideLabel: true` keeps the label for screen readers only (also on `field`). |
| `hq.ui.field({ label, value, maxLength, placeholder, onChange })` | One line of text; `maxLength` 1-200 (default 200), `placeholder` up to 40 characters. `onChange(text)` runs on Enter or when the field loses focus, only if it changed. |
| `hq.ui.number({ label, value, min, max, onChange })` | A whole number, `min` <= `value` <= `max` (integers within ±1,000,000). `onChange(value)` runs on Enter or when the field loses focus, clamped to the range, and only if it changed. |

At most 8 slots per plugin and 256 live callbacks; texts are plain text.

### Page limits

A plugin breaking one of these is stopped on that page only (iframe, sprites and interface removed, a console warning). It starts again on the next reconnection or plugin change.

| Limit | Value |
| --- | --- |
| Commands per batch | 512 |
| Batches per second | 30 |
| Sprite sheets | 32 |
| Sprites | 256 |
| Slots | 8 |
| Start (handshake) | 10 s |

An invalid command (an unknown operation, a wrong type, a value out of range, a path outside `public/`) stops the plugin the same way, with the reason in the console.

## HTTP

| Endpoint | Who | Answer |
| --- | --- | --- |
| `GET /api/plugins` | member | `[{ name, title, client }]`, the running plugins (`client`: URL of the browser code or `null`). |
| `GET /api/admin/plugins` | admin | `[{ name, title, version, description, state, error }]`, `state` = `disabled`, `running`, `crashed`, `broken`. |
| `PUT /api/admin/plugins/{name}` | admin | `{ enabled }` → `{ state }`; 404 unknown, 409 broken or failing to start. Audited. |
| `PUT /api/admin/plugins/{name}/settings` | admin | `{ key, value }`: one declared setting for the office, checked against the manifest (400 otherwise), stored, audited (`plugin.settings`, `key=value`), passed to the running plugin (`onSettings`). |
| `GET, POST, DELETE /api/plugins/{name}/token` | member | App token of a running plugin with `appTokens`: `{ exists, createdAt }`, `{ token }` (once; replaces the old one), revoke. Audited (without the token). |
| `GET, POST /plugins/{name}/api/{path}` | member, or app token on `{ token: true }` routes | The plugin's routes (see Routes). |
| `GET /plugins/{name}/assets/{path}` | anybody | A file of the running plugin's `public/` (png, js, json, css, at most 1 MB). Never the server code. |
| `GET /plugins/{name}/client.js` | anybody | The running plugin's compiled browser code. |

## WebSocket

| Message | Direction | Meaning |
| --- | --- | --- |
| `{"t":"plg","pl":<name>,"d":<json>}` | page → server | `hq.send`: at most 1500 bytes of `d`, 10 a second (burst 20) per connection. |
| `{"t":"plg","pl":<name>,"d":<json>}` | server → page | `hq.send` / `hq.broadcast` of the server code; never to invisible members. |
| `{"t":"plgs"}` | server → page | The running plugins changed: fetch `GET /api/plugins` again. |

See [WebSocket protocol](protocol.md) for the rest of the protocol.
