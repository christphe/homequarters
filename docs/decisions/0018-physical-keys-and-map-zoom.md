# 0018: Shortcuts by key position, and a map zoom bounded by a per-player area of interest

Date: 2026-10-14. Status: accepted.

## Context

Shortcuts were matched on `KeyboardEvent.key`, the character a key types. On an AZERTY keyboard W A S D are not where a left hand rests (the Z key typed "z" and danced instead of walking up), and the digit row types `& é " ' ( - è` without Shift, so reactions 1-7 did nothing.

The camera picked one integer scale from the window size (2 to 6) and people asked to see more of the office. The server only sends people inside its area of interest: a square of 2 cells of 128 px around the player's cell, so at least 256 px in every direction. At the automatic scale the visible half of the screen already nearly fills it (1080p: 480 x 270 world px visible), so zooming out on the client alone would show empty edges where people pop in.

## Decision

- **Shortcuts use `KeyboardEvent.code`** (the physical position): movement is KeyW/KeyA/KeyS/KeyD and the arrows, reactions are Digit1-7 (or the keypad while Num Lock is on; without it the keypad types arrows, which move), and X, R, Z, H, M are positions too. `?` stays a character, since it is a symbol and not a position. One-shot shortcuts ignore keys pressed with Shift: Shift is the run key, and on AZERTY "?" is Shift on the M position.
- **The help names keys as printed on the user's keyboard** through `navigator.keyboard.getLayoutMap()` (Z Q S D on AZERTY). Browsers without the Keyboard API (Firefox, Safari) learn the label of each letter position from the keys the user actually presses, and show US names for keys not pressed yet. Digits are always shown as 1-7. The map's accessible name uses the same labels.
- **The mouse wheel over the map changes the world scale** by whole steps (pixel art stays crisp), up to 8, and down to the smallest scale where half the visible map fits the largest interest radius the server grants. One notch is one step: a line-mode event (Firefox) counts once, and pixel deltas (trackpads) add up to 100 px per step, at most one step per event, reset after 300 ms idle. Ctrl+wheel (and trackpad pinch, which browsers report as Ctrl+wheel) stays the browser's page zoom, and the UI is not scaled. The step is remembered per browser in `localStorage`.
- **The camera never shows map farther from the player than the largest radius reaches**, less 24 px kept for a sprite drawn above its feet and for prediction running ahead of the server. Zoomed far out next to a map edge, it stops following the edge and shows a margin beyond the map instead of people the server does not send. When all visible map is within reach (every window at the automatic scale with the defaults) the camera behaves as before. The client asks for the radius with the same 24 px allowance.
- Events without a key position (`code` empty: some virtual keyboards and remote desktops) fall back to the US position of the character they typed.
- **Each player has an interest radius sized to their view.** `hello.cfg` carries `cell`, `aoi` and `aoiMax`. The client computes the radius, in cells, from the player to the farthest visible map pixel (camera clamping at the map's edges included, so it stays steady while walking) and sends `{"t":"view","n":cells}` when it changes. The server clamps it to `[TILEWORK_AOI_CELLS, TILEWORK_AOI_MAX_CELLS]` (default 2 to 8) and resubscribes. The ordinary control-message rate limit applies.

## Alternatives

- A fixed larger radius for everyone: simpler, but every player would pay for the widest view. With 2 cells a player watches 25 cells and with 8 up to 289, so fan-out and downlink in a dense office would grow about 10x.
- Zooming out without touching the server: people appear late at the edges of the screen, which looks broken.
- A far ring updated at a lower rate (network level of detail): cheaper for wide views. Records are already sent only on state changes and extrapolated, so a far walker in a straight line costs little. This remains a follow-up that needs its own before/after measurement.

## Impact

- Performance: unchanged for players at the automatic scale away from map edges (the radius stays 2). Next to an edge the clamped camera shows up to the whole window on one side, so the radius can rise to 3 at the automatic scale; before this change those people were drawn late or not at all. A zoomed-out player receives the records of up to 289 cells (radius 8, at scale 1 the whole default office) instead of 25, on their own downlink, and every move in those cells is fanned out to them. Measured benchmarks (`server/cmd/loadgen`) do not send `view` and are unchanged. Wider views were not benchmarked.
- Maintenance: new shortcuts must match `e.code` and take their help label from `keyLabel()` in `web/src/keys.ts`. The client's radius computation and the server's cell rectangle (`World.rect`) must keep the same cell size and Chebyshev shape.
- The largest radius was first 4 cells (512 px), which stopped a 1920x1080 window at scale 2; it is 8 (1024 px) so scale 1 shows the whole default office.
- Installation: an optional `TILEWORK_AOI_MAX_CELLS` (from `TILEWORK_AOI_CELLS` up to 8, default 8, or `TILEWORK_AOI_CELLS` when that is already wider, so existing installs keep starting). Older clients never send `view` and keep the default radius.
