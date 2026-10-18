# Plugins

A plugin adds a small feature to an office without changing Home Quarters. It is written in **TypeScript** (plain JavaScript works too): server code run by Home Quarters, browser code run in the page, or both. The operator installs it as a folder on the server, and an administrator turns it on from the admin dialog. The sample plugin, [`plugins/sample-pet`](../plugins/sample-pet), gives every member a seedling that follows them. From its modal (side panel > Plugins > Sample pet) a member shows or hides theirs and picks its colour, and a button in the top bar lets it wander or calls it back. This page covers everything it uses, plus the parts it does not need (more anchors, app tokens).

Plugins are **trusted code**. Only install plugins you have read: there is no upload and no marketplace. The limits below keep a buggy plugin from slowing the office down, but a plugin's server code still runs inside the server process. Read [decision 0022](decisions/0022-plugins.md) for the reasoning. Every function, limit and endpoint is listed in the [Plugin API reference](plugin-api.md).

## Installing

1. Set `HQ_PLUGINS_DIR` to a folder. If it is empty (the default), plugins are off. `scripts/dev.sh` points it at the repository's `plugins/`. The Docker image ships `plugins/` at `/app/plugins`; mount your own folder there to replace them.
2. Put each plugin in its own subfolder, named after the plugin.
3. Restart the server. It reads and compiles the plugins when it starts.
4. Go to Administration > Plugins and turn the plugin on. A new plugin is always off until you do. Turning a plugin on or off takes effect at once for everybody online and is recorded in the activity log.

To pick up edits to a plugin's files, turn it off and on again: it is compiled again only if a file's content changed. A plugin that cannot run (an invalid manifest, a missing file, a compile error, an import from outside its folder, an unknown export) is listed with its error; fix the file and turn it on, it is read again then. A plugin that stops after an error is listed as *Stopped after an error*; turning it on again restarts it.

## Layout

~~~text
sample-pet/
  plugin.json        the manifest
  main.ts            server code (optional)
  tsconfig.json      types for main.ts (../sdk/server.d.ts)
  public/            served to browsers, and nothing else is
    client.ts        browser code (optional)
    messages.ts      message types shared by both sides
    tsconfig.json    types for the browser code (../../sdk/client.d.ts)
    creatures.png
~~~

~~~json
{ "name": "sample-pet", "title": "Sample pet", "version": "1.0.0",
  "description": "What it does, shown to administrators.",
  "server": "main.ts", "client": "client.ts",
  "appTokens": false }
~~~

`name` must match `^[a-z][a-z0-9-]{0,31}$` and the folder name. `appTokens` (optional) lets members create a token for this plugin; see [App tokens](#app-tokens). `server` is a `.ts` or `.js` file in the plugin folder; `client` is a `.ts` or `.js` file inside `public/`. A plugin needs at least one of the two.

Both are compiled by the server with [esbuild](https://esbuild.github.io/) (built in, nothing to install), together with the files they import. Imports must be relative paths to `.ts`, `.tsx`, `.js`, `.mjs` or `.json` files inside the plugin's folder (inside `public/` for the browser code), wherever links or `package.json` fields point: no npm packages, nothing outside. The server code must not sit in `public/`. The compiled code of each side is at most 256 KB, and a plugin folder at most 2000 files (`node_modules` and dot folders are ignored).

**Types.** The server only strips the types; it does not check them. Your editor and `tsc` do: copy [`plugins/sdk`](../plugins/sdk) next to your plugin (as in the repository) and keep the two `tsconfig.json` files of the sample. `server.d.ts` and `client.d.ts` describe everything below. The repository's checks run `tsc` on the sample, so the declarations always match what Home Quarters does.

Only `public/` is served, at `/plugins/<name>/assets/<path>`, and only while the plugin runs. Allowed types are `.png`, `.js`, `.json` and `.css`, at most 1 MB each. Hidden files, `..` and symlinks that leave the folder are refused. These files are public, with no session needed, because the plugin's sandboxed iframe sends no cookie. Never put secrets there. The browser code is served compiled, at `/plugins/<name>/client.js`; the server code is never served.

## Server side

The server code runs in [QuickJS](https://bellard.org/quickjs/) (through `modernc.org/quickjs`, pure Go), modern JavaScript (ES2023) with no I/O: no file system, no network, no timers, no `require`. `console.log` writes to the server log. Exports and route handlers may be `async`: the promise jobs a call starts run right after it, within the same 50 ms budget. Nothing outside the plugin can be awaited (there is no network or timer), so `await` only orders your own code.

Export any of these functions from the server module, and nothing else: an unknown export (`on_join` for `onJoin`) stops the plugin from starting, rather than never being called.

| Export | When |
| --- | --- |
| `load()` | Once, when the plugin starts. Declare routes here. |
| `update(dt)` | About 10 times a second. `dt` is in seconds. |
| `onJoin(player)` | A member appears in the office. It is also called for everybody already online right after `load()`, so there is one code path. What you send them here reaches their browser code even if their page has not started your plugin yet (it waits there). |
| `onLeave(player)` | The member left (after a 10 s reconnect grace) or was removed. |
| `onMessage(player, msg)` | That member's copy of your browser code called `hq.send(msg)`. `msg` is `unknown`: it comes from a browser, check it. |
| `unload()` | Before the plugin stops (turned off, server stopping). |

`player` is `{ id, name, role }` (`HQ.Player`), `role` being `"admin"` or `"member"`.

**Invisible members are offline to plugins**, just as they are offline in the people list. They get no `onJoin`, are not in `hq.players()`, and cannot be sent to. Going invisible calls `onLeave` and coming back calls `onJoin`. Their own browser code can still send messages.

The global `hq`:

| Function | What it does |
| --- | --- |
| `hq.send(id, msg)` | Sends JSON to that member's browser code. Returns `true`, or `false` if they are not online or the send budget is spent (see Limits). |
| `hq.broadcast(msg)` | Sends to every online member; `false` when the budget is spent. |
| `hq.players()` | The online members. |
| `hq.kv.get(key)`, `hq.kv.set(key, value)`, `hq.kv.delete(key)` | Persistent strings, per plugin and office. Keys are 1-128 bytes, values at most 4 KB, at most 1000 keys. Use `JSON.stringify` for objects. `get` returns `null` for a missing key. |
| `hq.route(method, path, handler, opts)` | While the plugin loads (its top level or `load()`). Serves `GET` or `POST` at `/plugins/<name>/api<path>` (a fixed path such as `/state`). `handler(req)` gets `{ player, body, query }` and returns `{ status, body }` (both optional): a string body is sent as text, anything else as JSON. With `opts = { token: true }` (and `appTokens` in the manifest), a member's app token also opens it. |
| `hq.log(...)` | One log line tagged with the plugin name (`console.log` too). |
| `hq.now()` | Seconds since the plugin started. |

Only signed-in members reach a route, or an app with a member's token on a `{ token: true }` route (401 otherwise); either way `req.player` is that member. POST bodies are at most 16 KB, each member can make 5 requests a second per plugin (burst 10), and a route that does not answer within 1 s gets a 503.

Do not log message contents or personal data (see the privacy rules in [Privacy and security](privacy-and-security.md)).

Two habits the sample shows, worth copying:

- **Collect changes and broadcast them in `update`**, once per tick, instead of broadcasting from every `onJoin`. A server restart brings the whole office back within a second, and per-join broadcasts would spend everybody's send budget. If a broadcast returns `false`, keep the changes and try again on the next update.
- **Check what browsers send before using it** (`if (typeof m !== "object" || m === null) return;`), and throttle anything a member can repeat. Messages come from members' pages, and every thrown error counts toward the 10-a-minute limit that stops the plugin.

Type your messages once for both sides, as the sample does in `public/messages.ts`: the server imports it as `./public/messages`, the browser code as `./messages`. It holds types only, so nothing of it runs.

### Limits

| Limit | Value | When it is broken |
| --- | --- | --- |
| Time per call | 50 ms | The plugin stops. |
| Starting | 1 s for the top level and `load()` | The plugin does not start. |
| Memory | 16 MB per plugin | The plugin stops ("went over the 16 MB memory cap"). |
| Recursion | a few thousand nested calls | A `RangeError`, counted like any error. |
| Route reply | 1 MB | A 500, counted as an error. |
| Runtime errors | 10 a minute | The 11th error stops the plugin. Each error is logged and says where it happened (`in update: TypeError: ...`). |
| Messages to a member | 10 a second, burst 20, counted over all plugins together; 4 KB each | Over the budget, `hq.send` and `hq.broadcast` return `false` and the message is dropped (counted, logged at most every 10 s). Over 4 KB, they throw. |
| Pending events | 256 | Further messages from browsers are dropped and counted. |
| Delivery | A message is dropped (and counted in `hq_plugin_frames_dropped_total`) rather than queued when the member's connection is already half backed up. | A plugin never gets anybody disconnected. If you need certainty, resynchronise, as the sample does with `sync`. |

## Browser side

Your `client` code runs in a hidden iframe with `sandbox="allow-scripts"`. That gives it an opaque origin: it cannot reach the page, its cookies or its storage, the camera or the microphone. It gets one global, `hq`. Every call is a command that the page validates and carries out. The page draws and animates; your code only says what to show.

| Function | What it does |
| --- | --- |
| `hq.onLoad(fn)` | Your code is ready. Load sprites and put your buttons here. |
| `hq.onUpdate(fn(dt, world))` | About 10 times a second. `world = { me, avatars: [{ id, name, x, y, dir, moving }] }` lists the avatars on screen, in world pixels at the feet. `dir` is 0 down, 1 left, 2 right, 3 up. |
| `hq.onMessage(fn(msg))` | A message from your server code. |
| `hq.send(msg)` | Sends JSON, at most 1500 bytes, to your server code's `onMessage`. The page sends at most 8 messages a second for all its plugins together (burst 16), under the server's own limit; the rest are dropped with a console warning, so a plugin never gets its member disconnected. |
| `hq.loadSprite(key, path, { frameW, frameH, anims })` | A PNG sheet from `public/` (at most 2048 px a side and 4096 frames), cut into frames. `anims = { name: { row, frames: [..], fps } }`. |
| `hq.spawn(id, key, { x, y, anim })` and `hq.remove(id)` | Put a sprite in the world, anchored at the bottom centre of its frame, or take it away. Spawning an existing id replaces it. |
| `hq.moveTo(id, x, y, { speed })` | Walk there in a straight line (px/s, default 72). |
| `hq.follow(id, playerId, { gap })` | Walk that member's trail, `gap` px behind (default 36), with the built-in pets' following. When the member stops, the sprite sits 22 px to their side, away from their own pet. It hides while the member is off screen. |
| `hq.stop(id)` | Stand still. |
| `hq.setAnim(id, name)`, `hq.setFlip(id, on)`, `hq.setVisible(id, on)` | Play an animation while standing, mirror the sprite, show or hide it. |

While a sprite moves (`moveTo`, `follow`), the page plays the animation named `walk-<facing>` (or `walk`). While it stands, it plays the one set with `setAnim`, else `idle-<facing>` (or `idle`). Facings are `down`, `left`, `right` and `up`.

Sprites sort with avatars and pets by their feet. The page redraws only when one of your sprites moves or changes frame. Calls made in the same callback travel to the page as one batch. `moveTo` stops at the first wall on its way.

### Interface: buttons, boxes and a modal

Your code describes what to show and Home Quarters draws it, in its own style, with keyboard focus, Escape and accessible names. Callbacks stay in your iframe: you write `onClick: () => ...` and the page sends the click back.

~~~js
hq.ui.slot("config", "sidebar", { onClick: openSettings });             // an entry in the side panel's Plugins tab
hq.ui.slot("call", "topbar", { label: "Let wander", onClick: toggle });  // a button in the top bar

function openSettings() {
  hq.ui.modal({ title: "Sample pet", size: "small", onClose: () => {} }, [
    hq.ui.text("Colour", { muted: true }),
    hq.ui.row(["Meadow", "Frost"].map((label, v) => hq.ui.button({ label, pressed: v === mine, onClick: () => hq.send({ t: "variant", v }) }))),
  ]);
}
~~~

| Function | What it does |
| --- | --- |
| `hq.ui.slot(id, anchor, { label, icon, pressed, onClick })` | A button at an anchor: `topbar` (the action bar at the top), `topright` (next to the status), `bottombar` (next to the microphone and camera), `sidebar` (an entry in the side panel's Plugins tab, labelled with your plugin's title unless you give a label) or `minimap` (over the minimap). `icon` is a PNG of your `public/` folder, shown instead of the label (the label stays its accessible name). `pressed` shows a toggle as on. Calling it again with the same id redraws the button. |
| `hq.ui.slot(id, "screen", { corner, dx, dy, content })` | A small box on the map: `corner` is `top-left`, `top-right`, `bottom-left` or `bottom-right`, `dx`/`dy` the distance from it (0 to 200 px), at most 240 x 160 px. It sits under Home Quarters' own bars and dialogs, which may cover it. |
| `hq.ui.unslot(id)` | Removes a button or box. |
| `hq.ui.modal({ title, size, place, onClose }, content)` | Opens your modal, or redraws it with new content if it is open. `size` is `small`, `medium` or `large`; `place` is `center` or `right` (a side sheet). One plugin modal at a time on the page: opening yours closes another plugin's. |
| `hq.ui.close()` | Closes your modal. The person can always close it too (Escape, Close, a click outside), and `onClose` tells you. |
| `hq.ui.text(text, { muted })` | A paragraph. |
| `hq.ui.button({ label, onClick, primary, pressed })` | A button; `pressed` marks a chosen option or a toggle that is on. |
| `hq.ui.copy({ label, value })` | A read-only field with a Copy button. |
| `hq.ui.image({ src, alt })` | A PNG of your `public/` folder, at most 128 px. |
| `hq.ui.row(children)` | Puts its children side by side. |
| `hq.ui.appToken()` | Home Quarters' own token widget for this plugin (below). |

Sizes and positions are presets on purpose: the office also runs on phones, and a modal placed in pixels would fall off a small screen. Many labelled buttons in the top bar crowd a phone's screen: prefer an icon there.

### App tokens

An app on a member's computer (a desktop companion, a script) can act for that member with one plugin:

1. The manifest says `"appTokens": true`, and the route the app calls is declared with `hq.route("POST", "/state", handler, { token: true })`.
2. Put `hq.ui.appToken()` in your modal. Home Quarters draws "Create token", shows the new token once in a copy field, then offers "Replace token" and "Revoke". Your code never sees the token.
3. The app sends `Authorization: Bearer <token>` to `/plugins/<name>/api/state`. `req.player` is the member who created the token.

One token per member and plugin; creating a new one stops the old. Tokens are stored hashed, only open that plugin's `{ token: true }` routes, stop working when the member is removed, and their creation and revocation are in the activity log. A token on a route without `{ token: true }` gets 401.

### Limits on the page

Each limit applies to one page. A plugin that breaks one is stopped **on that page only**: its iframe, sprites, buttons, boxes and modal go away, a warning is written in the browser console, and the office keeps working.

| Limit | Value |
| --- | --- |
| Commands per batch | 512 |
| Batches per second | 30 |
| Sprite sheets | 32 |
| Sprites alive at once | 256 |
| Buttons and boxes (slots) | 8 |
| Interface elements in one modal or box | 64, nested at most 4 deep; text 500 characters, labels 1 to 40, copy values 2000 |
| Live callbacks | 256 |
| Time to start | 10 s |

Updates are skipped while your code has not finished the previous one, so a slow plugin does not pile them up. When the page reconnects (a network drop, a server restart), every plugin restarts there, so your browser code can ask its server code for the current state.

Labels and texts come from your plugin and are shown as they are (plain text): they do not go through Home Quarters' translation dictionary.

## The protocol underneath

Messages ride the game WebSocket as `{"t":"plg","pl":<plugin>,"d":<json>}` in both directions. `{"t":"plgs"}` tells pages that the set of running plugins changed. See [WebSocket protocol](protocol.md) for the endpoints and limits.
