# 0012 · Getting around faster, companions and better screen sharing

- **Status:** accepted (2026-09-30)

## Context

Large offices are slow to cross at walking speed, and finding a colleague meant locating them and then walking by hand. Pets are a well-loved personal touch in virtual offices. Screen sharing worked but showed the screen only as a small tile at 720p, too small for code or documents.

## Decision

- **Running.** The input message carries a run flag (`b`). The server moves a running player at `RunMul` (2x) the walking speed and publishes the run state as bit 6 of the state record, so observers extrapolate at the right speed with the same dead-reckoning rule. A run change while moving is published at once. Shift inverts an "always run" toggle (R or a HUD button), so both habits work.
- **Walk to.** `go` with a tile (double-click the map) or a player id (people panel) reuses the follow machinery: one breadth-first search on the server over tiles the player may enter, portals avoided, then the server steers at run speed. The path is computed once for a tile; a closed door aborts with `go ok:false`. The search keeps out of rooms (meeting rooms, offices, desk rooms) other than the start and destination areas, so a walk does not cut through somebody's call: it crosses as few of their tiles as it must, then takes the shortest way. It is still one linear pass, run in levels of how many such room tiles were crossed (crossing a room joins its call briefly; open areas are not avoided, since a proximity group needs a 500 ms dwell). `BenchmarkFindPath` on the default map (Windows 11, 12 threads, base and new code run back to back): a route around a room takes about 13.5 µs (12 µs before), and one that must cross a room about 62 µs (10 µs before), because the search first visits the whole room-free part before it crosses; a follow re-searches at most every 400 ms per follower, capped at 64. Any movement key cancels. Guided movement snaps the cross axis onto the lane when within one step, so faster steps cannot catch wall corners, and the final resting position is sent to the walker.
- **Pets.** A pet is one more avatar field (`pt`, clamped by the server). It is cosmetic and **client-side only**: each client animates the pet of every visible avatar behind its owner, so pets cost zero bandwidth, zero server CPU and no protocol messages. Eight species are drawn by code in `web/src/game/art/pets.ts`. *Update 2026-10-18: the built-in pet and the `pt` field were removed. Pets are the bundled plugin `hq-pets` ([decision 0022](0022-plugins.md)), which draws the same species, several per member; the following logic (`petFollow.ts`) is the plugin layer's.*
- **Screen sharing.** Screens are captured at up to 1080p/15 fps with simulcast layers at 360p/3 fps and 720p/5 fps; adaptive stream picks the layer from the rendered size, so the small dock tile stays cheap and only an expanded or full-screen view pulls 1080p. Each shared screen can be expanded over the map, put in full screen or in picture-in-picture, and the presenter's avatar shows a screen badge to the people in the call.

## Consequences

- Performance: running doubles the distance per tick but not the message rate; walk-to adds one bounded search per request (bounded by `maxFollowers` concurrent guided walks). Pets add one sprite per visible avatar and no network traffic. A 1080p screen share costs more upstream for the presenter; receivers of small tiles get the low layers.
- Maintenance: protocol tests cover the run bit, the shadow agreement while running, walk-to arrival, cancellation and refusals; the `movement` and `rooms` browser scenarios cover the UI paths.
- Install: none.

