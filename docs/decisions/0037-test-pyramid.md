# 0037: a test pyramid, a plugin testbed, and fdash's conventional tasks

Date: 2026-11-07. Status: accepted.

## Context

There were two kinds of tests: unit tests (`go test`, `node --test`) and the browser suite (`e2e/run.ts`, real
Chrome and a real LiveKit). Two things were wrong with that:

- **The bundled plugins were tested by the server.** `server/internal/plugin/{chess,cards,lastcard,oldmaid,sample}_test.go`
  (about 2,100 lines of Go) drove `plugins/bundled/*` through the real host, and the `chess` and `cards`
  scenarios drove them in the browser from the central runner. A plugin did not own its tests, and a change
  in one plugin reran every Go test (decision 0035 named this as the next step).
- **There was no middle tier.** A check that only needs the HTTP and WebSocket API was either a Go test with
  private helpers or a browser scenario, which needs LiveKit and Chrome and costs seconds per check.

fdash (decision 0035) named tasks `<project>:<task>` and ran them all at once inside a group, so "run the
unit tests everywhere" or "build first, then test" had no plain way to be said. It recorded that a task
passed but kept no file, so a cached build on a fresh CI runner would leave nothing on disk.

The design note is `docs/superpowers/specs/2026-11-07-test-pyramid-plugin-testbed-design.md`.

## Decision

**Three tiers.** Every project names its tests by tier:

| Tier | Files | What it runs against |
| --- | --- | --- |
| unit (`test:unit`) | Go `*_test.go`, `test/*.test.ts` | the code itself, in process |
| integration (`test:integration`) | `**/*.ispec.ts` | `homequarters testbed`: the real server, no browser, no LiveKit |
| e2e (`test:e2e`) | `e2e/scenarios/*.ts`, `plugins/e2e/<plugin>-e2e/*.ts` | real Chrome against the real server |

**`homequarters testbed`** (`server/cmd/homequarters/testbed.go`, `server/internal/testbed`) starts the real
server for tests: dev mode, no LiveKit, a database in a temporary folder (or `--db FILE`, kept, for restart
tests; with `--db-temp` it is removed at the stop unless a line `keep` came on stdin first, which is how the
client restarts it without leaving a folder behind when the test process dies), join limits raised, and only
the plugin folders given with `--plugin`, each enabled at start with an audit row by the testbed. It refuses
`HQ_ENV=production` and any listen address but loopback. It prints `{"url":"http://127.0.0.1:PORT"}` on stdout
once it listens and stops when its stdin closes, so it never outlives the test that started it. `--static web/dist` serves the client for
browser scenarios. Next to the server's own routes, its own mux serves four test-only endpoints:

- `POST /api/testbed/position`: the saved position of an offline member, at a tile. A connected member is
  never moved (409, also during the reconnect grace after they left), and the world restores the position when they join, so clients still never send
  positions (invariant 1).
- `GET` and `PUT /api/testbed/kv/{plugin}`: a plugin's stored keys and values; a write only while the plugin
  is disabled, and after the writes it queued before it stopped have reached the database (httpapi's
  `KVSettled`), so none of them lands on top of the new data.
- `GET /api/testbed/errors`: how many "plugin error" log lines each plugin produced.

`httpapi` never registers them; it only learns to load plugins from explicit folders (`PluginDirs`, set by
the testbed, never read from the environment). The testbed refuses any `HQ_ENV` but empty or `dev`
(invariant 8), and warns when it listens beyond the loopback, since those endpoints have no authentication.
The binary now refuses an argument it does not know instead of starting the server: an older binary given
`testbed` would otherwise have opened a database in the current folder.

**`plugins/sdk/testbed.ts`** is the TypeScript client: Node 24 only, no dependency. `testbed({ plugins })`
spawns the binary and returns a bed (`join`, `placeObject`, `setPlugin`, `setSetting`, `kv`, `waitKv`, `seedKv`,
`errors`, `restart`, `close`); a member sends plugin messages and the `use` intent, and waits for frames with
a timeout that fails with the last frames seen. "Nothing happened" is proven with a probe the plugin always
answers, or with a named, bounded `quiet(ms)`. The binary is `HQ_BIN`, else `bin/homequarters[.exe]` (what the
server's `build` writes), else `homequarters` on PATH; the client never builds it.

**Plugins own their tests.** Each bundled plugin is an fdash project depending on `server` and `sdk` (the card
games on `hq-cards` too) with `lint`, `test:unit` and `test:integration`. The Go tests of the bundled plugins
became `.ispec.ts` files in each plugin; `server/internal/plugin` keeps the host's own tests on fixtures, and
the server depends on no plugin. The `chess` and `cards` scenarios left `e2e/` for projects of their own in
`plugins/e2e/` (`hq-chess-e2e`, `hq-cards-e2e`, `hq-card-pouilleux-e2e`, `hq-card-lastcard-e2e`; `cards` split
in three), outside the plugin folders so that neither the plugin's inputs nor the Docker image include them.
`e2e/plugin-run.ts` runs them against the testbed with Chrome and no LiveKit, taking an e2e slot like
`run.ts`.

**fdash: conventional names, a graph, outputs.**

- The repository's projects use five task names: `build`, `lint`, `test:unit`, `test:integration`,
  `test:e2e`. fdash knows none of them; the convention belongs to the workspace. Format checks are part of
  `lint`.
- A name on the command line runs that task in every project defining it; `--pkg` restricts it to the
  projects named (repeatable, an error when one lacks the task). The `<project>:<task>` form left the
  command line.
- Order is a graph. Across projects, task X of a project starts after task X of the projects it depends on,
  walking through a dependency that lacks X to its own dependencies. Inside a project, a task starts after
  the tasks of that project it lists in `after` (`site`'s `test:unit` after its `build`). Nothing else: a
  task never starts another project's `build` by itself.
- Several names on the command line run as stages, one after the other: `fdash run build test:integration`
  tests what was built; a failed stage stops the next.
- A task may declare `outputs`. They are part of its cache key, stored with a pass, and restored over what is
  on disk on a hit; a record whose outputs are missing is a miss, reported as
  `WARN cache miss <task>: outputs not in the cache` (or `a pass recorded before outputs were cached`, for
  records made before this change). The server's binary, `web/dist` and `site/dist` are declared.
- The workspace defines `static` (`lint`, `build`, `test:unit`) and `default` (`static`, then
  `test:integration`, then `test:e2e`, one at a time). Two projects are new: `docs` (the protocol-docs check)
  and `desktop` (its type check and Oxlint). Oxlint runs per project, on the project's folder.

**CI** has three jobs: `unit` (`lint build test:unit`), `integration` (the server's `build` with the race
detector, then `test:integration`) and `e2e`, four shards that balance the browser suite's scenarios and the
plugin e2e projects together (`e2e/shards.ts`'s `plan`). Records still come only from runs of pushes to
`main` (decision 0035); outputs travel with them.

Not in this change: a Go integration tier (black-box tests through `internal/testbed`), moving browser checks
that need no browser down to it, `release:*` tasks, and coverage per tier.

## Measurements

Measured on the Windows 11 desktop (12 logical CPUs, Node 24, Go 1.27.0, Chrome, LiveKit 1.13.7 in Docker Desktop) on 2026-11-08, from the whole gauntlet run without the cache (`FDASH_FORCE=1`, `E2E_PARALLELISM=2`) and the times fdash records with each pass:

| Tier | What ran | Time |
| --- | --- | --- |
| `lint`, `build`, `test:unit` (`static`) | 18 lints, 3 builds, 10 unit suites, in parallel | the server's race tests take 29 s, fdash's own tests 14 s, every other task under 5 s |
| `test:integration` | 6 suites against the testbed, in parallel | hq-pets 31 s, hq-cards 21 s, hq-chess 19 s, sdk 13 s, Old Maid and Last Card about 4 s each |
| `test:e2e` | the `e2e/` suite (26 scenarios, two shards) and the 4 plugin e2e projects | about 20 min for the suite; hq-chess-e2e 32 s, hq-cards-e2e 30 s alone |
| whole gauntlet | everything above, nothing cached | 22 min |

Outputs in the cache, per stored pass: the server binary 63 MB (the Windows build, with its debug information), `web/dist` 2.3 MB, `site/dist` 3.7 MB. CI keeps only the records a run used, so its cache grows by about one copy of each per key in use. The size of a CI cache with outputs is not measured yet: records are published by runs on `main` only.

Not measured: these times on CI's runners, and on Linux or macOS.

## Consequences

- **Performance:** a change to one plugin reruns that plugin's tests and those of the projects that depend
  on it, no longer the server's Go tests; touching the web client reruns the plugin e2e projects, not the
  plugins' unit or integration tests. A plugin e2e project starts no LiveKit. An integration test file pays
  for starting a testbed (a process and a database), and every integration test needs the server binary
  built first. Measured times are in the section above; none is stated elsewhere.
- **Coverage:** the plugins' integration tests run the plugin through the real transport (HTTP, WebSocket,
  QuickJS host) instead of the host's Go API, so a break in the protocol shows there too. The race detector
  covers them only on CI (the binary is built with `-race` on Linux); locally on Windows it is built without,
  so no C compiler is needed. The host's own races stay covered by its Go tests.
- **Cache size:** stored outputs add the server binary, `web/dist` and `site/dist` to `.fdash/cache` and to the
  CI artifacts of `main` (measured above). Records made before this change have no outputs: right after the
  merge, the builds run once more, each with a `WARN cache miss` line.
- **Risk:** the testbed is a second way to start the server. It lives in its own package and command, and
  its endpoints exist only in that process; a production `HQ_ENV` refuses to start it. A test that sleeps
  instead of waiting for a message is a defect.
- **Maintenance:** the testbed package and command (about 550 lines of Go, plus their tests), the client
  (about 500 lines of TypeScript), the plugin e2e runner (about 170 lines), and fdash's ordering and output
  caching. About 2,100 lines of Go plugin tests were replaced by `.ispec.ts` files in the plugins. A new
  tier for a project is a task with a conventional name in its `fdash.json`.
- **Install:** nothing new for the server or its operators. To run a plugin's integration or e2e tests, build
  the binary from source (`node tools/fdash/cli.ts run build --pkg server`, or `go build ./cmd/homequarters`)
  or point `HQ_BIN` at one; the e2e projects also need `web/dist` and Chrome. The branch protection of `main`
  must require the new `unit` check in place of `static`.
