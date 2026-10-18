# 0023: Plugin interface and app tokens

Date: 2026-10-17. Status: accepted.

## Context

[Decision 0022](0022-plugins.md) gave plugins sprites and a list of buttons in the side panel. Two needs followed. First, plugins want real interface: a settings modal, a toggle in the top bar, a small status box on the map. Second, a desktop companion (an app counting a member's AI tokens, say) wants to post that member's state to a plugin. It has no browser session, so it needs a credential of its own.

## Decision

- **Declarative interface, drawn by Home Quarters.** A plugin's iframe sends a small tree of known components: `text`, `button`, `copy`, `image`, `row` and `appToken`. React draws it with the house style, keyboard focus, Escape and accessible names. The SDK reads like React: `hq.ui.button({ label, onClick })`. Callbacks stay in the iframe as ids, and the page sends clicks back. Plugin code never runs in the page.
- **Anchors.** `hq.ui.slot(id, anchor, ...)` puts a button in the top action bar (`topbar`), next to the status (`topright`), in the bottom bar (`bottombar`), in the side panel's Plugins tab (`sidebar`, named after the plugin by default) or over the minimap (`minimap`). It can also put a small box on the map (`screen`), placed from a corner with clamped offsets and a bounded size.
- **One modal at a time.** `hq.ui.modal({ title, size, place }, content)` opens or redraws the plugin's modal. Size and place are presets (`small` / `medium` / `large`, `center` / `right`) so phones keep working. Closing it (Escape, Close, a click outside, another plugin's modal) always works and runs the plugin's `onClose`.
- **App tokens are Home Quarters'.** A plugin opts in with `"appTokens": true`, puts `hq.ui.appToken()` in its modal, and declares routes with `{ token: true }`.
  - Home Quarters draws create, copy-once, replace and revoke, and serves `GET`/`POST`/`DELETE /api/plugins/{name}/token`.
  - It stores a SHA-256 hash (migration 010). It accepts `Authorization: Bearer hqp_...` only on that plugin's token routes, with `req.player` set to the token's member.
  - Tokens die with the membership, and creation and revocation are audited.
  - The plugin never handles the secret.
- **The sample plugin** uses a `sidebar` entry that opens a modal (show or hide my seedling, pick its colour) and a `topbar` toggle, Let wander / Call. A wandering seedling strolls near where it was left. The owner's page picks the spots, the server code relays them, and every page walks it there. This is cosmetic, like pets. `moveTo` now stops at walls. The other anchors and the token widget are exercised by a test plugin in `e2e/fixtures/plugins/ui-demo`.

## Alternatives

- **Plugin HTML in a visible iframe inside the modal.** It gives the most freedom. But the focus trap and Escape stop at the iframe, axe cannot audit inside it, the style does not follow the theme, and copying needs another sandbox permission. A Home Quarters update would also break plugins' layouts.
- **Plugin code in the page with real React components.** It would mean synchronous props and callbacks, at the price of the isolation decision 0022 rests on (session, media, DOM).
- **Free pixel positions and sizes.** Simple to offer, but they break on a 390 px phone. The presets cover what was asked.
- **Tokens minted and checked by each plugin's own code.** Every plugin would need cryptographic randomness, header access, constant-time comparison, storage and revocation, and would get some of them wrong. Doing it once in the core keeps the secret out of plugin code.

## Impact

- Performance: none when no plugin uses the interface. A redraw sends one small tree over the MessageChannel and React redraws only the plugin parts. A token route costs one indexed SQLite lookup and one update (`last_used_at`).
- Maintenance: components and anchors live in `web/src/plugins/commands.ts` (validation, unit-tested) and `web/src/ui/PluginUI.tsx` (drawing). A new component is added in those two files, the SDK and `docs/plugins.md`. The part-1 `addButton` API is gone; it was never released.
- Install: a new table (`app_tokens`, migration 010). Nothing to configure.
- Known limits: a phone's top bar is already full, so labelled plugin buttons there crowd it (plugins should prefer icons). A `screen` box can be covered by Home Quarters' own controls (the minimap moves to the top on phones). There is no input component yet (text fields, selects).
