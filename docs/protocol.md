# WebSocket protocol

JSON text frames, short field names (see [decision 0004](0004-json-protocol.md)). The connection is authenticated by the session cookie. The server closes the socket with a code that tells the client what to do ([close codes](#websocket-close-codes)); **1009** means a frame was too large.

Every connection starts with a full `hello`; the same happens on every reconnect, so the client never needs to merge state across connections.

## Client to server

| Message | Fields | Meaning |
| --- | --- | --- |
| `in` | `s` seq, `x`, `y` (-1, 0, 1), `b` run | movement intent; sent on change and every 400 ms while held. `b: true` runs at `cfg.run` times the walking speed |
| `go` | `x`, `y` tile, or `id` of a player | run there along a path the server finds (walls, locked and forbidden rooms respected, portals avoided); any movement key cancels it. To a player, the run ends on their tile, so it enters their room; if that room is closed to you (locked, or somebody else's office), it ends on the closest tile you can reach |
| `st` | `v` | set status: `available`, `busy`, `away`, `invisible` |
| `consent` | `b` | opt in or out of automatic conversations |
| `chat` | `sc` (`o` office, `g` group, `d` direct), `text`, `id` (peer for `d`) | send a message |
| `loc` | `id` | ask where a person is |
| `view` | `n` cells | interest radius the zoomed view needs, in `cfg.cell` cells; the server clamps it to `cfg.aoi`..`cfg.aoiMax` and resubscribes ([decision 0018](decisions/0018-physical-keys-and-map-zoom.md)) |
| `sync` | none | ask for the current state of everything in view (sent when a hidden tab becomes visible) |
| `tok` | none | request a fresh media token for the current conversation |
| `emo` | `n` 1-8 | show a reaction above your avatar (700 ms server cooldown); 8 is a short dance (key Z) |
| `hand` | `b` | raise or lower your hand (shown in the roster and over the avatar) |
| `note` | `text` | set your status note, one line, at most 60 characters ("" clears it); kept in memory only |
| `wave` | `id` | wave at somebody anywhere in the office (2 s cooldown); busy and away people get it too, at most one per sender every 30 s (`wvr` `wait` otherwise); invisible people look offline |
| `use` | `x`, `y` tile | interact with the object at that tile (note, site, image, whiteboard); the server checks distance and area access |
| `fol` | `id` (0 stops) | follow that player; any movement key stops it |
| `lead` | `id` | ask that player to follow you (they decide) |
| `lock` | `b` | lock or unlock the meeting room you are standing in |
| `knock` | `n` area index | knock on a locked room or an assigned private office you stand close to |
| `force` | `n` area index | administrators only: walk through a closed door (a locked room, an assigned office or a locked desk) on purpose, from where a knock would reach; the people inside are told (`frc`) and the activity log records it ([decision 0019](decisions/0019-room-calls-from-two-and-desk-rooms.md)) |
| `kans` | `id`, `b` | admit or decline a knock (only from inside the room; in an assigned office only an owner or an admin) |
| `wb` | drawing ops | whiteboard edits: `draw` (batched pen points or one text), `del`, `undo`, `clear` (admin), `close`; all bounded, see decision 0010 |
| `diag` | `v` kind, `n` code, `c` ms | report a problem for the server log, never a normal leave: `media-drop` (LiveKit disconnect reason), `media-join` (0), `ws-drop` (close code, time offline); allow-listed and bounded, at most 20 per session |
| `plg` | `pl` plugin, `d` JSON (at most 1500 bytes) | a message from a plugin's browser code to its server `onMessage`; ignored when that plugin is not running; 10/s, burst 20 ([decision 0022](decisions/0022-plugins.md)) |
| `ping` | `c` | round-trip probe |

## Server to client

| Message | Fields | Meaning |
| --- | --- | --- |
| `hello` | `you`, `role`, `status`, `office`, `cfg`, `map`, `roster`, `chat` | initial state; `cfg` has speed, the run multiplier (`run`), tick, the interest grid (`cell` px, default radius `aoi` and largest radius `aoiMax` in cells), media availability, your position, the areas denied to you and the server's version (`ver`); `chat` is the persisted office chat. The page served by the same server carries that version in `<meta name="hq-version">`: when they differ (a deploy happened since the page loaded), the client shows a dialog that cannot be dismissed and asks to reload |
| `w` | `k` tick, `m` [[id, x, y, d]...], `l` [id...] | **state records** in your area of interest and entities that left it |
| `a` | `s`, `x`, `y` | acknowledgement with the authoritative position at the time of input `s` |
| `p` | `a` people added/updated, `d` ids removed | presence roster changes; a person is `{id, n, av, s, r}` plus `h: 1` (hand raised) and `m` (status note) when set |
| `c` | `sc`, `f` from, `to`, `x` text, `ts` | chat message |
| `conv` | `op` = `join` / `m` / `leave` | conversation lifecycle, including room name and token on `join`; a room's call starts when a second person enters and ends (`leave`) for the last one left ([decision 0019](decisions/0019-room-calls-from-two-and-desk-rooms.md)) |
| `map` | `map`, `deny`, optional `x`/`y` | the office map changed (admin edit); `x`/`y` present if you were moved |
| `loc` | `id`, `ok`, `x`, `y`, `a` | answer to a locate request |
| `e` | `id`, `v` 1-7 | somebody's reaction; rendered above their avatar |
| `obj` | `k` note/embed/image, `l` label, `d` content | object content, only after a nearby authorised `use` (never in the map) |
| `fol` | `id`, `n` | you are now following (or stopped, `id` 0) |
| `wv` | `from`, `n` | somebody waved at you |
| `wvr` | `id`, `st` ok / busy / away / offline | what happened to your wave |
| `ac` | `c` [count per area] | visible people per map area, in map order; sent with `hello` and then at most every 2 s when a count changes |
| `ann` | `n` sender name, `x` text | an administrator's announcement banner (one line, at most 280 characters, never stored) |
| `office` | `n` name | an administrator renamed the office; later `hello`s carry the new name |
| `go` | `ok`, `x`, `y`, `near` | a walk-to was accepted (the server now steers you, `self` carries the positions) or refused (`ok: false`: no path, nobody there); `near: true` means the person is behind a door you may not open and the run stops at it; its end arrives as `fol` with `id` 0 |
| `self` | `x`, `y`, `dx`, `dy`, `d`, `tp` | your authoritative position while following or walking to a place, once more where a guided walk stops, and after a portal (`tp`) |
| `lreq` | `from`, `n` | somebody asks you to follow them |
| `deny` | `d` denied areas, `lk` locked rooms | your blocked-area list (locks change it for everyone) |
| `knk` | `id`, `n`, `a` | somebody knocks on the room you are in (`done` dismisses) |
| `knr` | `st` wait/ok/no/empty, `a` | the answer to your knock |
| `frc` | `n` name, `a` area | an administrator forced the door of the room you are in |
| `wb` | `op` state/draw/del/clear/closed | whiteboard state and live strokes; deletes carry owner+id |
| `spot` | `op` on/off | office broadcast: speaker, room and token (subscribe-only unless you are the speaker) |
| `plg` | `pl` plugin, `d` JSON (at most 4 KB) | a message from a plugin's server code (`hq.send`, `hq.broadcast`) to its browser code. Never sent to invisible members; dropped (and counted) rather than queued when your outbound queue is half full |
| `plgs` | none | the set of running plugins changed: fetch `GET /api/plugins` again |
| `pong` | `c` | reply to `ping` |

### State records (`w`)

A record is **not** a position sample: it is the state to extrapolate from ([decision 0006](0006-state-change-records.md)). `d` packs the facing direction and the movement:

~~~text
d = facing | (dx + 1) << 2 | (dy + 1) << 4 | run << 6     facing: 0 down, 1 left, 2 right, 3 up; dx, dy in -1..1
idle = dx = dy = 0
~~~

Clients keep moving the entity with the same rules as the server (speed from `cfg.speed`, times `cfg.run` when the run bit is set, diagonals scaled by 1/sqrt(2), axis-separated collision against the static walls of the map, sub-steps of at most 4 px, and a blocked axis moves to the point of contact with the wall; see [decision 0017](decisions/0017-movement-reconciliation-and-render-on-demand.md)). The server sends a new record when the direction or the run state changes, when reality diverges from that extrapolation, as a 1 s resync, and when you start seeing the entity. The run bit is only set while moving.

Avatars are `{sk, hs, hc, sh, pa, bd, ht, hk}`. The colours `sk` (skin, 12 swatches), `hc` (hair, 16), `sh`, `pa` and `hk` (shirt, trousers and hat, 24 each) are a palette index or any custom colour as `"#rrggbb"` (stored lower case; anything else becomes index 0); palettes only grow, so an index never changes colour. The other fields are small integers (`pt`, the retired built-in pet, is dropped: pets are the bundled plugin now): `bd` the beard (0 none, 1-5), `ht` the hat or head covering (0 none, 1-9; 9 is the hijab) and `hk` the hat colour. `bd`, `ht` and `hk` are left out when 0. `hs` is the hair style (0-11); 5 is the retired "cap" style, which the server rewrites to bald (`hs` 2) with a cap (`ht` 1) in the hair colour (`hk` = `hc`), the same pixels as before. The server clamps unknown values to 0 and drops unknown fields. Avatars stored before this rule keep `hs` 5 until their owner saves again and are sent as stored, so clients must keep drawing `hs` 5 as bald + cap (`normaliseLook` in `web/src/game/art/look.ts`).

## HTTP endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz`, `GET /readyz` | none | liveness, readiness (database) |
| `GET /metrics` | bearer `HQ_METRICS_TOKEN`; open in dev; **disabled (404) in production without a token** | Prometheus text |
| `POST /api/join` | invite (production); with sign-in, a completed sign-in | create a member; `{name, avatar, invite}`; sets the session cookie. With `HQ_AUTH_PROVIDERS`, only after a sign-in that admitted a new identity; the invite then comes from the sign-in, not the body. Refusals carry `code`: `expired` (no sign-in, 403), `invite` (spent meanwhile, 403), `taken` (the account already has a member, 409) |
| `GET /api/me` | cookie | `{authenticated, auth, dev, demo}` plus the member (`id, name, role, avatar`) when signed in. `auth` lists the sign-in providers (empty without sign-in). Not signed in: `signup: {email}` when an admitted identity has yet to pick a name, `link: {name}` when a member from before sign-in must connect an account |
| `GET /auth/{provider}/start` | none | with sign-in only: begins an OpenID Connect sign-in and redirects to the provider; `invite` and `login_hint` are passed through. With a session that has no identity, the sign-in links one to it ([decision 0021](decisions/0021-sign-in-providers.md)) |
| `GET /auth/{provider}/callback` | state cookie | the provider's return: signs in a known identity, sends a new admitted one to the name form, links one, or redirects to `/?auth=` `denied`, `taken`, `cancelled` or `failed` (with the sign-in's `invite` and `login_hint`, so a retry keeps them), or `linked` after linking. Nothing is kept on the server between start and callback: the flow travels in a cookie signed with a key drawn at start |
| `POST /api/signout` | cookie | with sign-in only: this browser forgets its session cookie and any sign-up in progress. A session linked to an account ends for good ("Sign out" in the settings: a copy of the cookie stops working, signing in again finds the same member); a session not linked yet stays valid ("Not you?" on the link screen: for a member from before sign-in it may be the only way in) |
| `GET, POST /auth/fake-oidc/authorize`, `POST /auth/fake-oidc/token` | none | `fake-oidc` only (refused in production): the development provider's consent page and token endpoint |
| `GET /about` | none | a public page saying what the office is, who runs it, who can enter and what a sign-in provider is used for; Google's branding review reads it as the app's home page; linked from the join screen |
| `GET /privacy` | none | the office's privacy policy, generated from the configuration (sign-in, demo, `HQ_OPERATOR`, `HQ_CONTACT`); linked from the join screen |
| `GET /link/{token}` | the link | a personal link: opens that member's session. Refused (403) for a member who signs in with a provider |
| `POST /api/account-link` | cookie | mint your own personal link. Refused (403) while sign-in is on |
| `PUT /api/profile` | cookie | change your name and avatar |
| `POST /api/desk` | cookie | take the free desk at tile `{x, y}`: you must be connected, next to it, have no desk or office, and the desk must not be inside a room. The new map goes to everybody; refusals return `{error}` = `offline`, `far`, `taken`, `room`, `has_place` (409) or `no_desk` (404) ([decision 0020](decisions/0020-members-take-free-desks.md)) |
| `POST /api/desk/release` | cookie | free your own desk at tile `{x, y}` while you stand in its room; refusals: `offline`, `far` (not in the desk's room), `not_mine` (409) or `no_desk` (404) |
| `POST /api/invites` | admin | mint an invite `{role, maxUses, hours}`; the secret is returned once |
| `GET /api/admin/invites` | admin | list invites (id, role, uses, expiry, creator, status); never the secret |
| `DELETE /api/admin/invites/{id}` | admin | revoke an invite |
| `GET /api/admin/members` | admin | list members `{members: [{id, name, role, joinedAt, email}], you}`; `email` is the signed-in account's address, empty while the member has none |
| `PATCH /api/admin/members/{id}` | admin | change a role `{role: "admin"|"member"}`; the member is disconnected and reconnects with the new role. The last admin cannot be demoted (409) |
| `DELETE /api/admin/members/{id}` | admin | remove a member: sessions deleted, socket closed, call ended. Not yourself, not the last admin (409) |
| `GET /api/admin/audit` | admin | the latest 100 admin actions, newest first |
| `POST /api/admin/announce` | admin | `{text}` (1-280 characters): banner to everybody online; one per 15 s per admin (burst 2); audited as `announce` without the text |
| `PATCH /api/admin/office` | admin | `{name}` (1-40 characters after trimming; control characters removed): renames the office, stored (it outlives restarts) and pushed to everybody online as `office`; audited as `office.rename` with the old and new name; answers `{name}` |
| `PUT /api/map` | admin | validate, apply and save a new map |
| `GET /api/admin/map` | admin | the saved map including hidden interactive-object content (the world map redacts it; editors must round-trip through this endpoint or they will erase object content) |
| `GET /ws` | cookie | the world WebSocket |
| `GET /api/plugins` | cookie | running plugins `[{name, title, client}]`; `client` is the URL of the plugin's browser code or null. `[]` when plugins are off |
| `GET /api/admin/plugins` | admin | installed plugins `[{name, title, version, description, state, error}]`, `state` = `disabled`, `running`, `crashed` or `broken` |
| `PUT /api/admin/plugins/{name}` | admin | `{enabled}`: start or stop the plugin now and remember it; answers `{state}`; 404 unknown, 409 broken or failing to load (with `error`); audited as `plugin.enable` / `plugin.disable`; everybody online gets `plgs` |
| `GET, POST /plugins/{name}/api/{path}` | cookie, or `Authorization: Bearer <app token>` on routes declared with `{ token: true }` | a route the plugin declared with `hq.route`; 404 when it is not running or has no such route, 503 when it does not answer within 1 s; POST bodies at most 16 KB; 5 requests/s per member and plugin, burst 10 |
| `GET, POST, DELETE /api/plugins/{name}/token` | cookie | a member's app token for a running plugin whose manifest has `appTokens`: `GET` → `{exists, createdAt}`, `POST` → `{token}` (shown this once; replaces the previous one), `DELETE` revokes it. Audited as `plugin.token.create` / `plugin.token.revoke`; 404 for other plugins |
| `GET /plugins/{name}/client.js` | none | the running plugin's browser code, compiled by the server from its `client` (`.ts` or `.js`) |
| `GET /plugins/{name}/assets/{path}` | none | a file of the running plugin's `public/` folder (png, js, json, css, at most 1 MB); never its server code. Public on purpose: the plugin's sandboxed iframe has an opaque origin and sends no cookie |

## WebSocket close codes

| Code | Meaning | Client behaviour |
| --- | --- | --- |
| 4001 | replaced by a newer connection of the same user (another tab) | stop, show "session opened in another tab" |
| 4002 | the client could not keep up (reliable queue overflow) | reconnect with backoff |
| 4003 | an admin removed the member or changed their role | ask `/api/me`: still a member -> reconnect at once; otherwise go to the join screen with a notice |
| 1013 | server closing the connection for another reason | reconnect with backoff |

The reason is recorded on the world goroutine right before the outbound channel closes, so the writer always sends the right code.

## Limits

| Limit | Value |
| --- | --- |
| Incoming frame size | 2 KB |
| Movement input rate | 40/s, burst 80 |
| Control messages | 10/s, burst 30 |
| Chat | 3/s, burst 8; 500 characters |
| Outbound queue per client | 128 frames |
| Reconnect grace before removal | 10 s |
| Join / map / profile requests | rate limited per IP or user; bodies capped (4 KB, 512 KB, 4 KB) |
| Admin API | 5 requests/s per admin, burst 20; bodies capped at 256 B (role change) |
| Plugin messages | client to server 10/s, burst 20, 1500 bytes; server to client 10/s per member for all plugins together (burst 20), 4 KB |

Sustained violations disconnect the client. Text is trimmed of control characters on the server.
