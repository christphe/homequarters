# Desks and PCs as depth-sorted sprites: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. AGENTS.md's gauntlet applies on top: brief in `.gauntlet/map-objects-depth.md`, red checks first, `scripts/gauntlet.sh` to `GATES GREEN`, critics.

**Goal:** avatars behind a desk are hidden by the desk and its PC; the PC becomes its own `pc` prop; props gain a visual `dx`/`dy`.

**Architecture:** the baked map texture is unchanged in look (desks and PCs stay baked). On every bake, the view also builds one sprite per desk and per `pc` from a small atlas, masked to the pixels the finished bake really shows of that object, and puts them in `entLayer` with `zIndex` = the desk's front edge row, so the existing feet-based depth sort hides avatars behind them.

**Tech Stack:** Go (server `gamemap`), TypeScript + PixiJS 8 (web), the e2e browser runner (`e2e/run.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-25-map-objects-depth-design.md`

## Global Constraints

- `dx`, `dy`: integers in pixels, each in `[-15, 15]`, accepted only on `pc`; they move only the drawing. Gameplay code (collision, reach, desk rooms, `CarryDesks`, `Summarize`, desk taking) never reads them or `pc`.
- `pc`: `propDefaults` `{1, 1, false}`; must stand on a tile of a desk's footprint; no `Data`, `To`, `Assign`, `Label`, `Up`, `W`, `H`.
- Template PC placement for a desk of width `w`: `X = desk.X + (w-1)/2`, `Y = desk.Y`, `dx = 8` if `w` even else `0`, `dy = 0`.
- With nobody near, the render is pixel-identical with and without the sprite layer, and a map's bake with `pc` props equals its bake with them stripped (old-style desks).
- No per-frame work added; sprites and atlas are rebuilt only with the bake and destroyed with it.
- All art drawn in code in `web/src/game/art`; new UI strings in `web/src/i18n.ts`; everything in English.
- No migration of saved maps.

## Review Focus

- A desk with a plant, lamp or chair on the row below whose art overlaps it: the sprite must not cover the neighbour (masking). Test: fixture map in Task 6.
- A `pc` whose desk is erased in the editor: the `pc` goes too, the save succeeds. Test: Task 5.
- A map edit or template switch while sprites exist: no stale sprite, no leaked texture. Test: sprite count after switch in Task 6.
- Desks wider than 3 tiles in an admin map (allowed by `Validate` up to 32): the placement formula keeps `dx` at 0 or 8. Test: Task 1 table row with a 4-wide desk.
- Two avatars, one north and one south of the same desk: the north one hidden, the south one in front. Test: capture in Task 6.

---

### Task 1: Map format (`pc`, `dx`, `dy`)

**Files:**
- Modify: `server/internal/gamemap/map.go` (Prop struct, constants, `propDefaults`, `Validate`)
- Test: `server/internal/gamemap/features_test.go` (or a new `pc_test.go` in the package)

**Interfaces:**
- Produces: `Prop.DX`, `Prop.DY` (`int`, `json:"dx,omitempty"` / `json:"dy,omitempty"`); `const PropPC = "pc"`; `func PCOn(desk Prop) Prop` returning the centred `pc` for a desk per the Global Constraints formula; `func OnDesk(m *Map, x, y int) bool` (tile inside some desk's footprint).

- [ ] **Step 1: Write `TestValidatePC`**, table-driven on a small valid map with one 2-wide desk at (2,2) and one 4-wide desk at (2,5). Rows (want ok / want error substring):
  - `pc` at (2,2) dx 8 → ok; `pc` at (3,2) → ok; `pc` at (2,3) (floor) → error `"pc"` and `"desk"`.
  - dx 16 → error; dy -16 → error; dx -15 → ok.
  - `chair` with dx 1 → error.
  - `pc` with `Label`, `Up`, `W: 2`, `Assign`, `Data`, `To` → error each.
- Also `TestPCOn`: `PCOn({desk 2-wide at 4,7})` = `{pc, X:4, Y:7, DX:8}`; 3-wide → `X:5, DX:0`; 4-wide at 0 → `X:1, DX:8`; `Up` desk gives the same placement.
- [ ] **Step 2: Run** `cd server && go test ./internal/gamemap -run 'PC' -v` → FAIL (undefined `PropPC`).
- [ ] **Step 3: Implement** the fields, `PropPC` in `propDefaults` `{1, 1, false}`, `PCOn`, `OnDesk`, and the `Validate` rules (offset range and type check for every prop; a `case PropPC:` for support and forbidden fields).
- [ ] **Step 4: Run** `go test -race ./internal/gamemap ./internal/world` → PASS (wire form already passes the new fields through `marshalWire`).
- [ ] **Step 5: Commit** `Map format: a pc prop and visual offsets`.

### Task 2: Templates carry a PC per desk

**Files:**
- Modify: `server/internal/gamemap/templates.go` (the `Templates` list), `default.go` only if `Default` is used outside `Templates` for new offices (check callers of `Default()`; new offices must get PCs too).
- Test: `server/internal/gamemap/templates_test.go`

**Interfaces:**
- Consumes: `PCOn`, `PropPC` (Task 1).
- Produces: `func withPCs(build func() *Map) func() *Map` wrapping every template's `Build` (and the new-office default), appending `PCOn(d)` for each desk after the existing props.

- [ ] **Step 1: Write `TestTemplatesPutAPCOnEveryDesk`**: for each template, `Compile` succeeds, the number of `pc` props equals the number of desks, and each desk has exactly one `pc` equal to `PCOn(desk)`. Extend the existing `CarryDesks`/`Summarize` tests' expectations only if they change (they must not).
- [ ] **Step 2: Run** `go test ./internal/gamemap -run Templates -v` → FAIL (0 pcs).
- [ ] **Step 3: Implement** `withPCs` and wrap `Default`, `Lodge`, `Manor` in `Templates` and wherever a new office gets its first map.
- [ ] **Step 4: Run** `go test -race ./...` from `server` → PASS.
- [ ] **Step 5: Commit** `Templates: every desk carries a PC`.

### Task 3: Protocol, model and PC art in the bake

**Files:**
- Modify: `web/src/net/protocol.ts` (`Prop.dx?`, `Prop.dy?`), `web/src/game/mapModel.ts` (`PROP_TYPES` gets `{ t: "pc", w: 1, h: 1, solid: false, label: "PC" }`), `web/src/game/art/tiles.ts`, `web/src/i18n.ts` (`prop.pc`), `docs/protocol.md`.
- Check: `web/dev/art-preview` still renders.

**Interfaces:**
- Produces, in `tiles.ts`:
  - `export function deskOf(props: Prop[], p: Prop): Prop | undefined`: the desk whose footprint holds `p`'s tile.
  - `export function drawObject(ctx: Ctx, p: Prop, props: Prop[]): void`: draws a `desk` (honouring whether a `pc` stands on it) or a `pc` (front or back from its desk's `up`, at `propRect(p)` shifted by `dx`, `dy`) at absolute map pixels. Used by the bake and by Task 4's atlas.
  - `DEPTH_OBJECTS = new Set(["desk", "pc"])`.

- [ ] **Step 1: Red check.** Write Task 6's `depth.mjs` now (its checks are the seams for Tasks 3-5) and run `node run.mjs depth`: checks 1, 3, 4 and 5 go red (no depth sprites, no `pc` placement). Check 2 must also be shown sensitive: shift a `pc`'s `dx` by 1 in the page and see the bake diff become non-zero.
- [ ] **Step 2: Implement** `desk(ctx, x, y, w, withPC)` / `deskUp(...)`: with a PC, body and mug only. Split today's screen+keyboard drawing into `pcFront(ctx, cx, y)` / `pcBack(ctx, cx, y)` called by both the old path and the `pc` path, so pixels are the same by construction (`cx` = the pc's tile centre + `dx`, equal to the desk's `x + w/2` for template placement).
- [ ] **Step 3:** In `bakeMapCanvas`, the furniture pass draws each `pc` right after its desk (sort key: the desk's bottom row, then desks before pcs).
- [ ] **Step 4: Run** `cd web && pnpm exec tsc --noEmit && pnpm exec vite build` → clean; the Step 1 diff → 0 pixels; `node scripts/lint-web.mjs` → clean.
- [ ] **Step 5: Commit** `PC art: a pc prop drawn on its desk, same pixels as before`.

### Task 4: Depth sprites in the world view

**Files:**
- Create: `web/src/game/art/objects.ts` (atlas + masking, pure canvas)
- Modify: `web/src/game/WorldView.ts` (`setMap`, teardown, test hooks)

**Interfaces:**
- Consumes: `drawObject`, `DEPTH_OBJECTS`, `deskOf`, `propRect` (Task 3).
- Produces:
  - `export interface DepthPiece { sx: number; sy: number; w: number; h: number; x: number; y: number; z: number }` (atlas rect, world position, `zIndex`).
  - `export function depthAtlas(map: MapData, baked: HTMLCanvasElement): { canvas: HTMLCanvasElement; pieces: DepthPiece[] }`.
  - `WorldView.debugDepth(): { desks: number; pcs: number }` and `WorldView.setDepthVisible(on: boolean)` for tests.

- [ ] **Step 1: Implement `depthAtlas`.** For each desk and `pc`: draw it alone with `drawObject` on a scratch canvas translated so absolute map pixels (and therefore `hash` seeds) match the bake; the drawn box is the prop rect extended upward by 16 px (screen and rise). Keep a pixel only where its alpha is non-zero **and** the baked canvas has the same RGBA at that map pixel; clear the rest. Pack the results into one atlas canvas (rows, no padding needed with `nearest`). Cache identical cells by content key (type, width, `up`, mug seed, with-pc, mask unchanged) so unmasked desks share cells. `z` = world-pixel row of the desk's bottom edge (`(desk.y + h) * 16`) for a desk, the same plus `0.5` for a pc. Adjust the row only after looking at Task 6's frames, and say so in the commit.
- [ ] **Step 2: Wire into `setMap`.** After the bake: destroy the previous depth sprites and atlas texture (`destroy({ texture: true, textureSource: true })`), build `depthAtlas(map, this.baked)`, one `Texture` from its canvas (`scaleMode = "nearest"`), one `Sprite` per piece with a frame `Rectangle`, positioned at integer world pixels, `zIndex = piece.z`, added to `entLayer`. Nothing in `frame()` touches them.
- [ ] **Step 3: Run** `pnpm exec tsc --noEmit`, `vite build`, `node scripts/lint-web.mjs` → clean.
- [ ] **Step 4: Commit** `Depth: desks and PCs drawn as sprites sorted with avatars`.

### Task 5: Editor (minimal)

**Files:**
- Modify: `web/src/ui/MapEditor.tsx` (prop placement, erase)

**Interfaces:**
- Consumes: `PCOn` logic mirrored on the client: a `pcOn(desk: Prop): Prop` in `web/src/game/mapModel.ts` with the Global Constraints formula.

- [ ] **Step 1:** Prop tool with `pc`: on a desk tile, push `pcOn(desk)` unless that desk already has one at that place; elsewhere, do nothing.
- [ ] **Step 2:** Erase: unchanged order (last prop first, so a `pc` goes before its desk); when the removed prop is a desk, also remove every `pc` whose tile is in its footprint.
- [ ] **Step 3: Run** `tsc`, `vite build`, lint → clean. Behaviour is checked in Task 6.
- [ ] **Step 4: Commit** `Editor: place a PC on a desk, erasing a desk takes its PC`.

### Task 6: Browser evidence

**Files:**
- Create: `e2e/scenarios/depth.mjs` (added to `all` in `e2e/run.mjs`), `e2e/scenarios/capture-desk-depth.mjs` (not in the default suite), a fixture map with a plant and a chair on the row below a desk, overlapping it (in the scenario or `e2e/fixtures/`).
- Modify: `web/src/game/WorldView.ts` only if a snapshot hook is needed: `debugWorldPixels(opts: { depth: boolean }): Promise<Uint8Array>` rendering `world` with entities, labels and HUD hidden.

- [ ] **Step 1: Write `depth.mjs` checks** (each through the real app; restore the office map at the end as `templates.mjs` does):
  1. For the saved default map without `pc` (PUT it stripped), Manor (template switch through the admin API), and the overlap fixture: `debugWorldPixels({depth:false})` equals `debugWorldPixels({depth:true})` byte for byte.
  2. Manor's bake equals Manor-stripped's bake (via the art function in the page) byte for byte.
  3. After the switch, `debugDepth()` equals `{ desks: 48, pcs: 48 }` for Manor and matches the desk count after switching back.
  4. Editor through its panel: select the erase tool, click a desk's tile twice → its `pc` then the desk are gone, the map saves (no error toast), and no `pc` remains on that footprint; prop tool `pc` on a desk → a `pc` at the centred place.
  5. Depth: walk an avatar to the tile north of a front-facing desk and to the chair north of a turned desk; read back the pixels at the desk's screen position: they equal the bake's (screen visible over the avatar). South of a desk: they differ from the bake (avatar in front).
- [ ] **Step 2: Red** was recorded in Task 3 Step 1 (the scenario is written there, before the client work).
- [ ] **Step 3: Run after Tasks 1-5** `cd e2e && node run.mjs depth` → green.
- [ ] **Step 4: Write `capture-desk-depth.mjs`** after `capture-plugin-pet.mjs`: Manor at 3x, two avatars north and south of an island, one walking along the back row; frames plus a contact sheet. Look at it; fix the `z` row in `objects.ts` if a foot or head pops wrongly.
- [ ] **Step 5: Measure** criterion 8: `node run.mjs perf` with the same `PERF_BOTS`/`PERF_SECONDS` on the baseline and on the branch, on the same machine; record frame time and hardware in the ADR. Report "not measured" if it cannot run.
- [ ] **Step 6: Commit** `e2e: depth scenario and desk depth capture`.

### Task 7: Docs and changelog

**Files:**
- Create: `docs/decisions/0030-depth-sorted-desks.md` (context, approach A vs B vs C, masking, atlas memory, per-frame impact with the Task 6 measurement, path to the editor step; note the chess spec must renumber its ADR).
- Modify: `docs/protocol.md` (if not done in Task 3), `docs/art-style.md` (bake plus depth sprites; `objects.ts` in the file list), `docs/status.md`, README status table, `site/build.mjs` only if the ADR list needs registering, `server/CHANGELOG.md` via `fchange changed "People behind a desk are hidden by it and its screen (#N)" --pkg server` and `fchange added "A PC object stands on desks; the office layouts put one on every desk (#N)" --pkg server`.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2: Run** `cd site && node build.mjs && node check.mjs` → clean.
- [ ] **Step 3:** `scripts/gauntlet.sh` (whole suite) → `GATES GREEN`; then the critics per `.agents/skills/gauntlet/SKILL.md`.
- [ ] **Step 4: Commit** `Docs: depth-sorted desks (ADR 0030), status, changelog`.
