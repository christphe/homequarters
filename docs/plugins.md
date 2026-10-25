# Plugins

A plugin adds a small feature to an office without changing Home Quarters. It is written in **TypeScript** (plain JavaScript works too): server code run by Home Quarters, browser code run in the page, or both. The operator installs it as a folder on the server, and an administrator turns it on from the admin dialog. The plugin bundled with Home Quarters, [`hq-pets`](../plugins/bundled/hq-pets), is the sample to read. Members add pets that follow them, on top of the pet of their avatar: any of the built-in kinds or a seedling, several of one kind if they like, each in its own colour. From its modal (side panel > Plugins > Pets) a member adds, names, recolours and removes theirs, each shown as a preview in its colour. An administrator sets how many a member may have (3 by default) behind the plugin's gear button in Administration > Plugins. A button in the top bar lets them wander (Let pets wander) or calls them back (Call pets). While they wander, each pet has a mood that changes about every 5 minutes: it explores the office, potters about where it was left, stays close to its owner, or goes along with another wandering pet (it explores when there is none). The mouse over a wandering pet shows its name and its owner's. The second bundled plugin, [`hq-chess`](../plugins/bundled/hq-chess), puts a chessboard object on the map (an administrator places it, on a table for instance). X opens a window with the board: take the White or Black seat, and anybody else with the window open watches. A seat is kept until a reset, and a player whose window is open is present and gets a badge above their head. Moves are made by drag, click or keyboard, with no chess rules checked; captured pieces go to a reserve and promotion is free; each board's game is saved. It uses map objects, a view and `hq.attach`. This page covers everything these plugins use, plus the parts they do not need (more anchors, app tokens).

Plugins are **trusted code**. Only install plugins you have read: there is no upload and no marketplace. The limits below keep a buggy plugin from slowing the office down, but a plugin's server code still runs inside the server process. Read [decision 0022](decisions/0022-plugins.md) for the reasoning. Every function, limit and endpoint is listed in the [Plugin API reference](plugin-api.md).

## Installing

1. Set `HQ_PLUGINS_DIR` to a folder. If it is empty (the default), plugins are off. The Docker image sets it to `/app/plugins`; `scripts/dev.sh` points it at the repository's `plugins/`.
2. That folder holds two optional subfolders, each holding plugin folders named after their plugin:
   - `bundled/` ships with Home Quarters. The image puts the repository's `plugins/bundled/` at `/app/plugins/bundled`.
   - `installed/` is yours. Put your plugins in `/app/plugins/installed`, typically as a volume mounted there (read-only is fine: nothing is ever written in a plugin folder; compiled code is kept in memory). The image's `bundled/` stays visible next to it.

   Either may be missing or empty. With neither, plugins are off.
3. Restart the server. It reads and compiles the plugins when it starts.
4. Go to Administration > Plugins and turn the plugin on. A new plugin is always off until you do. Turning a plugin on or off takes effect at once for everybody online and is recorded in the activity log.

**Names.** The `hq-` prefix is reserved: a bundled plugin's name must start with `hq-`, and an installed plugin's name must not. So a later version of Home Quarters can add bundled plugins without ever taking the name of one you installed. The rule applies to both the folder and the manifest's `name`, in lower case. A plugin that breaks it is listed in Administration > Plugins as *Cannot run* with the rule it breaks, and never runs or serves anything. Two plugins claiming one name on the same side are both refused the same way. Every row shows where its plugin comes from, *Bundled* or *Installed*.

To pick up edits to a plugin's files, turn it off and on again: it is compiled again only if a file's content changed. A plugin that cannot run (an invalid manifest, a missing file, a compile error, an import from outside its folder, an unknown export) is listed with its error; fix the file and turn it on, it is read again then. A plugin refused for its name needs its folder renamed or moved, and a restart. A plugin that stops after an error is listed as *Stopped after an error*; turning it on again restarts it.

## Layout

~~~text
<HQ_PLUGINS_DIR>/
  bundled/                 shipped with Home Quarters: hq-* names only
    hq-pets/
  installed/               the operator's: never hq-*
    my-plugin/
      plugin.json          the manifest
      main.ts              server code (optional)
      tsconfig.json        types for main.ts (the SDK's server.d.ts)
      public/              served to browsers, and nothing else is
        client.ts          browser code (optional)
        board.ts           a view, drawn inside a modal (optional)
        messages.ts        message types shared by both sides
        tsconfig.json      types for the browser code (the SDK's client.d.ts)
        sprites.png
~~~

~~~json
{ "name": "my-plugin", "title": "My plugin", "version": "1.0.0",
  "description": "One line for administrators, at most 160 characters.",
  "server": "main.ts", "client": "client.ts",
  "appTokens": false,
  "objects": [{ "kind": "board", "label": "Board", "size": [1, 1], "sprite": "board.png", "frame": [0, 0, 16, 16] }],
  "views": { "board": "board.ts" } }
~~~

`name` must match `^[a-z][a-z0-9-]{0,31}$` and the folder name, and follow the prefix rule above. `appTokens` (optional) lets members create a token for this plugin; see [App tokens](#app-tokens). `server` is a `.ts` or `.js` file in the plugin folder; `client` is a `.ts` or `.js` file inside `public/`. A plugin needs at least one of the two. `objects` and `views` (both optional) are explained in [Objects on the map](#objects-on-the-map) and [Views](#views).

Both are compiled by the server with [esbuild](https://esbuild.github.io/) (built in, nothing to install), together with the files they import. Imports must be relative paths to `.ts`, `.tsx`, `.js`, `.mjs` or `.json` files inside the plugin's folder (inside `public/` for the browser code), wherever links or `package.json` fields point: no npm packages, nothing outside. The server code must not sit in `public/`. The compiled code of each side is at most 256 KB, and a plugin folder at most 2000 files (`node_modules` and dot folders are ignored).

**Types.** The server only strips the types; it does not check them. For the browser code, put `"DOM"` in `lib` (`"lib": ["ES2020", "DOM"]`): the iframe is a page, and `console`, `fetch`, `OffscreenCanvas` or `createImageBitmap` are then typed. Your editor and `tsc` do: copy [`plugins/sdk`](../plugins/sdk) somewhere near your plugin and point the two `tsconfig.json` files of the sample at it. `server.d.ts`, `client.d.ts` and `view.d.ts` (for views) describe everything below. The repository's checks run `tsc` on the sample, so the declarations always match what Home Quarters does.

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
| `onUse(player, { kind, x, y })` | The member pressed X next to one of your [map objects](#objects-on-the-map). `x`, `y` is the object's top-left tile, which tells two objects of one kind apart. Home Quarters sends nothing to the browser: answer with `hq.send`. |
| `onSettings()` | An administrator changed one of your settings (below); read them again with `hq.settings()`. |
| `onPlugins()` | Another plugin started or stopped (turned on or off, or crashed); ask which with `hq.plugins.running(name)`. |
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
| `hq.settings()` | The office's settings of your plugin, `{ key: value }`, defaults included (see Settings). |

Only signed-in members reach a route, or an app with a member's token on a `{ token: true }` route (401 otherwise); either way `req.player` is that member. POST bodies are at most 16 KB, each member can make 5 requests a second per plugin (burst 10), and a route that does not answer within 1 s gets a 503.

Do not log message contents or personal data (see the privacy rules in [Privacy and security](privacy-and-security.md)).

Two habits the sample shows, worth copying:

- **Collect changes and broadcast them in `update`**, once per tick, instead of broadcasting from every `onJoin`. A server restart brings the whole office back within a second, and per-join broadcasts would spend everybody's send budget. If a broadcast returns `false`, keep the changes and try again on the next update. When the changes may not fit in one 4 KB message (a whole office's pets), send a piece per update, as the sample does.
- **Decide office settings on the server.** The sample shows its administrator setting only to administrators, but it is the server code that refuses the change from anybody else (`player.role`).
- **Check what browsers send before using it** (`if (typeof m !== "object" || m === null) return;`), and throttle anything a member can repeat. Messages come from members' pages, and every thrown error counts toward the 10-a-minute limit that stops the plugin.

Type your messages once for both sides, as the sample does in `public/messages.ts`: the server imports it as `./public/messages`, the browser code as `./messages`. Keep it to types and small constants (the sample's list of kinds): both sides bundle it.

### Settings

A plugin can declare settings an administrator makes for the office. Home Quarters draws them behind the plugin's gear button in Administration > Plugins, checks each value against the declaration, stores it, records the change in the activity log and calls your `onSettings()`. Only whole numbers for now:

~~~json
"settings": [{ "key": "limit", "label": "Pets per member", "type": "number", "min": 0, "max": 8, "default": 3 }]
~~~

Keys match `^[a-z][a-zA-Z0-9]{0,31}$`, labels are 1-40 characters, at most 16 settings; an optional `help` (up to 200 characters) shows under the field. Explanations that do not fit the one-line `description` go in `longDescription`, behind the plugin's About button. A stored value outside a newer version's range is clamped. Settings that only concern one member belong in your own modal instead.

### Hooks between plugins

A plugin may offer functions to other plugins, and only those: `hq.expose(name, fn)` in `load()`. Another plugin calls them with `await hq.plugins.call(plugin, name, args)`:

~~~ts
// in hq-pets
hq.expose("setPet", (caller, args) => { /* caller.plugin, caller.member */ return { ok: true }; });

// in another plugin, in a route an app calls with a member's token
const r = await hq.plugins.call("hq-pets", "setPet", { id: "current", sheet: "shared/critter.png", cell: [24, 24], name: "Bramble" });
~~~

`caller.plugin` is the calling plugin, and `caller.member` the member whose request, message, arrival or departure it was handling when it called, set by Home Quarters, never by the caller (`null` for a call made in `update()` or after an awaited answer). So a hook can act for that member only: no plugin can give someone else a pet. Arguments and answers are JSON of at most 4 KB; a call fails if the plugin is off, does not expose that hook, throws or takes more than 2 s. A plugin has at most 16 hooks and 64 calls waiting. `hq.plugins.running(name)` says whether a plugin runs in the office now, and `onPlugins()` runs when that changes for any of them.

**Images for other plugins.** Files under `public/shared/` can also be drawn by other plugins' pages: `hq.loadSprite(key, "shared/critter.png", { frameW, frameH, from: "critters" })`. The rest of `public/` is the plugin's own.

**The pets plugin's hooks.** `setPet(caller, { id, sheet, cell, name })` puts (or, with the same `id`, replaces) a pet drawn from the caller's `shared/` sheet with `caller.member`: 4 rows (down, left, right, up) of 3 cells (idle, step A, step B), `cell` being `[w, h]`, 8 to 64 px. It then follows, wanders with the moods, comes back on Call pets and shows its name on hover, like the member's own pets, but it does not count in the office's limit and is not in the Pets modal: the plugin that put it manages it. `removePet(caller, { id })` takes it away. When the plugin that put it stops (turned off or crashed), hq-pets takes its pets away and gives their places back; a member who was away loses them on arrival. Put them again with `setPet` in `onJoin`, which runs for everybody online right after your plugin starts. At most 4 such pets per member, all plugins together. For a creature your plugin cannot ship as a PNG, give `setPet` `metadata` (JSON, at most 256 bytes) instead of `sheet` and `cell`: on every page hq-pets asks your browser code for the sheet, which it draws in `hq.provideSheet(fn)` from that metadata (see the guide, and the suite's test plugin [`drawn-pet`](../e2e/fixtures/plugins/installed/drawn-pet)). Everything a plugin author needs (the sheet format, the answers, a complete example) is in the [hq-pets developer guide](../plugins/bundled/hq-pets/docs/README.md). The suite's test plugin [`critters`](../e2e/fixtures/plugins/installed/critters) does it from an app token route.

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

## Objects on the map

A plugin can ship objects an administrator places in the map editor, like the built-in props: a chessboard, a notice board, a jukebox. The manifest declares them:

~~~json
"objects": [{ "kind": "chessboard", "label": "Chessboard", "size": [1, 1], "sprite": "chessboard.png", "frame": [0, 0, 16, 16] }]
~~~

`kind` matches `^[a-z][a-z0-9-]{0,31}$` and is unique in the plugin, with at most 8 objects. `label` (1-40 characters) names it in the editor. `size` is `[w, h]` in tiles, 1-4 each way. `sprite` is a PNG of `public/` that must exist; `frame` (optional, `[x, y, w, h]` with `w` and `h` 1-128, `x` and `y` not negative) picks one cell of it, the whole image by default. The picture is drawn anchored at the bottom-left of the object's tiles, so it may rise above them (a tall object). A manifest that breaks one of these rules makes the plugin *Cannot run*, with the rule in Administration > Plugins.

Two choices per object, independent of each other:

- **Who draws it.** With a `sprite`, the page draws it. Without one (no `sprite`, or `"sprite": null`), the page draws nothing and your browser code draws it, as for pets: `hq.spawn` with any sheet, a PNG or image data drawn in code, placed from `onObjectInit`. X, the hint, the reach and the editor work the same either way; in the editor such an object shows as a labelled box of its size.
- **Whether it gets updates.** With `"dynamic": true`, `hq.onObjectUpdate(fn(dt, obj))` runs for it in the update tick (about 10 a second, in the same message as `onUpdate`). Without it, it gets only init and destroy. At most 64 dynamic objects of one plugin get updates (the first in map order).

Every object, dynamic or not, gets `hq.onObjectInit(obj)` when your browser code starts on a page (one call per object already placed) and when one is added to the map, and `hq.onObjectDestroy(obj)` when it leaves the map (removed or moved in the editor, or its kind is no longer declared). `obj` is `{ kind, x, y, w, h, px, py }`: tiles, plus the top-left corner in world pixels. A moved or resized object is a destroy then an init. When the plugin stops there is no destroy: its sprites go anyway, and when it is turned on again it gets an init for each object still placed.

Register `hq.onObjectInit`, `onObjectDestroy` and `onObjectUpdate` at the top level of your browser code or synchronously in `onLoad`: inits that already ran are not replayed to a handler registered later. On an administrator's own page, unsaved editor drafts already count as map changes for that page's callbacks; other pages see a change once the map is saved.

~~~json
"objects": [{ "kind": "orb", "label": "Orb", "size": [1, 1], "dynamic": true }]
~~~

~~~ts
hq.onObjectInit((o) => hq.spawn(`orb@${o.x},${o.y}`, "orb", { x: o.px + o.w * 8, y: o.py + o.h * 16 }));
hq.onObjectDestroy((o) => hq.remove(`orb@${o.x},${o.y}`));
hq.onObjectUpdate((dt, o) => { /* animate it */ });
~~~

On the map, a placed object is a prop of type `<plugin>/<kind>` (`hq-chess/chessboard`) with its `w` and `h` (1-4), no `Data` and no `To`. It is never solid, so it can stand on a table, which blocks on its own. The map stays valid when the plugin is uninstalled. Pages draw the objects of running plugins only: with the plugin off, they are not drawn and nobody can use them. The editor's palette lists the objects of running plugins under the plugin's title; those of a plugin that is off show as a dashed placeholder, so an administrator can still delete them, and those the plugin draws itself as a labelled box.

When a member presses X next to one, with the same reach and area rules as for the built-in objects, your `onUse(player, { kind, x, y })` runs. It is a normal call: 50 ms, errors counted. A member can trigger at most 4 uses a second (burst 8); the rest are dropped silently. An invisible member triggers nothing, like everything else invisible members do. A kind your manifest does not declare, or a plugin that is off, gets no call.

## Views

A view is a small page of your own inside a plugin modal: a board to draw, an editor, anything the interface elements cannot do. Declare it in the manifest and show it with `hq.ui.view`:

~~~json
"views": { "board": "board.ts" }
~~~

Names match `^[a-z][a-z0-9-]{0,31}$`, at most 4. Each is a `.ts` or `.js` file inside `public/`, compiled like `client` (same import rules, 256 KB each) and served at `/plugins/<name>/views/<view>.js`. In your client code:

~~~js
hq.ui.modal({ title: "Chess", size: "medium" }, [
  hq.ui.view({ view: "board", label: "Chessboard", height: "large", onMessage: (m) => hq.send(m) }),
]);
hq.ui.post({ t: "state", pieces });   // to the open view
~~~

In the view's script there is one global, `hqView`, and nothing of `hq`:

~~~js
hqView.onMessage((m) => draw(m));
canvas.onpointerup = () => hqView.send({ t: "move", from, to });
~~~

The view runs in an iframe with `sandbox="allow-scripts"` only (no `allow-same-origin`, forms, popups or navigation), under the same Content Security Policy as your hidden iframe: its own folder and your declared `externalHosts` for images and `fetch`, nothing else. The page only relays messages and never reads them. Types: [`view.d.ts`](../plugins/sdk/view.d.ts).

| Limit | Value |
| --- | --- |
| Views in one modal | 1 |
| Height | `small`, `medium` or `large`; the width is the modal's |
| Message size, each way | 4096 bytes of JSON |
| Messages, each way | 30 a second per view; the rest are dropped with a console warning |

Redrawing the modal with the same view in the same place keeps the iframe and its state; it is not reloaded. Closing the modal, another plugin's modal replacing it, or the plugin stopping on that page removes the iframe. Messages over a limit are dropped with a console warning, and the view stays. A view that fails in another way (it does not start within 10 s, or your manifest does not declare it) is removed with a console warning, and the modal stays; a malformed view element (a bad name, label or height, two views in one modal, a view outside a modal) stops the plugin on that page like any malformed element. What `hq.ui.post` sends while the view is still starting waits for it (up to 30 messages); without a view in the open modal it does nothing. The view's scripts run in its `<body>`, so `document.body` is there from the start. Send a message when something happens (a drop, a click), never one per animation frame.

## Browser side

Your `client` code runs in a hidden iframe with `sandbox="allow-scripts"`. That gives it an opaque origin: it cannot reach the page, its cookies or its storage, the camera or the microphone. It gets one global, `hq`. Every call is a command that the page validates and carries out. The page draws and animates; your code only says what to show.

| Function | What it does |
| --- | --- |
| `hq.onLoad(fn)` | Your code is ready. Load sprites and put your buttons here. |
| `hq.onUpdate(fn(dt, world))` | About 10 times a second. `world = { me, avatars: [{ id, name, x, y, dir, moving }] }` lists the avatars on screen, in world pixels at the feet. `dir` is 0 down, 1 left, 2 right, 3 up. |
| `hq.onMessage(fn(msg))` | A message from your server code. |
| `hq.send(msg)` | Sends JSON, at most 1500 bytes, to your server code's `onMessage`. The page sends at most 8 messages a second for all its plugins together (burst 16), under the server's own limit; the rest are dropped with a console warning, so a plugin never gets its member disconnected. |
| `hq.loadSprite(key, path, { frameW, frameH, anims })` | A PNG sheet from `public/` (at most 2048 px a side and 4096 frames), cut into frames. `anims = { name: { row, frames: [..], fps } }`. |
| `hq.loadSprite(key, image, { frameW, frameH, anims })` | The same from image data your code made: a `Blob` of at most 1 MB or an `ImageBitmap`, drawn on an `OffscreenCanvas` or downloaded from a host you declare (below). |
| `hq.loadSprite(key, { from, metadata }, { anims })` | A sheet another plugin draws on this page from that metadata (its `hq.provideSheet`), as hq-pets does for guest pets put by metadata. Its size comes with it; the sprite waits until it is drawn. |
| `hq.provideSheet(fn)` | Draws a sheet asked for by metadata: `fn(metadata)` returns `{ image, frameW, frameH }` (a `Blob` or `ImageBitmap`, checked like any image data), or a promise of it. |
| `hq.spawn(id, key, { x, y, anim })` and `hq.remove(id)` | Put a sprite in the world, anchored at the bottom centre of its frame, or take it away. Spawning an existing id replaces it. |
| `hq.moveTo(id, x, y, { speed })` | Walk there in a straight line (px/s, default 72). |
| `hq.walkTo(id, x, y, { speed })` | Walk there along a path around walls; somewhere it cannot reach (off the map, in a wall), as close as it can. |
| `hq.attach(id, playerId \| null)` | Pins the sprite above that member's head, just over their name tag, moving with them every frame; hidden while they are off screen. `null` lets it go (it stays where it is). While pinned, the sprite ignores `moveTo`, `walkTo` and `follow`. |
| `hq.follow(id, playerId, { gap, beside })` | Walk that member's trail, `gap` px behind (default 36), on the very path they walked, never cutting a corner. When the member stops, the sprite sits `beside` px to their side (default 22). Give each of several followers its own `gap` and `beside` and they walk and rest in a line. With `roam` (0-48 px), it potters about the member's feet instead of sitting still: a new spot about every 20 s, wherever it can stand, the same on every page. It hides while the member is off screen. `hq.follow(id, { sprite: other })` follows another of your sprites the same way. |
| `hq.stop(id)` | Stand still. |
| `hq.setAnim(id, name)`, `hq.setFlip(id, on)`, `hq.setVisible(id, on)` | Play an animation while standing, mirror the sprite, show or hide it. |
| `hq.setLabel(id, text, { owner })` | One line (at most 24 characters) shown above the sprite only while the mouse is over it; `null` removes it. With `owner`, that member's current name shows under it. Touch screens never show it. |
| `hq.setTint(id, colour)` | Multiplies the sprite's colours by `colour` (`"#rrggbb"`), `null` to remove it. Draw a sheet in light greys and a tint gives it any colour while dark outlines stay dark; the sample ships `pets-tint.png` for that. It costs nothing: no new texture. |

While a sprite moves (`moveTo`, `follow`), the page plays the animation named `walk-<facing>` (or `walk`). While it stands, it plays the one set with `setAnim`, else `idle-<facing>` (or `idle`). Facings are `down`, `left`, `right` and `up`.

Sprites sort with avatars and pets by their feet. The page redraws only when one of your sprites moves or changes frame. Calls made in the same callback travel to the page as one batch. `moveTo` stops at the first wall on its way.

### Images your plugin cannot ship

Some pictures cannot go in `public/`: their licence forbids redistributing them, or there are too many for the limits. Your browser code can fetch them from where they live and hand the page the image data (`hq.loadSprite(key, blob, ...)`), cropping or recomposing them on an `OffscreenCanvas` first if needed. Declare those hosts in the manifest:

~~~json
"externalHosts": ["raw.githubusercontent.com"]
~~~

**Privacy.** Each page that runs your plugin then asks that host for the images, so the host sees the address of everybody in the office. Administrators see the hosts in Administration > Plugins before they turn the plugin on. The list is enforced: the plugin's iframe may fetch from its own folder and these hosts only (a Content Security Policy), so an undeclared host is never reached. The host must answer with CORS (`Access-Control-Allow-Origin`) for the image to be readable.

### Interface: buttons, boxes and a modal

Your code describes what to show and Home Quarters draws it, in its own style, with keyboard focus, Escape and accessible names. Callbacks stay in your iframe: you write `onClick: () => ...` and the page sends the click back.

~~~js
hq.ui.slot("config", "sidebar", { onClick: openSettings });             // an entry in the side panel's Plugins tab
hq.ui.slot("call", "topbar", { label: "Let wander", onClick: toggle });  // a button in the top bar

function openSettings() {
  hq.ui.modal({ title: "Pets", size: "medium", onClose: () => {} }, [
    hq.ui.row([
      hq.ui.text("Cat"),
      hq.ui.color({ label: "Colour of Cat", value: "#3fa7d6", onChange: (c) => hq.send({ t: "colour", i: 0, c }) }),
      hq.ui.button({ label: "Remove", onClick: () => hq.send({ t: "remove", i: 0 }) }),
    ]),
    hq.ui.number({ label: "Pets per member", value: 3, min: 0, max: 8, onChange: (n) => hq.send({ t: "limit", n }) }),
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
| `hq.ui.color({ label, value, onChange })` | A colour picker. `value` is `"#rrggbb"`; `onChange(colour)` runs while it is being chosen, at most 4 times a second, and with the final colour. `hideLabel` keeps the label for screen readers only (also on `field`). |
| `hq.ui.sprite({ src, frame, scale, tint, alt })` | One cell of a PNG of `public/`, `frame` being `[x, y, w, h]` (at most 128 px a side), scaled 1-6 times (default 2) with crisp pixels; `tint` multiplies its colours like `hq.setTint`. A button takes the same `sprite` to show a picture before its label. |
| `hq.ui.field({ label, value, maxLength, placeholder, onChange })` | One line of text (at most `maxLength`, 1-200); `onChange(text)` runs once it is entered (Enter or leaving the field), if it changed. |
| `hq.ui.number({ label, value, min, max, onChange })` | A whole number in `min`..`max`; `onChange(value)` runs once it is entered (Enter or leaving the field), clamped to the range. |
| `hq.ui.view({ view, label, height, onMessage })` | A [view](#views) of your manifest in a sandboxed iframe, at most one per modal. `label` (1-40 characters) is its accessible title, `height` is `small`, `medium` or `large`. `onMessage(msg)` gets what the view sends. |
| `hq.ui.post(msg)` | Sends JSON, at most 4096 bytes, to the open view. |
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
