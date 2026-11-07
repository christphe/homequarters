# Test pyramid and plugin testbed

Date: 2026-11-07. Status: approved by the user on 2026-11-07.

## Intent

Today the project has two kinds of tests: unit tests (Go `go test`, `node --test`) and the browser suite (`e2e/run.ts`, real Chrome and a real LiveKit). Two things are wrong with that:

1. **The bundled plugins are tested by the server.** `server/internal/plugin/{chess,cards,lastcard,oldmaid,sample}_test.go` (about 2 000 lines of Go) drive `plugins/bundled/*` through the real host, and `e2e/scenarios/{chess,cards}.ts` drive them in the browser from the central runner. A plugin does not own its tests, and a plugin author outside this repository has no way to test a plugin against the real plugin system.
2. **There is no middle tier.** Behaviour that only needs the HTTP/WebSocket API is either tested inside `httpapi` with private helpers or in the browser suite, which needs LiveKit and Chrome and costs seconds per check.

What the user wants: a three-tier pyramid (unit, integration without a browser, e2e), and a **plugin testbed** so that each plugin runs its own integration (and e2e) tests against the real plugin system **without starting LiveKit**: only the `homequarters` binary. If the plugin API breaks, the plugins' tests break.

## Goals

- `homequarters testbed`: a subcommand of the server binary that starts a real server ready for tests: dev mode, no LiveKit, a throwaway database, the given plugins installed and enabled.
- A TypeScript test client next to the plugin SDK (`plugins/sdk/testbed.ts`) that starts the testbed and drives members through the real HTTP and WebSocket API, for the plugins of this repository.
- Each bundled plugin owns its tests: unit (`test/*.test.ts`, unchanged), integration (`**/*.ispec.ts`, against the testbed), and, where it has some, browser scenarios (`e2e/*.ts`, against the testbed with Chrome, no LiveKit). Each is an fdash task of the plugin's own project.
- The Go server tests that drive bundled plugins move into those plugins. `server/internal/plugin` keeps only tests of the host itself, on fixtures.
- Later, not in this PR: a Go integration tier (black-box tests through HTTP/WS against a real in-process server) and the browser checks that need no browser moved down to it.

## Non-goals

- No change to the plugin API itself, the protocol or the host's limits.
- Nothing for outside plugin authors yet: no npm package, no release binary, no browser helpers in the SDK.
- No fake clock or deterministic scheduler in the testbed: tests wait for messages with timeouts, as the Go tests do today.
- The browser suite's platform scenarios (`plugins.ts` with its fixtures, `a11y`, `offline`) stay in `e2e/`: they test the platform, not one plugin.

## Anti-goals

- The testbed must never be reachable in production: it refuses `HQ_ENV=production` and its test-only endpoints are registered only by the subcommand (invariant 8).
- A test-only shortcut must not become a second way for clients to send positions (invariant 1): the testbed's placement endpoint exists only in the testbed process.
- Losing coverage in the move: every Go check of a bundled plugin and every browser check of `chess`/`cards` has a counterpart after the migration (listed in the PR).
- Flaky tier: an integration test that waits on wall-clock sleeps instead of messages is a defect.

## Approaches considered

- **A. `homequarters testbed`, the real server ready for tests** (chosen). The full server without LiveKit; tests use real sockets and the real protocol. Catches breaks in the plugin API, the QuickJS host and the transport. Cost: about a second of start-up per test file and a binary to build first (cached by fdash).
- **B. `homequarters plugin-host`, only the host, driven over stdio JSON.** Faster and more deterministic, but bypasses WebSocket, auth and protocol (a transport break would not show) and adds a second protocol to maintain.

The user picked A: "just run homequarters, without LiveKit".

## Design

### `server/internal/testbed` (Go)

A package that starts the real server in-process: config in dev mode, `LiveKitURL` empty (the server already runs without media, as `e2e/banner.ts` shows), a database in a temporary directory, join and rate limits raised for tests, a catalog made of the given plugin directories, those plugins enabled at start (through the same store path the admin API uses, with an audit row by a "testbed" actor). It returns the base URL and a `Close`. It also exposes Go helpers for integration tests: join a member (cookie), open a socket, wait for a message, admin requests.

Both the subcommand and the Go integration tests use it, so there is one way to start a test server.

### `homequarters testbed` (subcommand)

```
homequarters testbed --plugin DIR [--plugin DIR ...] [--addr 127.0.0.1:0] [--static DIR] [--db FILE]
```

- Refuses to start when `HQ_ENV=production`.
- Listens on `--addr` (default a free port on 127.0.0.1), prints one JSON line on stdout once ready: `{"url":"http://127.0.0.1:PORT"}`, then logs on stderr.
- Stops when stdin closes (as `HQ_STOP_ON_STDIN_CLOSE` does) or on SIGINT/SIGTERM; removes its temporary database unless `--db` was given. `--db` lets a test stop and restart the testbed on the same database (restart tests: chess games and cards that survive a restart).
- `--static` serves a built client (`web/dist`) for browser scenarios; without it, no client is served.
- Test-only endpoints under `/api/testbed/`, registered only by this subcommand: place a member at a tile (to stand next to an object without walking), and read the count of "plugin error" log lines per plugin (what the Go tests count with `errCounter` today). Names and shapes are left to the builder.
- How the subcommand is selected next to the existing flags (`-invite`, `-backup`…): `homequarters testbed …` as the first argument, before `flag.Parse`.

### `plugins/sdk/testbed.ts` (TypeScript client)

Node-only, no dependency (global `fetch` and `WebSocket`, Node 24), erasable syntax so Node runs it as is. Sketch:

```ts
const bed = await testbed({ plugins: [import.meta.dirname] });   // spawns homequarters testbed
const admin = await bed.join("Ann");                              // first member is the administrator
await admin.placeObject("chessboard", 13, 22);                    // through the admin map API
const bob = await bed.join("Bob");
await bob.standAt(13, 23); await bob.use();                       // testbed placement, then the real "use" intent
bob.send("hq-chess", { t: "take", side: "w" });                   // a plugin message over the socket
await bob.waitFor("hq-chess", (m) => m.t === "state");            // timeout fails the test with the last messages seen
await bed.restart();                                              // same database
await bed.close();
```

The binary is found through `HQ_BIN`, then where the server's `build` puts it in this repository, then `homequarters` on PATH. The client never builds it: when no binary is found it fails with a clear message ("run `fdash run build` first"). Types come from the SDK's existing declarations where they fit.

### Plugins own their tests

Each bundled plugin is an fdash project, and each plugin with browser scenarios gets a second project for them.

**The plugin project** (the plugin folder): `hq-chess`, `hq-cards`, `hq-card-lastcard`, `hq-card-pouilleux`, `hq-pets` (which gets the `fdash.json` it lacks today). It depends on `server` (a plugin depends on the server) and `sdk`; the card games also depend on `hq-cards` if they build on it (to check in the code). Its tasks:

- `lint`: what the plugin chooses; for these, oxlint on its folder and the type check of its `tsconfig.json` (what `scripts/check-plugin-types.ts` does today).
- `test:unit`: `test/*.test.ts`, unchanged.
- `test:integration`: `**/*.ispec.ts`, the server behaviour now in `server/internal/plugin/*_test.go` rewritten in TS against the testbed.

**The e2e project** of a plugin, one per plugin and per what it tests:

| Project | Depends on | Tests |
| --- | --- | --- |
| `hq-chess-e2e` | `hq-chess`, `web` | the chess scenario (`e2e/scenarios/chess.ts`) |
| `hq-cards-e2e` | `hq-cards`, `web` | the empty table (the hq-cards part of `e2e/scenarios/cards.ts`) |
| `hq-card-pouilleux-e2e` | `hq-card-pouilleux`, `web` | the Old Maid variant only |
| `hq-card-lastcard-e2e` | `hq-card-lastcard`, `web` | the Last Card variant only |

Its `test:e2e` runs the scenarios against the testbed with `--static web/dist`, Chrome and no LiveKit, reusing `e2e/lib.ts` (launch, joinAs, check) and taking an e2e slot (`e2e/slots.ts`) like any browser run. Splitting `cards.ts` into the three is part of the work; whether the `capture-*` scenarios move with their plugin is the builder's call.

A plugin project depends neither on `web` nor on its e2e project: touching the web client reruns the e2e projects, not the plugins' unit or integration tests. Where an e2e project's folder sits (inside the plugin folder, excluded from the plugin's `files` and from what the image ships, or next to it) is the builder's call; it must not be part of the plugin project's inputs.

`server/internal/plugin` keeps `host`, `hooks`, `hardening`, `catalog`, `settings`, `layout` tests on `testdata` fixtures; any of them that reads `plugins/bundled` moves to a fixture or to the plugin. `server`'s tasks then no longer list `/plugins/**` as an input, and the server depends on no plugin.

### Go integration tier (later, not in this PR)

- Black-box tests through HTTP/WS against `internal/testbed` live in `server/integration/` (their own package, only the public API), fdash task `server:integration`, run with `-race`.
- `httpapi` tests that already work this way (`newRig`, real sockets) move there when they only use the public API; tests that need handler internals stay as unit tests.
- An audit of the browser suite lists every check that does not need a browser (status codes, access rules, what a socket receives); those move to `server/integration/` and leave the browser suite. The list and the verdicts go in the PR.

### fdash: conventional task names, `--pkg`, task dependencies per project

Modelled on Rush, and on how fchange splits its workspace into packages with `--pkg`.

**CLI.**

```
fdash run test:unit                       # test:unit in every project that defines it
fdash run test:unit --pkg server          # only server's
fdash run test:e2e --pkg hq-chess-e2e --pkg hq-cards-e2e
fdash run test:e2e --pkg e2e -- chess     # items, as today
fdash list [--pkg server]
```

- A task name no longer carries its project; it may contain `:` (`test:unit`). The `<project>:<task>` form leaves the CLI.
- A task name runs that task in every project that defines it; `--pkg` restricts it to the named projects (folder name, or `name` in the project's `fdash.json`), may be repeated, and is an error when that project lacks the task.
- `fdash run` with no task runs `default`, defined in the workspace file.

**Conventional names.** The repository's projects use these names; fdash knows nothing of them, and what each task does is the project's own business (one puts `gofmt -l`, `vet` and `staticcheck` in its `lint`, another `tsc --noEmit` and oxlint). There is no `format` convention: format checks belong in `lint`.

| Task | Meant for |
| --- | --- |
| `build` | producing what runs or what other projects use: the server binary, `web/dist`, the site |
| `lint` | checks that read code without running it: format checks, type checks, linters, doc checks |
| `test:unit` | unit tests |
| `test:integration` | tests against a real process without a browser (the testbed) |
| `test:e2e` | browser tests |

Later, not in this PR: `release:package` (the Docker image, the desktop builds; cached with its outputs like `build`) and `release:push` (publishing them; never cached), run per product with `--pkg` as fchange does. Possibly names for generated assets, captures, benchmarks and audits: not decided.

**Execution order: always a graph**, built from two kinds of edges:

1. **Across projects, implicit:** task X of a project runs after task X of each project it depends on (`dependsOn`), transitively. When a dependency lacks task X, the chain goes through it to its own dependencies: `hq-card-pouilleux:test:integration` waits for `server:test:integration` even if `hq-cards` has no `test:integration`.
2. **Inside a project, declared by that project:** a task may list other tasks of the same project it runs after (`server`'s `test:integration`, when it exists, after `server`'s `build`). Some languages need a build before their tests, others do not; the project says so, nobody else.

No other edge exists: a task never triggers another project's `build` by itself. That is accepted: a `build` always runs when something changed (CI runs it explicitly; locally one runs it after changing branch). A task that finds a missing artefact says so (the testbed client: "run `fdash run build` first"). A task in the graph runs once per fdash run, and is cached on its inputs as today.

**Output caching (user, 2026-11-07).** Today fdash records only that a run passed (a key in `.fdash/cache/`) and skips it next time; it stores no file. A cached `build` would then be skipped on a fresh CI runner (which gets main's records) with no binary on disk, and every task after it would fail. So fdash learns outputs:

- A task may declare `outputs` (patterns, relative to its project, like `inputs`): the files it produces (`server/bin/homequarters`, `web/dist/**`, `site/dist/**`).
- The declared `outputs` are part of the cache key (user, 2026-11-07): changing them invalidates the record and the task runs again.
- On a pass, fdash stores those files with the record, under the same key.
- On a cache hit, fdash restores them before the tasks that come after, replacing what is on disk, so what is on disk always matches the key. A record whose outputs are missing from the cache counts as a miss: the task runs.
- The CI jobs already save and restore `.fdash/cache` from main's runs; the outputs ride along (size to watch: the binary and `web/dist`, measured and reported in the PR).
- Every miss caused by outputs is reported with a warning line naming the task and why (`WARN cache miss <task>: outputs not in the cache`), never silently. Right after this PR is merged, the records made before it hold no outputs: the builds rebuild once, with that warning.
- A task without `outputs` behaves as today. `release:push`-like tasks stay uncached (`"cache": false`).
- Storage format (plain copies or an archive per key), and pruning, are the builder's call; unit tests cover store, restore over a stale file, missing outputs as a miss, and a hit on a fresh folder.

**`dependsOn` between projects** keeps its current meaning (the dependency's files are inputs of the project's tasks) on top of the ordering. Hence the cache rule: a plugin reruns when it, `server` or `sdk` changes; `server` depends on no plugin, so touching a plugin reruns nothing of the server; touching `web` reruns the e2e projects only.

**Cross-cutting checks** (user, 2026-11-07):

- **oxlint runs per project**, in each project's `lint`, on its own folder with the shared `.oxlintrc.json` (in type-aware mode each file finds its nearest `tsconfig.json`). Touching a plugin relints only that plugin. `scripts/oxlint.ts` becomes the per-folder runner (or goes away), builder's call.
- **A `docs` project** (the `docs/` folder) holds the protocol-docs check (`scripts/check-protocol-docs.ts`: `docs/protocol.md` lists every WebSocket message of `server/internal/httpapi/ws.go`'s dispatch and of `web/src/net/protocol.ts`) in its `lint`. `ws.go` and `protocol.ts` are inputs of that task, so `docs` depends neither on all of `server` nor on all of `web`.
- Plugin types move into each plugin's `lint`; desktop types into a `desktop` project's `lint` (builder's call if that project is worth creating now).

**The workspace file** lists `projects` and may define groups: plain lists of task names with no dependencies (dependencies come from the projects). `default` runs `lint`, `build`, `test:unit`, `test:integration`, `test:e2e`; a `static` group may stay if useful. The `*:` patterns go away (a bare name already means "in every project").

**CI: three jobs.**

- `unit`: `lint`, `build`, `test:unit`.
- `integration`: `build`, then `test:integration`.
- `e2e`: `build`, then `test:e2e`, keeping the shard matrix; shards balance the platform scenarios (`e2e` project items) and the plugin e2e projects together (how is the builder's call).

Coverage per tier comes later; this layout is what makes it possible.

`tools/fdash/README.md` and decision 0035 are updated with the new CLI and the ordering rules, with unit tests for `--pkg`, colons in names, the cross-project order (including the walk through a dependency that lacks the task), the in-project order, and run-once.

### Documentation

- A decision record `docs/decisions/0037-test-pyramid.md`: the tiers, the testbed, performance (time per tier, measured), maintenance and install impact.
- `docs/plugins.md` / `docs/plugin-api.md`: a "Testing a plugin" section for authors.
- `docs/gauntlet.md`, `AGENTS.md` (commands, repository map, testing notes), `docs/status.md` and the README status table.
- A `server/CHANGELOG.md` entry (`added`) for the `testbed` subcommand.

## Scope decided with the user (2026-11-07)

One pull request, covering:

1. The testbed tooling (`internal/testbed`, `homequarters testbed`, `plugins/sdk/testbed.ts`) and the migration of the Go tests of the bundled plugins into each plugin, as integration tests against the testbed.
2. The browser scenarios of the bundled plugins (`chess.ts`, `cards.ts` split in three) moved into e2e projects of their own, one per plugin, each with a `test:e2e` task.
3. The fdash changes: conventional names, `--pkg`, the ordering graph, output caching, per-project lint, the `docs` project, three CI jobs.
4. **Not in this PR:** the Go integration tier (`server/integration/`), moving `httpapi` tests and the audit that moves browser checks down. The pyramid is the goal; the testbed gives the integration tier it needs, and refining it comes later.

**Audience:** the plugins of this repository only. Outside plugin authors are not a concern for now: no release binary, no npm package, no browser helpers in the SDK. The client file still sits in `plugins/sdk/` and `docs/plugins.md` says to build the binary from source (`go build ./cmd/homequarters`) and point `HQ_BIN` at it. The release workflow does not change.

**Cache rule:** a plugin's tests rerun only when that plugin or the server changes; touching a plugin reruns nothing of the server. It follows from `dependsOn` (see the fdash section); the e2e projects add `web`. Platform scenarios of the `e2e` project that still list `/plugins/bundled/**` (`plugins`, `a11y`, `offline`) keep it only if they really load a bundled plugin; otherwise they switch to fixtures (builder's check, reported in the PR).

## Calls made after the builder check (to confirm)

- **Plugin storage in tests.** Some Go checks read or seed a plugin's KV (chess stores nothing on open, card values stay under 4096 bytes, reset frees `table:`/`log:` keys, hq-pets seeded with 60-80 members). The testbed gets two more test-only endpoints: read a plugin's keys and values, and seed keys before the plugin starts. Same rule as the others: registered only by the subcommand.
- **"Nothing happened" without sleeps.** Where the plugin answers something to a later message, the test sends a probe after the refused action and asserts that nothing arrived before the probe's answer (one plugin handles its messages in order). Where no probe exists, a bounded `quiet(ms)` helper is allowed and named as such. No change to the host.
- **Race coverage.** CI (Linux) builds the testbed binary with `-race`; locally on Windows it is built without (no C compiler needed). The host's own races stay covered by the Go host tests on fixtures.

## Left to the builder

- Exact names and shapes of the `/api/testbed/` endpoints and of the client's methods beyond the sketch.
- How the catalog is built from explicit plugin directories (a variant of `plugin.Scan` or a temporary plugins folder).
- Which `httpapi` tests move to `server/integration/`, and which browser checks move down (with the list in the PR).
- Whether `capture-chess` / `capture-cards` move with their plugin.
- The `fdash.json` key for a task's in-project predecessors, and where the e2e projects' folders sit.
