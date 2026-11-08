# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. Read it fully before changing anything.

## What this project is

**Home Quarters** is an open source 2D virtual office inspired by the classic Gather experience: pixel-art avatars, proximity audio/video, meeting rooms, chat, screen sharing. Its differentiator is **efficiency** in CPU, RAM, GPU and bandwidth, on the browser and on the server, so it can run on cheap infrastructure with capacity that is **measured and documented**.

It is **not** affiliated with the original Gather product. Never copy its brand, maps, sprites or code.

## Every change runs the gauntlet

Build against written acceptance criteria, reproduce behaviour failures with **red** checks, get `scripts/gauntlet.sh` to `GATES GREEN`, then let independent **critics** (UX, invariants, regression) inspect it, and repeat until no blocker or major is open. Follow [`.agents/skills/gauntlet/SKILL.md`](.agents/skills/gauntlet/SKILL.md) for every feature, fix, refactor or review; it defines proportional evidence for documentation and review-only work. The reasons are in [`docs/gauntlet.md`](docs/gauntlet.md). Look at the frames for anything a person sees: a passing metric once approved a pet that was glued to its owner.

## Releases

Two products are released separately from this repository, each with its own changelog and tags: the **server** (Go server, web client, Docker image; `server/CHANGELOG.md`, tags `server-vX.Y.Z`) and the **desktop app** (`desktop/CHANGELOG.md`, tags `desktop-vX.Y.Z`). To make a release, follow [`.claude/skills/release/SKILL.md`](.claude/skills/release/SKILL.md) (also the `/release` command in Claude Code): the changelog is written in the [Keep a Changelog](https://keepachangelog.com) format with `fchange` and `frelease` ([fantastic-change](https://github.com/fantastic-jam/fantastic-change)), the version is tagged, and the GitHub release follows with the Docker image or the desktop builds.

**Every pull request that changes behaviour carries its own changelog entry.** A feature, a fix, a change in configuration, the protocol or the plugin API: add it under `## [Unreleased]` of the product it changes with `fchange <added|changed|fixed|...> "<one sentence> (#N)" --pkg server` (the server or the web client) or `--pkg desktop` (the desktop app), one entry in each when it changes both, and commit it in the pull request before it is merged (wording rules in section 2 of the release skill). A pull request that only touches CI, tests, refactors or docs gets no entry, unless it changes something for operators (a new migration, image tag or requirement).

## Language rule

**Everything is in English**: code, comments, identifiers, commit messages, PR text, issues, README, docs, site copy, error messages and generated art text. (The player-facing UI is English, the only shipped locale, and goes through the i18n dictionary in `web/src/i18n.ts`; new user-visible strings must go there, never inline.)

## Repository map

| Path | What lives there |
| --- | --- |
| `server/` | the Go server: each folder below is a Go module of its own (`go.mod` requiring the libraries it imports, `replace`d by their folders; no go.work; [decision 0041](docs/decisions/0041-go-module-per-library.md)) and an fdash project named after it |
| `server/cmd/homequarters` | entry point (fdash project `server`); `homequarters testbed` starts the plugin testbed (`testbed.go`) |
| `server/internal/world` | authoritative simulation: movement, spatial grid, areas of interest, proximity groups, backpressure, stats |
| `server/internal/gamemap` | map format, validation, collision grids, default office |
| `server/internal/media` | LiveKit access tokens and participant removal |
| `server/internal/store` | SQLite (WAL), embedded migrations, sessions, members, invites, chat history, admin audit log |
| `server/internal/httpapi` | routes, admin API (`admin.go`), WebSocket session, rate limits, Prometheus metrics |
| `server/internal/config` | environment configuration and production guard rails |
| `server/internal/plugin` | operator-installed plugins: catalog, TypeScript compiled by esbuild and run by QuickJS, limits ([`docs/plugins.md`](docs/plugins.md)) |
| `server/internal/testbed` | the real server for tests: dev mode, no LiveKit, a throwaway database, the given plugin folders enabled, test-only endpoints under `/api/testbed/` that only it registers ([decision 0037](docs/decisions/0037-test-pyramid.md)) |
| `web/src/game` | PixiJS world: `WorldView.ts` orchestrates layers (`layer.ts`; `mapLayer`, `avatarLayer`, `objectLayer`, `pluginLayer`, `hudLayer`, `labelLayer`), `localPlayer.ts`, `input.ts`, `camera.ts`; avatar textures, map texture |
| `web/src/game/art` | pure-canvas painters: `pixel.ts` helpers, `tiles.ts` floors/walls/props/map baker, `characters.ts` sprites |
| `web/src/theme-gba.css` | dialog-window UI skin layered over `styles.css` |
| `web/dev` | server-free art preview page and its map fixture |
| `web/src/media` | LiveKit room management |
| `web/src/plugins`, `web/src/game/pluginLayer.ts` | plugin iframes (SDK, command validation, host) and the sprites they draw |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | the pnpm workspace: one install at the root for every TypeScript project; the root declares no dependency, each project declares its own tools, shared versions sit in the `catalog` ([decision 0038](docs/decisions/0038-pnpm-workspace-vitest.md)) |
| `plugins/` | `bundled/`: the plugins shipped in the image (`hq-*`, like `hq-pets`), each an fdash project with its unit (`test/*.test.ts`) and integration (`*.ispec.ts`) tests; `sdk/`: the plugin API's type declarations and `testbed.ts`, the integration tests' client |
| `plugins/e2e/` | a browser test project per bundled plugin (`hq-chess-e2e`, `hq-cards-e2e`, `hq-card-pouilleux-e2e`, `hq-card-lastcard-e2e`), run by `e2e/plugin-run.ts` against the testbed, without LiveKit; not shipped in the image |
| `web/src/ui` | React UI (panels, dialogs) |
| `web/src/session.ts` | glue between socket, world view, media and store |
| `e2e/` | real-browser test suite (`run.ts` + `scenarios/`), the plugin e2e runner (`plugin-run.ts`) and art generation |
| `bench/`, `server/cmd/loadgen`, `scripts/bench.sh` | benchmarks: scripts, raw results, WebSocket load generator, cost model |
| `tools/fdash`, `fdash-workspace.json`, `*/fdash.json` | fdash, the task runner under the gauntlet: projects, their tasks (conventional names: `build`, `lint`, `test:unit`, `test:integration`, `test:e2e`) and inputs, a cache of passes and of builds' outputs in `.fdash/` ([decision 0035](docs/decisions/0035-fdash.md), [decision 0037](docs/decisions/0037-test-pyramid.md), `tools/fdash/README.md`) |
| `desktop/` | desktop app (Tauri 2, Rust) around the system web view: offices page in `ui/`, shell in `src-tauri/` ([`docs/desktop.md`](docs/desktop.md)); `e2e/desktop/` probes its web view |
| `deploy/` | Dockerfile, Compose (local and production), Caddyfile, production README |
| `site/` | landing page and docs generator (GitHub Pages) |
| `docs/` | documentation sources (`docs/decisions/` holds ADRs) |

## Commands

~~~bash
pnpm install                              # at the root, once: the whole repository is one pnpm workspace (pnpm-workspace.yaml, one pnpm-lock.yaml); each project declares its own tools, shared versions sit in the workspace's catalog
./scripts/dev.sh                          # LiveKit (dev) + Go server + Vite; logs in .run/
node tools/fdash/cli.ts run lint test:unit --pkg world   # one Go library (one module each, decision 0041): golangci-lint and race tests; --pkg server is the command (server/cmd/homequarters)
cd server/internal/world && go test -race ./...   # the same by hand, inside the library's module (there is no go.work; server/ itself is no module)
node scripts/gauntlet.ts [scenario ...]  # all gates through fdash (or scripts/gauntlet.sh): the workspace's default, i.e. lint, build and test:unit of every project (golangci-lint, repository linters, race tests, tsc, oxlint, protocol docs, builds, unit tests, site), then every test:integration, then every test:e2e (browser suite and plugin e2e projects, E2E_VIEWPORT=small, CI's 800x450); scenario names run only those of e2e/ and leave the plugin e2e projects out; what already passed on the same inputs is CACHED (FDASH_FORCE=1 reruns all), static gates run FDASH_JOBS at once
node tools/fdash/cli.ts list             # the tasks of fdash-workspace.json and each project's fdash.json (tools/fdash/README.md)
node tools/fdash/cli.ts run test:unit    # a conventional task (build, lint, test:unit, test:integration, test:e2e) in every project defining it; --pkg <project> restricts (repeatable)
node tools/fdash/cli.ts run build test:integration       # names run as stages: every build, then every integration test (they need bin/homequarters; nothing builds it for them)
node tools/fdash/cli.ts run test:e2e --pkg hq-chess-e2e  # a plugin's browser tests against the testbed (needs bin/ and web/dist: run build --pkg server --pkg web first)
cd plugins/bundled/hq-chess && pnpm exec vitest run --project hq-chess:integration   # a plugin's integration tests directly (needs bin/homequarters[.exe], or HQ_BIN pointing at a binary)
node scripts/oxlint.ts [folder ...]     # Oxlint, type-aware, on the folders given (each project's lint runs it on its own) or on web/, the plugins and the tooling (e2e/, scripts/, tools/fdash/, site/, the desktop scripts) (.oxlintrc.json; decision 0033), with the project's rules in scripts/oxlint-hq.ts (effects return a cleanup or nothing, UI text through t(), dialogs through Modal, no fetch in web/src/ui)
node scripts/check-protocol-docs.ts     # docs/protocol.md lists every message of ws.go's dispatch and of protocol.ts
node tools/fdash/cli.ts run lint --pkg hq-chess   # a plugin's lint: tsc on each of its tsconfig.json and oxlint on its folder (e2e's lint checks e2e/fixtures/plugins/)
cd server/internal/world && go tool -modfile=../../../tools/go/golangci-lint/go.mod golangci-lint run ./...   # world:lint: golangci-lint (.golangci.yml, decision 0040), pinned in tools/go/golangci-lint
node tools/fdash/cli.ts run lint:repo     # actionlint+zizmor, gitleaks, shellcheck, hadolint, lint:go-versions (scripts/lint-repo.ts; binaries pinned in tools/go/ and scripts/tools.ts)
node scripts/lint-repo.ts go-versions [--fix]   # one version of each third-party Go module across the server's go.mod files (go work sync in a go.work outside the tree)
node tools/fdash/cli.ts run lint:vuln     # govulncheck on each Go module of the server (needs the network)
node tools/fdash/cli.ts run lint:rust     # cargo fmt --check and clippy on the desktop shell (needs Rust; MSVC on Windows)
cd web && pnpm exec tsc --noEmit && pnpm exec vite build
node tools/fdash/cli.ts run test:unit --pkg web  # one project's unit tests through fdash (cached); every TypeScript test runs under Vitest, each project with its own vitest.config.ts whose project is named after the fdash project
cd web && pnpm exec vitest run           # web's unit and component tests directly (Vitest on Node; component tests `*.test.tsx` start with `// @vitest-environment jsdom`, React Testing Library; type-checked by web/tsconfig.test.json)
cd plugins/bundled/hq-chess && pnpm exec vitest run --project hq-chess   # a plugin's unit tests (its test/ folder; view modules on jsdom); scripts/ and e2e/ (shards, slots): `pnpm exec vitest run` in the folder
node --test 'tools/fdash/test/*.test.ts'  # fdash's own tests stay on Node's runner (it has no dependency and starts everything else)
cd e2e && node run.ts                    # real Chrome + real LiveKit; takes an e2e slot, builds, starts its own server (fresh database) and LiveKit
cd e2e && E2E_PARALLELISM=2 node run.ts   # the whole suite as 2 shards at once, each with its own server, LiveKit and Chrome (gauntlet.sh passes it on)
cd e2e && node run.ts --shard 2/4         # one of 4 duration-balanced shards (e2e/shards.ts); CI runs one job per shard
cd e2e && HQ_EXTERNAL_URL=http://127.0.0.1:8080 node run.ts   # same scenarios against a running stack (e.g. Docker Compose)
cd site && node build.ts && node check.ts # builds site/dist, then checks links, SEO metadata, sitemap, llms.txt and README links
~~~

Art (output goes to `site/assets/`; details in `docs/art-style.md`):

- Preview: `cd web && pnpm exec vite --port 5180`, then open `/dev/art-preview.html?s=8`.
- `e2e/export-art.ts`: sprite sheets and the baked map from the art code (needs only the Vite preview).
- `e2e/art.ts`: cast and walking GIF. Standalone (Chrome + ffmpeg only).
- `e2e/banner.ts`: social banner from a real in-game scene; builds and starts its own server (port 38090, temp database, no media).
- `e2e/export-icons.ts`: the installed-app icons in `web/public/icons` from the favicon. Standalone (Chrome only).
- `e2e/screens.ts`: clean in-game screenshots; needs a game server serving the built client.

## Invariants: do not break these

1. **The server is authoritative.** Clients send intent (direction), never positions. Collisions, speed, room access and conversation membership are decided on the server.
2. **Never persist movement per step and never send movement per frame.** Network rate is 10-15 Hz, batched. Only the last position is saved, when a player leaves (a server stop is everybody leaving: one transaction for all).
3. **Spatial index and areas of interest.** Do not introduce all-pairs comparisons in the tick or the proximity pass.
4. **Backpressure.** Queues are bounded. Stale positions are dropped/overwritten for slow clients; reliable messages (chat, control) are not dropped silently. Do not add unbounded buffers.
5. **Media isolation is enforced by the server/SFU.** Hiding or muting a video in the UI is not isolation. Tokens are scoped to one room and one identity; leaving a group revokes access.
6. **Consent gates capture.** No camera or microphone access before an explicit opt-in; busy/away/invisible never join automatic conversations; leaving a conversation stops local capture.
7. **Animation stays out of React.** PixiJS owns the world and its ticker; React only renders UI.
8. **Local dev and production must stay clearly distinct.** Production mode must keep refusing insecure defaults.
9. **No content or secrets in logs.** Never log chat text, tokens, keys or secrets.
10. **Original assets only.** Any third-party asset or dependency needs a compatible licence and must be documented. The visual *style* may be inspired by 2000s handheld RPGs, but never use, trace, extract or recolour assets from Pokémon or any Nintendo/Game Freak (or other) game; draw everything in code under `web/src/game/art`.

## Administration and accessibility rules

- Every admin action that changes access or content of the office calls `audit`; audit rows never contain message text. A change that affects an online member's access also calls `evict`.
- The last administrator can never be demoted or removed; keep that check in the store transaction.
- Interactive UI needs an accessible name, dialogs use `Modal` (focus trap, Escape), and the `a11y` e2e scenario must stay at zero axe violations.

## Conventions

- Go: standard library first, `gofmt`, golangci-lint clean (a `//nolint:<linter> // why` says why), one Go module per library: a new import between libraries is a `require` and a `replace` in the importer's go.mod (and a `replace` in every module that imports the importer, directly or not: Go reads only the main module's replaces; `go mod tidy` there then adds the `require`), which fdash reads for `dependsOn`; a library hides what others must not use in its own `internal/`; one version of each third-party module across the go.mod files (`lint:go-versions`), table-driven tests where natural, no dependency for what a few lines do. Keep `internal/media` the only package that speaks to LiveKit.
- TypeScript: `strict` is on; keep `tsc --noEmit` and `node scripts/oxlint.ts` clean (a disable comment says why). Prefer small modules; keep hot paths allocation-light.
- Tooling (`e2e/`, `scripts/`, `site/`, `tools/`, sprite tools) is TypeScript that Node runs as is: erasable syntax only (no enums, namespaces or parameter properties), `import type` for types, relative imports with their `.ts`. Files served or inlined as text stay JavaScript with `// @ts-check` and JSDoc, checked by a gate: `web/src/plugins/sdk.js`, `viewSdk.js`, `desktop/ui/setup.js`, `desktop/src-tauri/src/missing-apis.js`, `site/src/site.js` ([decision 0036](docs/decisions/0036-tooling-in-typescript.md)).
- Something new drawn in the world goes in a layer of its own (`web/src/game/layer.ts`, [decision 0034](docs/decisions/0034-world-view-layers.md)): `init` adds its Containers, events are direct calls from `WorldView`, `update(dt, now)` returns whether anything on screen changed (never draw unconditionally) and allocates nothing, and it takes its place in WorldView's `layers` array. Sprites that sort with people go in the shared `entLayer`; `frame()` itself draws nothing.
- Web Audio: create (or resume) an `AudioContext` inside the click that needs it; made after an `await` it may stay suspended and silent. A node that processes mono sets `channelCount = 1` with `channelCountMode = "explicit"`, or a stereo microphone loses half its signal. Playback the user hears goes to the chosen speaker (`setSinkId`). Cues that the server triggers (waves, conversations) arrive outside any click: they go through `web/src/audioOut.ts` (Audio elements unlocked by the first key or pointer press), never through an `AudioContext` made on the fly.
- Toasts sit above dialogs (`.toast` z-index over `.scrim`) so a message raised from a dialog shows.
- Validate all external input: WebSocket messages, avatars, maps, uploads. Enforce size and rate limits.
- Media tokens are short (30 s, LiveKit adds 60 s of leeway) and the reconciler in `httpapi` removes unknown SFU participants: keep both when touching `internal/media`.
- Protocol changes: update `web/src/net/protocol.ts`, `docs/protocol.md` and the world tests together.
- Add or update a decision record in `docs/decisions/` when you change an architectural choice, with the performance, maintenance and install impact.

## Evidence and honesty rules

This project reports **only what was actually run**.

- Keep **measured results**, **estimates** and **not-run tests** clearly separated. Label targets as targets.
- Never state a capacity ("supports N users") without a recorded measurement: hardware, region, OS, network limits, services, and where the load generator ran.
- A build, a screenshot or simulated data is not proof of behaviour. A WebSocket benchmark does not prove video capacity.
- When you finish work, say exactly what you executed and what remains pending. Update `docs/status.md` and the README status table together with the code.
- Do not invent prices; give a formula and assumptions.

## Working in a shared checkout

Other agents or people may be working in the same tree at the same time.

- Check `git status` before editing; do not revert or reformat files you did not touch, and never run destructive git commands (`reset --hard`, `checkout --`, `clean`) without an explicit request.
- Do not kill processes or free ports you did not start. Use your own database file (for example `HQ_DB=server/data/<unique>.db`) instead of deleting shared ones.
- The dev stack listens on 5173 (Vite), 8080 (Go) and 7880 (LiveKit). Start long-running processes in a persistent session; they die with short-lived shells. Local e2e runs share the machine through **e2e slots** (`e2e/slots.ts`): before it builds or starts anything, a run (or each shard of an `E2E_PARALLELISM` run) takes one of `E2E_MAX_PARALLEL` slots (default 2), lock files in `<os temp>/homequarters-e2e-slots/` that hold the owner's pid; when all are taken it waits and prints `# waiting for a free e2e slot (…)` every 30 s. A slot whose pid is gone (a run killed outright) is taken over; `E2E_PARALLELISM` above `E2E_MAX_PARALLEL` is refused. Set the limit, and `CHROME`, in a git-ignored `.env` at the repository root (copy `.env.example`; a worktree without one reads the main checkout's, and the environment wins over the file). Slot k gives the run its ports: server 38180+100k (auth +10) and **its own LiveKit** on 47980+100k (RTC TCP +1, UDP +2), the `livekit-server` binary if it is on PATH, else a Docker container (labelled `hq-e2e-owner`, removed at the end, on a failure and on Ctrl+C; one left by a run killed outright is removed by the next run). The suite never uses the dev LiveKit on 7880. `HQ_TEST_PORT` (auth uses it + 10) and `HQ_TEST_LK_PORT` still override the slot's ports; with `HQ_TEST_LK_PORT` no LiveKit is started, so one must already listen there (with its own RTC ports). `HQ_EXTERNAL_URL` runs take no slot. `e2e/plugin-run.ts` (the plugin e2e projects) takes a slot too and uses only its server port: it starts the testbed, no LiveKit. With `E2E_PARALLELISM=N` (`e2e/parallel.ts`) the build runs once, then each shard runs on its slot's ports; each shard's output is printed whole at the end, logs stay in a `homequarters-e2e-shards-*` temp folder. Shards share the CPU: on a 12-thread Windows machine 2 shards passed (11.5 min against 20 min serial) while 3 saturated it and failed a few timing checks each run, so pick N by your cores and treat a timing failure under N > 1 as unconfirmed until it fails alone (see `docs/status.md`).

## Testing notes and gotchas

- The browser exposes `window.__hq`, typed for the suite by the client's own `HqHandle` (`web/src/session.ts`, `e2e/globals.d.ts`) (view, media, state, session, `cachedLooks()` for the avatar texture cache size, `chimes` for the last cues asked for, `sounds` for what became of them (played, blocked, failed, on which speaker), `autoOff` whose `grace` a test may shorten, `session.plugins.dropNext(plugin, n)` to lose the next n messages a plugin sends to the server) for tests. Drive movement with `view.setDirection`, not synthetic key events.
- `window.__hq` shortcuts are for setup; every feature also needs one check through its real controls with its panel open (the chat crash hid behind API-only sends).
- Rules and logic in unit tests, the browser suite for wiring. A game's rules, who may press a button, what a view announces or sends: a Go test, a `web/test` unit test or one in the plugin's own `test/` (extract a pure module when the logic sits in a DOM script, as `plugins/bundled/hq-chess/public/sync.ts` does for the board view). A browser scenario checks what only a browser shows (real controls, pixels, iframes, sync between pages) and should not repeat a rule a unit test covers: each such check costs seconds in every run. Every TypeScript test but fdash's runs under Vitest ([decision 0038](docs/decisions/0038-pnpm-workspace-vitest.md)): `import { test } from "vitest"` (assertions from `node:assert` are fine), never `node:test`. Vite resolves `web/src`'s extensionless imports as the build does; a test reading a file outside its folder builds the path from `import.meta.dirname`, never `new URL("…", import.meta.url)` (Vite rewrites it into an http address). A React component's behaviour (focus, keys, what it renders for a state) is a component test in `web/test/*.test.tsx` with React Testing Library and user-event on jsdom (its first line `// @vitest-environment jsdom`: the project runs on Node, so only component tests pay for jsdom), not a browser scenario, built on the helpers of `web/test/support` (known store, typed session and media fakes, fetch and navigator stubs; its README holds the rule that every fake-backed component test keeps one browser check of the same feature); a plugin view module gets a jsdom test in the plugin (`// @vitest-environment jsdom`, or a jsdom project in its `vitest.config.ts`).
- Three tiers ([decision 0037](docs/decisions/0037-test-pyramid.md)): `test:unit` (Go tests, `test/*.test.ts`), `test:integration` (`**/*.ispec.ts` against `homequarters testbed`: the real server, no browser, no LiveKit) and `test:e2e` (real Chrome). What a plugin's server code does with real members (seats, stored data, restarts, errors) is an integration test in the plugin, written with `plugins/sdk/testbed.ts`; the server's Go tests read no bundled plugin. Integration tests wait for messages (`waitFor`, `waitKv`), never for a fixed time; "nothing happened" is a probe the plugin always answers, or a named, bounded `quiet(ms)`. The testbed places only offline members (`POST /api/testbed/position`, 409 while they are connected or within the reconnect grace), so a test joins a member `at` a tile instead of walking them. CI builds the testbed binary with `-race`; a local Windows build has no race detector.
- `node run.ts capture-plugin-pet` writes frames (pets of the bundled plugin walking, the hover tag, its modal) and a contact sheet (with ffmpeg) to a fresh folder under `/tmp/hq-capture`; copy it for new `capture-*` scenarios. They are not in the default suite. A bundled plugin's captures sit in its e2e project (`plugins/e2e/hq-chess-e2e/capture-chess.ts`, `hq-cards-e2e/capture-cards.ts`) and run on the testbed from that folder: `node ../../../e2e/plugin-run.ts --plugin ../../bundled/hq-chess capture-chess.ts`.
- LiveKit's client may use a single peer connection; read RTP stats from `room.engine.pcManager.subscriber?.pc ?? publisher.pc` (see `rtpBytes` in `e2e/lib.ts`).
- Editing client files while the Vite dev server runs can trigger a full reload and break a running E2E script; rerun it.
- Avatar sheet cells are 18x30 px (16x24 body plus a 1 px outline margin and 4 rows on top for hats and tall hair). The outline is applied per cell so nothing bleeds between rows; keep it that way. `e2e/art.ts` crops rows 4-28 when it reuses cells. Name tags follow the drawing's real top (`AvatarFrames.tall`), not the cell height.
- The camera uses integer zoom (`VIEW_REF_W/H` in `camera.ts`). Keep the server's area of interest large enough to cover the visible world at the smallest zoom.
- Tests that need real media use Chrome flags `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`. The fake microphone is a beep: it proves audio flows, not how well noise suppression cleans a voice.
- On Windows, headless Chrome's fake camera track ends as soon as it starts unless the GPU is off: `launch()` in `e2e/lib.ts` adds `--disable-gpu` there. LiveKit in Docker Desktop carries video RTP when its RTC ports are published with the same numbers inside and out and it advertises 127.0.0.1 (`--node-ip 127.0.0.1`, as `deploy/docker-compose.local.yml` and `e2e/livekit.ts` do): the whole serial suite passed against the dev container (2026-10-25), and the video RTP checks of `proximity` and `spotlight` passed with three shard containers at once (2026-10-25). LiveKit's Windows binary on the host (`livekit-server.exe` with its own `port` and `rtc` ports in a config) also works. Vite may listen on `::1` only: open `http://localhost`, not `127.0.0.1`.
- Load generators must run **outside** the machine being measured.

## The site (GitHub Pages)

`site/build.ts` turns `docs/*.md`, `docs/decisions/*.md`, `deploy/README.md` (the Self-hosting page) and `site/src/landing.html` into `site/dist/` with relative links (it works under `/homequarters/`). It also writes what search engines and AI assistants read: canonical and social metadata, JSON-LD, `sitemap.xml`, `llms.txt`, `llms-full.txt` and a Markdown copy of every page (`docs/<slug>.md`). Links from docs to other repository files become GitHub URLs. The landing FAQ shows the first six questions of `docs/faq.md`, so answers live in one place. `site/check.ts` fails on broken links, missing metadata or a stale sitemap; CI, the Pages workflow and `scripts/gauntlet.sh` run it. To add a docs page: create the Markdown file in `docs/` and register it in the `NAV` list in `site/build.ts` (add a hand-written entry to `DESCRIPTIONS` if the first paragraph makes a poor search snippet). The site's public URL is `SITE` in both scripts.

## Out of scope for now

Recording, AI transcription, native apps, marketplace, enterprise integrations and 3D worlds. Do not start them without an explicit request.

## Definition of done

- The gauntlet's stop condition holds: whole suite green, no blocker or major finding open, evidence for every acceptance criterion.
- Code builds, is formatted, and relevant tests pass (state which you ran).
- Behaviour changes have tests; risky media/privacy changes have an end-to-end check or a clearly stated "not verified".
- Docs, decision records and the status table are updated in the same change.
- No secrets, no content logging, no new unbounded queues, no per-frame network sends.
