# Desks and PCs as depth-sorted sprites: design

Date: 2026-10-25. Status: draft for review. Branch `feat/map-objects`, based on `feat/office-templates` (the Loft, Lodge and Manor templates are not on `main` yet).

## Intent

Today the whole map, furniture included, is baked into one texture under every avatar ([WorldView.ts](../../../web/src/game/WorldView.ts), `bakeMap`). A desk's top and screen rise above its tile (`DESK_RISE`, the screen up to 11 px above the tile), yet an avatar standing or sitting behind a desk is drawn over it: its legs show through the desktop and over the monitor.

This change is the first step towards map objects that are real sprites, sorted in depth with the avatars, and that can sit on other furniture:

1. **Desks get depth.** An avatar behind a desk is hidden by the desk top and its screen; in front of it, the avatar covers the desk as now.
2. **The PC becomes its own object**, a prop of type `pc` standing on a desk, instead of a monitor drawn inside `desk()`.
3. **The map format gains a visual offset** (`dx`, `dy` in pixels) so an object can sit off the tile grid where the art needs it (a PC centred on a 2-tile desk).

The long-term aim, stated by the user: furniture and the objects on it leave the baked texture, and administrators compose desks freely (a laptop, two screens, a lamp). That needs an editor rework, which is a later, separate step. The plugin chess spec (`docs/superpowers/specs/2026-10-25-plugin-objects-chess-design.md`, branch `feat/plugin-chess`) is postponed to a v2.0 built on this.

## Goals

- An avatar whose feet are north of a desk's front edge is drawn behind that desk and the PC on it; south of it, in front. This holds for desks facing us (`desk`) and turned desks (`up`, back-to-back islands).
- A new prop type `pc`: 1x1, not solid, standing on a desk tile, drawn as a sprite above its desk, facing the way its desk faces.
- `dx`, `dy` on props in the map format, wire form and protocol docs.
- The three templates (Loft, Lodge, Manor) build every desk with a `pc` on it, centred, so applying a template gives desks and PCs as separate objects.
- Saved maps are not migrated and look exactly as before, but get depth too.
- No rendering cost per frame beyond sorting a few dozen more static sprites with the avatars.

## Non-goals (this step)

- Taking desks or PCs out of the baked texture. They stay baked; sprites are drawn **on top** (approach A below).
- Depth for any other furniture (tables, chairs, plants, shelves, couches, the reception desk). The mechanism is general; other types join later.
- The editor rework: dragging, snapping, Alt for free placement, editing `dx`/`dy` by hand.
- Other surface objects (laptop, lamp on a desk, chessboard on a table) and plugin objects.
- Migrating saved maps, or a "bare desk" with nothing on it.
- Changing the minimap.

## Anti-goals (a failure even if it works)

- A visible seam, shift or colour change where a sprite lies over its baked twin when nobody stands behind it. With no avatar around, the office must render pixel-identical to today.
- A saved office that loses its screens, gains a second screen, or changes in any visible way.
- A gameplay rule (collision, reach, desk rooms, desk taking, `CarryDesks`) that reads `dx`/`dy` or the `pc` props. Offsets are visual only; the server stays on tiles.
- Per-frame work that grows with the number of desks beyond the depth sort (no redraw, no per-frame texture upload).
- A new GPU texture as large as the map. The sprites share one small atlas.

## Constraints from the codebase

- `bakeMapCanvas` ([tiles.ts](../../../web/src/game/art/tiles.ts)) draws props back to front, sorted by their bottom row. `desk()` draws `deskBody`, an optional mug (chosen by `hash(x, y, …)`), `screenFront` and a keyboard; `deskUp()` draws `deskBody`, a keyboard and `screenBack`. Chairs read neighbouring desks (`tableBeside`, `touching`) to pick their art.
- The baked canvas is kept (`this.baked`) and shared with the minimap ([WorldView.ts:705](../../../web/src/game/WorldView.ts#L705)).
- Avatars, pets and plugin sprites live in `entLayer` (`sortableChildren`), `zIndex = e.y`, the feet's world-pixel row (sprite anchor at `FEET_Y`). `roundPixels` is on; the camera zoom is an integer.
- `gamemap.Prop` has `T, X, Y, W, H, Assign, Label, Up, Data, To`; `propDefaults` gives size and `Solid`; `Map.Validate` refuses unknown types and out-of-bounds props. Templates are Go functions (`Default`, `Lodge`, `Manor`) in `server/internal/gamemap`.
- The map editor ([MapEditor.tsx](../../../web/src/ui/MapEditor.tsx)) places a prop by clicking a tile (`PROP_TYPES`), erases by clicking, and has no dragging of props.
- Protocol changes go to `web/src/net/protocol.ts`, `docs/protocol.md` and the world tests together (AGENTS.md).

## Approaches considered

- **A. Sprites over the bake (chosen by the user).** Desks and PCs stay baked; every desk and every `pc` also gets a sprite of itself in `entLayer`, drawn exactly over its baked twin. One rendering path for old and new maps; the minimap and everything else reading the bake (art preview, `export-art.mjs`) keep showing screens; the cost is a few dozen static sprites and drawing desks twice. Desks and PCs leave the bake in the editor step.
- **B. Two regimes.** Old maps as in A; maps from a template have desks and PCs out of the bake, the minimap redrawing them. The final architecture for new maps, but two rendering paths to keep and test, and minimap work that the editor step would redo. Rejected.
- **C. Everything out of the bake now**, with an implicit screen on desks without a `pc`. One path, but more work before the editor exists and a minimap change. Rejected for this step.

## Design

### 1. Map format

- `Prop` gains `DX`, `DY` (`json:"dx,omitempty"`, `json:"dy,omitempty"`), integers in pixels, each in `[-15, 15]`. They move only the drawing.
- New type `pc` (`PropPC`): `propDefaults` `{1, 1, false}`. It must stand on a tile of a desk's footprint (`Validate` refuses a `pc` elsewhere, with its index, like other prop errors). No `Data`, `To`, `Assign`, `Label`, `Up`, `W`, `H`.
- `dx`/`dy` are accepted only on types drawn as sprites, which is `pc` for now; `Validate` refuses them on other types. The rule widens as types become sprites. *(Builder's call recorded as ours: an offset on a baked prop would need the bake to honour it, which is out of scope.)*
- Several `pc` on one desk are allowed by the format (two screens later); the templates put one.
- `protocol.ts` `Prop` gains `dx?`, `dy?`; `docs/protocol.md` describes `pc` and the offsets. No new message.
- Saved maps load unchanged: no `pc`, no offsets.

### 2. Templates

`Default` (Loft, also the map of a new office), `Lodge` and `Manor` add one `pc` per desk, private-office desks included, centred: on the desk tile under the desk's centre, with the remainder as `dx`. For a desk of width `w` tiles, the `pc` is at `X = desk.X + (w-1)/2` (integer division) with `dx = 8` when `w` is even and `0` when odd: the 2-tile desks of Loft get the left tile and `dx = 8`, the 3-tile desks of Lodge and Manor (`wideOffice`) the middle tile and `dx = 0`. The offset therefore never exceeds 8 for any desk width. `dy = 0`. *(Builder's call recorded as ours.)* The PC faces the way its desk does (it reads `up` from the desk under it; it stores nothing). Preferably one helper applied by every template so a later template cannot forget it. `CarryDesks`, `Summarize`, desk rooms and desk taking ignore `pc`. The template tests check that each desk carries exactly one `pc` and the map validates.

### 3. Art

- `desk()` and `deskUp()` take whether the desk carries a `pc`: with one, they draw the body and the mug only (no screen, no keyboard); without one, exactly what they draw today.
- A `pc` is drawn by new code in `tiles.ts` from the existing `screenFront`/`keyboard` (desk facing us) or `keyboard`/`screenBack` (turned desk), at the same pixels relative to the desk as today, so a template desk with its `pc` looks like an old desk.
- The bake draws each `pc` right after its desk (same back-to-front pass), so the baked texture, and with it the minimap, shows the screens as today. *(Builder's call recorded as ours: it keeps approach A's "sprite over its baked twin" true for PCs too, and leaves the minimap untouched.)*
- The art lives in `web/src/game/art` as all art does; no external asset.

### 4. Sprites and depth

- After the map is baked (same moment: map load, admin edit, template switch, desk taken or released), the view builds one sprite per desk and one per `pc`, from a small atlas canvas holding one cell per distinct look: desk (width, `up`, mug or not and which, with or without `pc`) and pc (front, back). Sprites are rebuilt with the bake and destroyed with it; the atlas texture is freed like the map texture is.
- A desk sprite is the desk drawn alone on transparency: what `desk()`/`deskUp()` paint, nothing of the floor, chair or neighbours. It is placed so its pixels fall exactly on the baked desk's.
- **Masked by the final bake.** Something baked after a desk may overlap it (a plant, lamp, shelf or chair on the row below whose art rises over the desk, in an administrator's own map). A sprite would then cover it even with nobody around. So each desk and `pc` sprite keeps only the pixels where the finished bake equals the object drawn alone, and is transparent elsewhere. This keeps the office pixel-identical to the bake whatever the neighbours; the masked pixels are simply not given depth. Masked sprites may differ per placement, so the "one cell per look" atlas becomes one cell per look where no mask applies, plus one cell per masked placement. *(Builder's call recorded as ours.)*
- `zIndex` of a desk sprite: the world-pixel row of the desk's front edge (the bottom of its footprint, where its legs stand). A `pc` uses its desk's `zIndex` plus a fraction, so it is always drawn over its desk and never splits from it against an avatar. *(Exact row: builder's call, set by looking at frames of an avatar on the tile north and south of each desk kind.)*
- The mug is chosen by `hash` of the desk's absolute pixel position: the atlas must draw each desk with the same seed as the bake (draw at the absolute position with a translated context, or pass the seed), or the sprite would show a different mug than the bake under it.
- Nothing changes per frame: these sprites never move; the only extra cost is the sort, which already runs when an avatar's `zIndex` changes.

### 5. Editor (minimal, until the rework)

- `pc` appears in the prop list. Clicking a desk tile with it places a `pc` centred on that desk (left tile and `dx` as the templates do); clicking a tile that is not a desk does nothing.
- Erasing on a desk tile removes the `pc` on it first; a second click removes the desk. Erasing a desk also removes the `pc` props standing on it, so the map never holds a floating `pc` that `Validate` would refuse.
- New labels go through `web/src/i18n.ts` (`prop.pc`).

### 6. Docs

`docs/protocol.md` (prop `pc`, `dx`/`dy`), `docs/art-style.md` (the bake plus depth-sorted desk and PC sprites), a decision record `docs/decisions/0030-depth-sorted-desks.md` (approach A, why the bake stays for now, memory and per-frame impact, the path to the editor step), `docs/status.md` and the README status table, and a `server/CHANGELOG.md` entry (`changed`: desks hide the people behind them; `added`: the `pc` object). Note that the plugin chess spec, which also proposes ADR 0030, will need renumbering.

## Acceptance criteria and where each is observed

| # | Criterion | Seam |
| --- | --- | --- |
| 1 | `Validate` accepts `pc` on a desk tile with `dx`/`dy` in range; refuses a `pc` off a desk, an offset out of `[-15, 15]`, an offset on another type, and forbidden fields on `pc` | `gamemap` table tests |
| 2 | Each template's map validates and every desk carries exactly one `pc`, centred; `CarryDesks` and `Summarize` give the same results as before the change | `gamemap` template tests |
| 3 | With nobody near, the office renders pixel-identical with and without the sprite layer, for a saved map without `pc`, for Manor (desks with `pc`), and for a fixture map where a plant and a chair on the row below overlap a desk | browser scenario: read back the canvas with sprites hidden and shown, diff |
| 4 | A saved map from before this change (no `pc`) renders as it did before the change, and Manor with its `pc` props renders as Manor did before the change (desks with built-in screens) | the same diff against captures made on the base branch |
| 5 | An avatar on the tile north of a front-facing desk and on the chair north of a turned desk is cut by the desk top and the screen; on the chair south of a desk, it covers the desk as before | `capture-desk-depth` scenario frames, looked at |
| 6 | Erasing a desk with the editor's real controls removes its `pc`; the map saves; placing a `pc` on a desk centres it | browser scenario through the editor panel |
| 7 | Switching template rebuilds the sprites: no sprite of the old map remains, none is missing | browser scenario counts desk and pc sprites against the map |
| 8 | No per-frame cost beyond the sort: frame time with Manor and the browser suite's usual players does not regress measurably | recorded before/after, with hardware stated |
