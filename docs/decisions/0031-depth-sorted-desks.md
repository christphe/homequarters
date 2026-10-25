# 0031: Desks and PCs drawn again over the bake, sorted with the avatars

Date: 2026-10-25. Status: accepted.

## Context

The whole map, furniture included, is baked into one texture under every avatar. A desk rises above its tile (its top, its screen up to 11 px), so somebody standing or sitting behind a desk was drawn over it: legs through the desktop, body over the monitor. The longer-term aim is furniture and the objects on it as real sprites that administrators compose (a laptop, two screens, a chessboard on a table), which needs an editor rework first.

## Decision

- **Sprites over the bake.** Desks and PCs stay in the baked texture. Every desk and every PC also gets a sprite of itself in the entity layer, where avatars, pets and plugin sprites are sorted by the row of their feet. A desk sorts by its front edge (the bottom of its footprint, the rule plugin objects already use); a PC by its desk's plus half a pixel, so it never splits from its desk. Somebody north of a desk is drawn before it and hidden; somebody south of it, after.
- **Cut from the bake.** Each sprite keeps only the pixels where the finished bake shows exactly that object (drawn alone at its map position, so seeded details like a mug match). Where something baked later covers it, the sprite is transparent. With nobody around, the office is pixel-identical to the bake, whatever an administrator put next to a desk.
- **The PC is a prop.** Type `pc`, 1x1, not solid, on a tile of a desk, no other field; it faces the way its desk does. A desk carrying a `pc` is drawn without its built-in screen and keyboard; the bake draws the `pc` right after its desk, at the same pixels. A desk without one (any map saved before this change) keeps its built-in screen: no migration.
- **Visual offsets.** Props gain `dx`, `dy` (pixels, -15 to 15), accepted only on `pc` for now. They move the drawing only; the server never reads them. The templates centre a PC on the desk tile under the desk's centre, the half tile left over as `dx` (8 on a 2-tile desk, 0 on a 3-tile desk).
- **Templates.** Loft (also a new office's map and the demo's), Lodge and Manor put one `pc` on every desk.

## Alternatives

- **Two regimes:** template maps with desks and PCs out of the bake, old maps baked as before. The final shape for new maps, but two rendering paths and a minimap redraw that the editor step would redo.
- **Everything out of the bake now,** with an implicit screen on desks without a `pc`: one path, but more work before the editor exists, and the minimap would need its own picture of the furniture.
- **An "upper layer" (the RPG Maker star tiles):** always over the avatars, so the person sitting in front of a desk would go behind it too; it works for tree tops and lintels, not for furniture one walks around.

## Impact

- **Performance:** a few dozen static sprites (Manor: 96) sharing one atlas texture of at most a few hundred kilobytes, rebuilt only with the bake (map load, editor change, layout switch), never per frame. Measured on 2026-10-25, Windows 11, AMD Ryzen 5 9600X, Chrome 156 headless with software GL (SwiftShader), Manor, 1280x720, one moving avatar forcing a re-sort every frame, 5 runs of 500 frames each way: 7.6 ms per frame with the sprites, 7.7 ms without (medians), so no measurable difference. Not measured: a real GPU, a phone, a crowd.
- **Memory:** the bake still holds desks and PCs, so the atlas is extra (below 1 MB for the Manor). It goes away when desks leave the bake.
- **Maintenance:** one painter per object serves both the bake and the sprites (`drawObject` in `tiles.ts`), the cut is in `art/objects.ts`. Covered by Go tests (validation, placement, templates), web unit tests (placement, erasing) and the `depth` browser scenario (pixel identity with and without sprites, depth north and south of front and turned desks, editor, layout switch); `capture-desk-depth` films it for review.
- **Install:** none. No migration; the map format gains optional fields.
- **Next:** the editor rework (dragging, snapping, offsets by hand) takes desks and PCs out of the bake, other furniture follows type by type, and plugin objects (the chessboard) join the same rules.
