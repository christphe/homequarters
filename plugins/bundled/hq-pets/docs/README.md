# hq-pets: developer guide

`hq-pets` is the pets plugin bundled with Home Quarters. Members add pets that follow them around the office, and other plugins can give a member a pet of their own drawing that `hq-pets` then walks, through two public hooks. This page is for people writing such a plugin, and for whoever maintains `hq-pets`. How plugins work in general is in the [Plugins guide](../../../../docs/plugins.md) and the [API reference](../../../../docs/plugin-api.md).

## What a member gets

- From the side panel (Plugins > Pets), a member adds pets of the 9 kinds the plugin draws (cat, dog, bunny, fox, chick, slime, owl, axolotl, seedling), several of one kind if they like, names them (24 characters) and picks a colour for each, or keeps the drawn colours. How many they may have is the office's `limit` setting (3 by default), set by an administrator with the plugin's settings button in Administration > Plugins.
- Walking, pets follow their owner's trail in a line, 20, 36, 52 px... behind. When the owner stops, they potter about the owner's feet (all around where it is free).
- **Let pets wander** (top bar) sends them off; **Call pets** brings them back, walking around walls. While they wander each pet has a mood, changing about every 5 minutes: explore the office, potter about where it was left, stay close to its owner, or go along with another wandering pet (anybody's; it explores when there is none). Pointing at a wandering pet shows its name and, under it, its owner's.

## Giving a member a pet from another plugin

A plugin can put pets of its own drawing with a member: a "guest" pet. `hq-pets` makes it follow, rest, wander with the moods, come back on Call pets and show its name, exactly like the member's own pets. Unlike them:

- it does **not** count in the office's limit;
- it is **not** shown in the Pets modal: the member cannot rename, recolour or remove it there. The plugin that put it manages it;
- at most **4** guest pets per member, all plugins together;
- it is kept (across restarts) until the plugin that put it removes it.

### For whom

A hook never takes a member as an argument. Home Quarters tells `hq-pets` which member your plugin was acting for when it called: the member whose request, message, arrival or departure it was handling (`caller.member`). So you call from:

- a route, for `req.player` (also a route an app calls with that member's app token: `{ token: true }`);
- `onMessage(player, msg)`, for that member;
- `onJoin(player)` / `onLeave(player)`, for that member.

A call made in `update()`, `load()` or after an `await` of something else has no member, and `hq-pets` refuses it. No plugin can give someone else a pet.

### The sprite sheet

Put it under your plugin's `public/shared/` (the only part of `public/` other plugins' pages may draw). One PNG per creature:

- 3 columns: standing, step A, step B;
- 4 rows: facing down, left, right, up;
- cells of `w` x `h` px, each 8 to 64 (`cell: [w, h]`); the creature stands on the bottom of its cell, centred;
- at most 2048 px a side. Transparent background; draw a 1 px dark outline if you want it to match the house style.

The sheet is drawn as is: guest pets have no colour picker.

### `setPet`

~~~ts
const r = await hq.plugins.call("hq-pets", "setPet", {
  id: "current",                  // yours to choose: ^[a-z0-9-]{1,16}$
  sheet: "shared/sparkmouse.png", // in your public/shared/
  cell: [32, 32],                 // [w, h], 8 to 64 each
  name: "Sparky",                 // optional, shown on hover; trimmed to 24 characters, one line
});
// r: { ok: true } | { ok: false, error: "no member: ..." | "bad arguments" | "full" }
~~~

Puts the pet with the member, or replaces your pet with the same `id` (to change the creature, keep the `id`). `"full"`: the member already has 4 guest pets.

### `removePet`

~~~ts
const r = await hq.plugins.call("hq-pets", "removePet", { id: "current" });
// r: { ok: true, removed: true | false } | { ok: false, error: "no member" }
~~~

You only ever remove your own pets (same plugin, same `id`, the member you act for).

### When the call fails

`hq.plugins.call` rejects (throws in an `await`) when `hq-pets` is off, busy, or slower than 2 s; check `ok` in the answer for the rest. Your pets stay stored while `hq-pets` is off and come back with it. If your plugin is off, its `shared/` images are not served and its guest pets are not drawn.

### A complete example

An app on the member's computer (a desktop companion) tells your plugin which creature to show; your plugin gives it to `hq-pets`.

~~~text
HQ_PLUGINS_DIR/installed/sparkmice/
  plugin.json
  main.ts
  tsconfig.json
  public/shared/sparkmouse.png
~~~

~~~json
{ "name": "sparkmice", "title": "Sparkmice", "version": "1.0.0",
  "description": "A sparkmouse that follows you, chosen from your desktop app.",
  "server": "main.ts", "appTokens": true }
~~~

~~~ts
export function load(): void {
  // the member's app calls this with their app token: req.player is them
  hq.route("POST", "/pet", async (req) => {
    const r = await hq.plugins.call("hq-pets", "setPet", {
      id: "current", sheet: "shared/sparkmouse.png", cell: [32, 32], name: String(req.body).slice(0, 24),
    });
    return { status: r && (r as { ok: boolean }).ok ? 200 : 409, body: r };
  }, { token: true });
  hq.route("POST", "/unpet", async () => ({ body: await hq.plugins.call("hq-pets", "removePet", { id: "current" }) }), { token: true });
}
~~~

The member creates the token in your plugin's modal (`hq.ui.appToken()`, which needs `"appTokens": true`), pastes it into the app, and the app calls:

~~~bash
curl -X POST -H "Authorization: Bearer $TOKEN" -d "Sparky" https://office.example.com/plugins/sparkmice/api/pet
~~~

The suite's test plugin [`critters`](../../../../e2e/fixtures/plugins/installed/critters) does exactly this, and `e2e/scenarios/plugins.mjs` checks it end to end.

Installed plugins must not start with `hq-` (reserved for bundled ones), and their art is theirs: nothing taken from games or other people's work goes into this repository.

## Inside hq-pets (maintainers)

| File | What it holds |
| --- | --- |
| `plugin.json` | Manifest: the `limit` setting (0-8, default 3) and the long description shown by the About button. |
| `main.ts` | Server: members' pets (`hq.kv` `p:<member>`), guest pets (`g:<member>`), modes, the setting, the hooks, and one broadcast per update cut to 3.5 KB of UTF-8 (a message carries 4 KB). |
| `public/messages.ts` | The messages between server and pages, typed once for both, and the kind list. |
| `public/client.ts` | The page side: sprites, labels, the modal, the top bar button, the moods (run by the owner's page). |
| `public/pets.png`, `public/pets-tint.png` | The 9 kinds in their colours and in light greys for `hq.setTint`, 16 x 20 cells; written by `e2e/export-art.mjs` from `web/src/game/art/pluginPets.ts`. |

- **Who decides what.** The server keeps pets, names, colours, modes and the limit, and checks every message (rate-limited: 5 changes a second per member). The owner's page runs its pets' moods and picks their wander spots; the server relays them and every page walks the pets there (`hq.walkTo`, `hq.follow` with a sprite to go along). Following, resting and pottering are computed on each page from the sprite and the clock (`hq.follow` with `roam`), so pages agree without messages.
- **Sizes.** A member has at most 8 pets and 4 guests; names are 24 characters; a broadcast never goes over 3.5 KB, whatever the script of the names; a page draws at most 240 of the plugin's sprites, its own member's first.
- **Tests.** `server/internal/plugin/sample_test.go` (limit, names, sizes in any script, hooks, malformed and spammed messages), `server/internal/plugin/hooks_test.go` (hooks in general), `e2e/scenarios/plugins.mjs` (everything through the real controls, the hooks from outside the browser), `web/test/petFollow.test.ts` (following, resting, pottering).
