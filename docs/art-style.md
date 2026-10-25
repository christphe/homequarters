# Art style

Home Quarters looks like a 2000s handheld RPG: a top-down 3/4 view, 16 px tiles, chunky characters with big heads, outlined props with three-tone shading, and white dialog-window menus. The goal is that style, **not** any existing game's assets.

> **Original work only.** Every tile, prop, sprite, colour and UI frame is drawn by code in this repository. We do not use, trace, extract or re-colour assets from Pokémon or any other Nintendo, Game Freak or third-party game, and the project has no affiliation with them. A visual *style* (proportions, palette feel, pixel conventions) can be studied; assets and characters cannot be copied. See also [Contributing](contributing.md).

## Rules of the look

| Aspect | Rule |
| --- | --- |
| Tile size | 16 x 16 px; the map is baked into one texture |
| Camera | integer zoom only (nearest-neighbour), reference view about 320 x 200 world px (20 x 12.5 tiles); a 240 x 160 handheld screen would show 15 x 10. The mouse wheel moves the scale by whole steps (decision 0018) |
| Light | from the top-left: a light top/left edge, a darker bottom/right edge |
| Outlines | every prop and character has a 1 px dark outline, never pure black; on characters it is a very dark version of the neighbouring colour, so hair, skin and clothes stay distinct |
| Shading | three tones per material; highlights drift warm, shadows drift toward violet |
| Walls | banded face: cream upper wall, a coloured stripe that matches the room's floor, a wooden wainscot and baseboard; a flat dark ceiling cap on thick walls; contact shadow on the floor below |
| Floors | beveled pale plates with joint lines (reception), fine diagonal hatching on pale blue (desks), wide ochre planks with staggered joints (social area), dithered carpets with a dotted border band (meeting rooms); a doorway (a gap in a wall) continues the floor of the room next to it |
| Characters | 16 x 24 px body in an 18 x 30 cell (a 1 px outline margin and 4 rows on top for hats and tall hair); a 12 x 11 head (over half the sprite height), a 5-row torso and short legs; low-set eyes with a light blush; four directions, idle plus two walking frames; "right" is the mirrored "left" |
| UI | white message frames with a coloured ring and dark lines on both sides; cream panels with an orange header tab; blue message strips; pill buttons with hard shadows; a black triangle cursor; teal scanline background on the join screen; a lavender name plate when entering an area |
| Font | Jersey 10 (SIL Open Font License 1.1), bundled in `web/src/assets/fonts` with its licence. One weight; the interface scales it with `font-size-adjust`, and map text uses 20 px (twice its 10 px grid) so it stays crisp |

## Where the code lives

~~~text
web/src/game/art/pixel.ts        helpers: hue-shifted shading, deterministic hash, outlined slabs and blobs
web/src/game/art/tiles.ts        floors, walls, doorways, furniture, rugs and the whole-map baker
web/src/game/art/characters.ts   character painter, walk frames, per-cell outline, sheet builder
web/src/game/palette.ts          skin, hair, shirt and trouser palettes
web/src/game/avatars.ts          turns a sheet into cached PixiJS textures
web/src/game/mapArt.ts           turns the baked canvas into a texture
web/src/theme-gba.css            the dialog-window UI skin (overrides styles.css)
web/dev/art-preview.*            server-free preview page and the export used by the website
~~~

The painters are plain canvas code with no PixiJS dependency, so they can be previewed and exported without running the game.

## Preview and iterate

~~~bash
cd web && pnpm exec vite --port 5180
# open http://127.0.0.1:5180/dev/art-preview.html?s=8   (sprites at 8x, map at 4x)
~~~

To refresh the images used by the README and the website:

~~~bash
cd e2e
node export-art.mjs   # sprite sheets and the baked map (needs only the Vite preview above)
node art.mjs          # cast and walking GIF (needs Chrome and ffmpeg)
# in-game shots (needs a game server that serves the built client):
HQ_APP=http://127.0.0.1:8091 HQ_API=http://127.0.0.1:8091 node screens.mjs
# social banner (site/assets/banner.png, the og:image), from a real in-game scene:
CHROME=/path/to/chrome node banner.mjs   # SKIP_BUILD=1 reuses web/dist and bin/; HQ_BANNER_PORT (38090)
~~~

`banner.mjs` builds the client and the server, starts its own server on a free port with a fresh database in the temp dir and no media (LiveKit points at a closed port and nobody opts in, so no camera or microphone is touched). An administrator assigns desks to named people through the map API, nine players with varied looks (beards, hats, a hijab) and pets take their places (two talking at a desk, others at their desks, two walking down the aisle with their pets trailing), and an observer outside the frame captures the world only at 3x: UI, area labels and the players' name tags hidden except for the two walkers, desk owner labels kept. The 768x640 crop sits 1:1 beside a solid navy panel with the wordmark (Schibsted Grotesk 800, mint) and "The open source virtual office you host yourself". Look at the result before committing: the walkers' place depends on timing (`BANNER_WALK_MS`).

`web/dev/default-map.json` is a copy of the starter map from the Go server (`gamemap.Default()`); refresh it if that map changes.

## Adding things

- **A prop**: add its size to the dimensions table and a painter in `tiles.ts`, register the type in the Go map validator (`server/internal/gamemap`), and keep it solid or not in the Go table.
- **A hairstyle, beard or hat**: add its id to `HAIR_STYLE_IDS`, `BEARD_IDS` or `HAT_IDS` in `characters.ts` and draw it in every view: `hairFront`/`hairBack`/`hairSide`, `beardFront`/`beardSide` (no beard from the back), or the three views of `hat` (the side view faces left; the right is mirrored). Add its label to `web/src/i18n.ts` (`hair.<id>`, `beard.<id>`, `hat.<id>`); the editor lists every id. Widen `nHair`, `nBeard` or `nHat` in `server/internal/httpapi/avatar.go`, or the server turns the new value back into 0. Content rows down to y = -6 are drawable above the head (the party hat's pompom and the top hat's crown reach it); name tags rise only when a drawing does. Under any hat, hair above the crown (y < 1) is clipped. Beards use the hair colour; hats use their own colour from `HAT_COLORS`.
- **Check the result**: the art preview shows a wardrobe with every hair style, beard and hat in the four directions. The ten looks above it are pixel goldens: `node e2e/export-art.mjs` must leave `site/assets/sheet-*.png` unchanged.
- **A floor**: add an entry to the `FLOORS` table in `tiles.ts` and use its name in the map's areas.
