# Contributing

Thanks for looking. The project is early, so the most useful contributions are careful bug reports, tests and measurements.

## Ground rules

- **English everywhere**: code, comments, commit messages, documentation and issues.
- **Original work only**: do not copy code, maps, sprites or branding from Gather or any proprietary product. Any third-party asset or dependency must have a compatible licence and be listed.
- **License**: contributions are accepted under **AGPL-3.0**, with no additional restrictions on commercial use.
- **Evidence over claims**: do not describe a number as "capacity" unless it was measured, with the environment recorded. Keep measured results, estimates and not-run tests clearly separated.

## Development loop

Every change runs the [gauntlet loop](gauntlet.md): written acceptance criteria, a test seen red first, `scripts/gauntlet.sh` green, and independent critics (UX, invariants, regression) with evidence.

~~~bash
./scripts/dev.sh                 # full local stack
cd server && go vet ./... && go tool staticcheck ./... && go test -race ./...   # server checks and tests
cd web && pnpm exec tsc --noEmit                   # type-check the client
node scripts/oxlint.mjs                            # lint the client and the plugins (type-aware)
cd e2e && pnpm install && node run.mjs             # real-browser suite: own server, fresh database, real LiveKit
~~~

## Invariants worth protecting

1. The server is authoritative; the client sends intent.
2. Never persist movement per step; never send movement per frame.
3. Media authorisation is enforced by the server/SFU. Hiding or muting a video in the UI is not isolation.
4. Every user-visible string goes through the i18n dictionary.
5. Do not log chat content or secrets.
6. Local development and production configuration must stay clearly distinct.

## Office templates

An administrator switches the office to a template from Admin > Office ([decision 0029](decisions/0029-office-templates.md)). Templates are Go code in `server/internal/gamemap/templates.go`, listed in `Templates` from the smallest: `loft` (the starter map, `Default` in `default.go`), `lodge` and `manor`.

**Deriving a new one.** Lodge and Manor are the same generator, `wideOffice`, with other settings in a `wideLayout`:

| Setting | Manor | Lodge | What it changes |
| --- | --- | --- | --- |
| `islandsPerRow` | 4 | 3 | islands of six 3x3 desk zones, two rows of them; sets the open space's width |
| `cornersPerSide` | 3 | 2 | duo and couch corners on each side of the break room's door to the open space |
| `welcomeW` | 7 | 8 | the welcome area's inner width; pick it so the break room has an even width and its door sits in the middle |
| `minis`, `miniW` | 7, 8 | 5, 10 | mini meeting rooms and their inner width; `1 + minis * (miniW + 1)` must equal the hall's width, so their walls run exactly under it |

A new variant is a new function (`func Studio() *Map { return wideOffice(wideLayout{...}) }`) and a line in `Templates`. A different layout gets its own builder; read `wideOffice` first, it is the model.

**Rules the plans follow.** Every wall is one tile and every door a gap of two tiles in it; corridors are two tiles wide. Furniture covers whole tiles. A desk of an island is 3x1 in a 3x3 zone, its chair in the zone's middle; the desk whose seat is above it has `Up: true`, so its desk room is the zone above it. A conversation corner is an open room (`KindRoom`) whose id starts with `corner-`; the template list counts those apart from meeting rooms. Keep rooms reachable from the spawn and leave free rows from door to door.

**Checking it.**

1. `cd server && go test ./internal/gamemap`: every template compiles, every area and desk seat can be walked to from the spawn; add the new template's counts to `TestWideTemplatesMatchThePlans`.
2. `HQ_UPDATE_FIXTURE=1 go test ./internal/gamemap` writes `web/dev/<id>-map.json`; register the fixture in `web/dev/art-preview.ts` and `art-preview.html` like `manor`.
3. `cd web && pnpm exec vite --port 5180`, open `/dev/art-preview.html` and look at the map; `node e2e/export-art.mjs` (with `ART_PREVIEW_URL` pointing there) writes `site/assets/map-<id>.png` once you add its `save` line there. Zoom into the result: desks, chairs, doors and corners are where the plan says.
4. Apply it from Admin > Office in a dev stack (`scripts/dev.sh`) and walk around; the `templates` browser scenario covers switching.

## Pull requests

Keep them focused, include tests for behaviour changes, and update the docs in the same PR. Describe exactly what you ran and what you did not.
