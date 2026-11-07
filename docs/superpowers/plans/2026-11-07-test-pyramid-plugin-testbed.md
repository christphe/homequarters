# Test pyramid and plugin testbed: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task also runs the repository's gauntlet (`.agents/skills/gauntlet/SKILL.md`): brief, red checks, gates, critics.

**Goal:** plugins own their unit, integration and e2e tests; integration runs against `homequarters testbed` (the real server without LiveKit); fdash runs conventional task names across projects with `--pkg`, an ordering graph and output caching; CI runs three jobs.

**Architecture:** fdash first (names, `--pkg`, graph, outputs), then the repository's projects moved to the conventions, then the Go testbed and its TS client, then the migration of the bundled plugins' Go tests and browser scenarios into the plugins and their e2e projects, then docs.

**Tech Stack:** Go 1.27 (server, `internal/testbed`), TypeScript run by Node 24 as is (fdash, client, tests), `node --test`, puppeteer-core (browser scenarios), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-07-test-pyramid-plugin-testbed-design.md`

## Global Constraints

- One pull request: #54, branch `test-pyramid-plugin-testbed`.
- Conventional task names: `build`, `lint`, `test:unit`, `test:integration`, `test:e2e`. No `format` task. fdash knows none of these names.
- A task name runs in every project that defines it; `--pkg <project>` restricts (repeatable; error when the project lacks the task). No `<project>:<task>` form on the CLI.
- Order: task X of a project runs after task X of each `dependsOn` project, transitively, walking through projects that lack X; inside a project, only the edges the project declares. Nothing else triggers a `build`.
- Outputs: declared `outputs` are part of the key; stored on pass; restored on hit (overwriting disk); outputs missing from the cache are a miss with `WARN cache miss <task>: outputs not in the cache`.
- The testbed refuses `HQ_ENV=production`; its `/api/testbed/` endpoints exist only in the testbed process (never registered by `httpapi`).
- Clients never send positions (invariant 1): placement writes a member's saved position while they are offline, then they join.
- A plugin project depends on `server` and `sdk` (card games also on `hq-cards`), never on `web` or its e2e project. `server` depends on no plugin.
- Outside plugin authors are out of scope; docs say to build the binary from source and set `HQ_BIN`.
- Not in this PR: `server/integration/`, the browser-suite audit, `release:*`, coverage.
- Everything in English; changelog entry with `fchange added "..." (#54) --pkg server` (draft PR already open).
- Tooling TypeScript: erasable syntax only, `import type`, relative imports with `.ts`.
- Calls made while planning (the spec left them open): integration tests are `**/*.ispec.ts` (user, 2026-11-07; run with `node --test "**/*.ispec.ts"`, never matched by the unit glob `test/*.test.ts`); the e2e projects live in `plugins/e2e/<plugin>-e2e/` (outside the plugin folder, so neither the plugin's inputs nor the Docker image include them); test-only endpoints are served by `internal/testbed`'s own mux, `httpapi` gets only `PluginDirs`.

## Review Focus

1. A fresh CI runner with main's `.fdash/cache` but no `bin/` or `web/dist`: `build` must restore or rebuild, never "cached" with nothing on disk. Test in Task 3.
2. `git`-ignored outputs (`bin/`, `web/dist/`): output resolution must read the disk, not `git ls-files`. Test in Task 3.
3. Two plugin integration suites running at once (fdash `--jobs`): each testbed on its own free port and temp database, no shared file. Test in Task 7.
4. A testbed whose parent test process dies: the server must stop (stdin closed) and leave no listening port. Test in Task 6.
5. A plugin test waiting for a message that never comes: it fails within its timeout with the last messages seen, never hangs the run. Test in Task 7.

---

### Task 1: fdash names with colons, run by name across projects, `--pkg`

**Files:**
- Modify: `tools/fdash/workspace.ts`, `tools/fdash/cli.ts`, `tools/fdash/config.ts`, `tools/fdash/run.ts`
- Test: `tools/fdash/test/workspace.test.ts`, `tools/fdash/test/cli.test.ts`

**Interfaces:**
- Produces: `Config` keys stay `<project>:<task>` internally (`server:test:unit`); new `select(config: Config, names: string[], pkgs: string[]): string[]` in `workspace.ts` returning the qualified commands/groups to run; `Args` gains `pkgs: string[]`. A workspace group member that is a bare name means that name in every project defining it (or the workspace task of that name). Project groups reference their own tasks by bare name (colons allowed).

- [ ] **Step 1: Write failing tests** in `workspace.test.ts`: a fixture workspace with projects `a` (tasks `test:unit`, `lint`) and `b` (`test:unit`): `select(cfg, ["test:unit"], [])` → `["a:test:unit","b:test:unit"]`; `select(cfg, ["test:unit"], ["b"])` → `["b:test:unit"]`; `select(cfg, ["lint"], ["b"])` throws `/b has no task lint/`; a workspace task named `test:unit` alongside project ones throws `/both a workspace task and a project task/`; a project group `{ "tasks": ["test:unit"] }` resolves to its own `a:test:unit`. In `cli.test.ts`: `parseArgs(["run","test:unit","--pkg","a","--pkg","b"], {}, 4).pkgs` → `["a","b"]`; `--pkg` without a value throws.
- [ ] **Step 2: Run** `node --test tools/fdash/test/*.test.ts` → the new tests FAIL.
- [ ] **Step 3: Implement**: remove the `*:` expansion and `qualify`'s colon rule (a member is first a task of the same project, else a bare name across projects, else a workspace task); add `select`; `cli.ts` passes `pkgs` to it and `list` filters by `--pkg`; update `USAGE`; `checkName` no longer suggests `<project>:<task>`.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `fdash: task names with colons, run by name across projects, --pkg`.

### Task 2: fdash ordering graph

**Files:**
- Modify: `tools/fdash/workspace.ts` (keep `dependsOn` order per project), `tools/fdash/config.ts` (new command/group key `after: string[]`, names of tasks of the same project), `tools/fdash/run.ts`
- Test: `tools/fdash/test/run.test.ts`, `tools/fdash/test/workspace.test.ts`

**Interfaces:**
- Consumes: `select` (Task 1).
- Produces: `Config` command entries gain `after: string[]` (qualified, computed): the same task of the nearest `dependsOn` projects that define it (walking through those that do not) plus the project's own declared `after`. `run()` starts a command only once all of its `after` that are part of this run have finished; a failed predecessor fails the dependent without running it (`FAIL <name> (after <pred> failed)`). Predecessors not selected by the run are not started (no implicit build).

- [ ] **Step 1: Write failing tests** in `run.test.ts` with commands that append their name to a file: projects `server` ← `hq-cards` ← `hq-card-pouilleux` (hq-cards has no `test:integration`): running `test:integration` writes `server` before `hq-card-pouilleux`; in-project `after: ["build"]` writes `build` before `test:integration` only when `build` is in the run; `--pkg hq-card-pouilleux` alone does not run `server:test:integration`; a cycle (`after` both ways) throws at load `/cycle/`; a predecessor that fails makes the dependent FAIL without its file line.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the edges in `loadWorkspace` (after `select` resolves names), cycle check in `finishConfig`, and in `run.ts` a per-command promise map awaited before `command(c)`; keep `jobs` as the concurrency bound.
- [ ] **Step 4: Run** `node --test tools/fdash/test/*.test.ts` → PASS.
- [ ] **Step 5: Commit** `fdash: tasks ordered by the project graph and per-project after`.

### Task 3: fdash output caching

**Files:**
- Modify: `tools/fdash/config.ts` (command key `outputs: string[]`, patterns relative to the project, `/` for the root), `tools/fdash/cache.ts`, `tools/fdash/run.ts`
- Test: `tools/fdash/test/cache.test.ts`, `tools/fdash/test/run.test.ts`

**Interfaces:**
- Produces: `cacheKey` includes `outputs`; `storeOutputs(dir, name, key, root, files: string[]): void` and `restoreOutputs(dir, name, key, root): "restored" | "missing"` in `cache.ts`; `resolveOutputs(root, patterns): string[]` reading the disk with `fs.globSync` (ignored files included). On a hit with outputs `"missing"`, `run` writes `WARN cache miss <name>: outputs not in the cache` through `onResult`'s reporter (a `warn` field on `Result`) and runs the command.

- [ ] **Step 1: Write failing tests**: a command writing `out/a.txt` with `outputs: ["out/**"]` passes, `out/` is deleted, a second run is CACHED and `out/a.txt` is back with the same content; a stale `out/a.txt` on disk is overwritten on a hit; a record from before outputs existed (record file present, no stored outputs) runs again and the result carries `warn: "outputs not in the cache"`; changing `outputs` changes the key; an output under a `.gitignore`d folder is stored.
- [ ] **Step 2: Run** `node --test tools/fdash/test/cache.test.ts tools/fdash/test/run.test.ts` → FAIL.
- [ ] **Step 3: Implement** storage as plain copies under `<cacheDir>/<record name>-<key>.out/` (relative paths kept); `cli.ts` prints `WARN ...` lines.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fdash: outputs stored with a pass and restored on a hit`.

### Task 4: the repository's projects on the conventions; three CI jobs

**Files:**
- Modify: `fdash-workspace.json`, `server/fdash.json`, `web/fdash.json`, `site/fdash.json`, `e2e/fdash.json`, `scripts/fdash.json`, `tools/fdash/fdash.json`, `plugins/sdk/fdash.json`, `plugins/bundled/*/fdash.json`, `scripts/oxlint.ts`, `scripts/gauntlet.ts`, `scripts/gauntlet.sh`, `scripts/ci-fdash-records.ts`, `.github/workflows/ci.yml`, `e2e/run.ts`
- Create: `docs/fdash.json` (project `docs`), `plugins/bundled/hq-pets/fdash.json`
- Test: `scripts/gauntlet.test.ts`, `scripts/ci-fdash-records.test.ts` (update)

**Interfaces:**
- Produces: tasks per project:
  - `server`: `lint` (`gofmt -l .` failOnOutput, `go vet ./...`, `go tool staticcheck ./...`), `build` (`go build -o ../bin/homequarters<.exe> ./cmd/homequarters`, `outputs: ["/bin/homequarters*"]`, `envKeys` incl. `GOFLAGS`, `CGO_ENABLED`), `test:unit` (`go test -race -count=1 ./...`, inputs no longer list `/plugins/**`).
  - `web`: `lint` (tsc, tsc-tests, tsc-sdk, oxlint on `src` and `test`), `build` (`vite build`, `outputs: ["dist/**"]`), `test:unit`.
  - `site`: `lint` (tsc, oxlint), `build` (`node build.ts`, outputs `dist/**`), `test:unit` (`node check.ts`, `after: ["build"]`).
  - `e2e`: `lint` (tsc, oxlint), `test:unit`, `test:e2e` (former `browser`, env `E2E_PREBUILT=1`, items unchanged minus `chess` and `cards`).
  - `scripts`, `fdash` (`tools/fdash`): `lint` (oxlint on their folder), `test:unit`.
  - `docs`: `lint` = `node ../scripts/check-protocol-docs.ts`, inputs `/server/internal/httpapi/ws.go`, `/web/src/net/protocol.ts`, `protocol.md`.
  - each plugin: `lint` (oxlint on its folder + `tsc -p tsconfig.json --noEmit`), `test:unit`; `dependsOn` gains `server`.
  - workspace: `default` = `["lint", "build", "test:unit", "test:integration", "test:e2e"]`, `jobs` as today; `desktop-types` becomes `lint` of a `desktop` entry in `projects` (with a `desktop/fdash.json`) if it reads only `desktop/`; otherwise stays a workspace command.
- `e2e/run.ts`: `E2E_PREBUILT=1` skips its own build and records normally (the task's inputs are the sources).
- `scripts/oxlint.ts <folder...>`: lints the folders given (default: all, for a manual run).
- CI jobs `unit` (`fdash run lint build test:unit`), `integration` (`fdash run build test:integration`, `GOFLAGS=-race`, `CGO_ENABLED=1`), `e2e` (matrix of 4 shards, `fdash run build`, then `test:e2e` for the shard's items and e2e projects).

- [ ] **Step 1: Red**: `node tools/fdash/cli.ts list` with the new `fdash-workspace.json` written first fails (members missing) — record the output.
- [ ] **Step 2: Rewrite** the `fdash.json` files and `fdash-workspace.json` as above; `scripts/check-plugin-types.ts` is removed once every plugin's `lint` type-checks its own `tsconfig.json` (e2e fixtures plugins get their check in `e2e`'s `lint`).
- [ ] **Step 3: Run** `node tools/fdash/cli.ts list` → every project lists its tasks; `node tools/fdash/cli.ts run lint build test:unit` → all PASS; run it again → all CACHED; delete `bin/` and `web/dist/`, run `build` → CACHED and both are back.
- [ ] **Step 4: Update** `scripts/gauntlet.ts`/`gauntlet.sh` (whole run = `default`; scenario args go to `test:e2e --pkg e2e -- <scenarios>`), `ci-fdash-records.ts` (artifact names per job), `ci.yml`; `node --test scripts/*.test.ts` → PASS.
- [ ] **Step 5: Commit** `Projects on the conventional tasks; CI in three jobs`.

### Task 5: Go `internal/testbed` and plugins loaded from explicit folders

**Files:**
- Modify: `server/internal/plugin/catalog.go` (export `LoadDirs(dirs []string) []Info`: each folder loaded with source `Bundled` when its parent folder is named `bundled`, else `Installed`; then `dedupe`), `server/internal/config/config.go` (`PluginDirs []string`, never read from the environment), `server/internal/httpapi/plugins.go` (`setupPlugins` uses `LoadDirs` when `PluginDirs` is set)
- Create: `server/internal/testbed/testbed.go`, `server/internal/testbed/testbed_test.go`, `server/internal/plugin/catalog_dirs_test.go`

**Interfaces:**
- Produces:
  ```go
  type Options struct { Plugins []string; Addr, Static, DB string; Log *slog.Logger }
  type Bed struct { URL string /* http://127.0.0.1:PORT */ }
  func Start(ctx context.Context, o Options) (*Bed, error) // refuses HQ_ENV=production
  func (b *Bed) Close() error                               // graceful stop; removes the temp DB unless o.DB was given
  ```
  `Start` opens the store (temp dir unless `DB`), `EnsureOffice` with `gamemap.Default()`, enables every loaded plugin with `SetPluginEnabled` and an audit row (`plugin.enable`, detail `testbed`), builds `config.Config` as `newRig` does (dev, `JoinRate` 5000, `PluginDirs`, `StaticDir` = `Static`, no LiveKit), listens on `Addr` (default `127.0.0.1:0`), and serves `httpapi`'s handler wrapped by a mux that adds:
  - `POST /api/testbed/position` `{"id":N,"x":tx,"y":ty}`: `SaveLastPos(office, id, tx*16+8, ty*16+8)`; 409 when the member is online.
  - `GET /api/testbed/kv/{plugin}`: the plugin's stored keys and values (JSON object).
  - `PUT /api/testbed/kv/{plugin}`: replaces them; 409 while the plugin is enabled.
  - `GET /api/testbed/errors`: `{"<plugin>": count}` of `plugin error` log records, counted by a `slog.Handler` wrapping `o.Log` (attribute `plugin`).

- [ ] **Step 1: Write failing tests**: `LoadDirs` on `testdata` folders (`bundled/hq-x` → Bundled, `other/mine` → Installed, a twin name refused); `testbed_test.go` starts a bed with `server/internal/httpapi/testdata/plugins/installed/echo`, joins over HTTP, sees `echo` running in `/api/plugins`, places a member and checks the `hello`'s position, seeds and reads KV (409 while enabled), counts an error raised by a fixture plugin; `Start` with `HQ_ENV=production` returns an error.
- [ ] **Step 2: Run** `cd server && go test ./internal/testbed ./internal/plugin -run 'LoadDirs|Testbed' -race` → FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** → PASS; `go vet ./... && go tool staticcheck ./...` clean.
- [ ] **Step 5: Commit** `Testbed: the real server without LiveKit, plugins from explicit folders, test-only endpoints`.

### Task 6: `homequarters testbed` subcommand

**Files:**
- Modify: `server/cmd/homequarters/main.go` (when `os.Args[1] == "testbed"`, run `testbedMain(os.Args[2:])` before `flag.Parse`)
- Create: `server/cmd/homequarters/testbed.go`, `server/cmd/homequarters/testbed_test.go`

**Interfaces:**
- Consumes: `testbed.Start`, `Options` (Task 5).
- Produces: `homequarters testbed --plugin DIR [--plugin DIR]... [--addr A] [--static DIR] [--db FILE]`; prints exactly one line `{"url":"http://127.0.0.1:PORT"}` on stdout once listening, logs JSON on stderr; stops on stdin EOF, SIGINT, SIGTERM; exit 2 on bad flags or `HQ_ENV=production`.

- [ ] **Step 1: Write failing tests** (build the binary in `TestMain` into `t.TempDir()`): the first stdout line parses as `{"url":...}` and `/healthz` answers; closing stdin ends the process within 10 s and the port no longer accepts; `HQ_ENV=production` exits 2 with nothing on stdout; `--db` kept after exit, the default temp DB removed.
- [ ] **Step 2: Run** `cd server && go test ./cmd/homequarters -run Testbed` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `homequarters testbed: start the testbed from the command line`.

### Task 7: TS client `plugins/sdk/testbed.ts`

**Files:**
- Create: `plugins/sdk/testbed.ts`, `plugins/sdk/test/testbed.ispec.ts`
- Modify: `plugins/sdk/fdash.json` (`dependsOn: ["server"]`, `test:integration` = `node --test **/*.ispec.ts`)

**Interfaces:**
- Consumes: the subcommand (Task 6); binary at `HQ_BIN`, else `<repo>/bin/homequarters[.exe]` (found by walking up from the client file), else `homequarters` on PATH; none → throws `no homequarters binary: run "fdash run build" first (or set HQ_BIN)`.
- Produces:
  ```ts
  export type Tile = { x: number; y: number };
  export function testbed(o: { plugins: string[]; static?: string; timeoutMs?: number }): Promise<Testbed>;
  export interface Testbed {
    url: string;
    join(name: string, o?: { at?: Tile }): Promise<Member>; // first member is the administrator
    placeObject(kind: string, at: Tile): Promise<void>;     // admin map API (GET /api/admin/map, PUT /api/map)
    setPlugin(name: string, enabled: boolean): Promise<void>;
    kv(plugin: string): Promise<Record<string, string>>;
    seedKv(plugin: string, data: Record<string, string>): Promise<void>; // disable, PUT, enable
    errors(): Promise<Record<string, number>>;
    restart(): Promise<void>; // same database; members reconnect with reconnect()
    close(): Promise<void>;
  }
  export interface Member {
    id: number; name: string;
    send(plugin: string, d: unknown): void;           // {"t":"plg","pl":plugin,"d":d}
    use(at: Tile): void;                              // {"t":"use","x":..,"y":..}
    received(plugin: string): unknown[];              // plugin frames' d, in order
    waitFor<T>(plugin: string, pred: (d: any) => boolean, timeoutMs?: number): Promise<T>; // timeout → Error listing the last 5 frames
    quiet(plugin: string, ms: number): Promise<void>; // throws if a frame arrives within ms
    leave(): Promise<void>; reconnect(o?: { at?: Tile }): Promise<void>;
  }
  ```
  Each `testbed()` spawns its own process with `--addr 127.0.0.1:0` and `--db` in its own temp dir (removed by `close`), stdin piped so the process dies with the test.

- [ ] **Step 1: Write failing tests** against the `echo` fixture (`server/internal/httpapi/testdata/plugins/installed/echo`): a member's message comes back; `waitFor` on a frame that never comes rejects within its timeout and names the last frames; two beds at once get different URLs; `restart` keeps KV; `quiet` throws when a frame arrives; no binary → the documented error.
- [ ] **Step 2: Run** `node tools/fdash/cli.ts run build test:integration --pkg server --pkg sdk` → FAIL.
- [ ] **Step 3: Implement** with global `fetch` and `WebSocket` only.
- [ ] **Step 4: Run** → PASS; `lint` of `sdk` PASS.
- [ ] **Step 5: Commit** `Plugin SDK: testbed client for integration tests`.

### Task 8: hq-chess integration tests

**Files:**
- Create: `plugins/bundled/hq-chess/test/chess.ispec.ts`
- Modify: `plugins/bundled/hq-chess/fdash.json` (`test:integration`)
- Delete: `server/internal/plugin/chess_test.go` (its helpers used elsewhere move to the file that still needs them)

**Interfaces:** Consumes the Task 7 client.

- [ ] **Step 1: Write the tests**: one `test(...)` per Go test of `chess_test.go` (`TestChessOpensOnUse` … `TestChessUndoSurvivesRestart`, 20 tests), same names in words, same assertions, through the client: `placeObject("chessboard", …)`, `join(…, { at })`, `use`, `send`, `waitFor`; storage checks through `kv("hq-chess")`; "plugin never threw" through `errors()`; refused actions checked with a probe message the plugin answers (`hello`) and asserting nothing arrived before its answer; `quiet` only where no probe exists, with a comment why.
- [ ] **Step 2: Red**: break the plugin API on purpose (rename `hq.send` in the host's `install()`), run `fdash run build test:integration --pkg hq-chess` → FAIL; revert.
- [ ] **Step 3: Run** → PASS three times in a row; delete `chess_test.go`; `go test ./internal/plugin` PASS.
- [ ] **Step 4: Commit** `hq-chess: integration tests against the testbed, out of the server`.

### Task 9: hq-cards, Old Maid and Last Card integration tests

**Files:**
- Create: `plugins/bundled/hq-cards/test/cards.ispec.ts`, `plugins/bundled/hq-card-pouilleux/test/oldMaid.ispec.ts`, `plugins/bundled/hq-card-lastcard/test/lastCard.ispec.ts`
- Modify: their `fdash.json` (`test:integration`; variants start the bed with `plugins: [hq-cards dir, own dir]`)
- Delete: `server/internal/plugin/{cards,oldmaid,lastcard}_test.go`

- [ ] **Step 1: Write the tests**: one per Go test (cards 17, Old Maid 2, Last Card 1), same names and assertions; the 4096-byte and freed-keys checks through `kv`.
- [ ] **Step 2: Red** as in Task 8 (a broken `hq.plugins.call` fails all three suites); revert.
- [ ] **Step 3: Run** `fdash run build test:integration --pkg hq-cards --pkg hq-card-pouilleux --pkg hq-card-lastcard` → PASS; delete the Go files; `go test ./internal/plugin` PASS.
- [ ] **Step 4: Commit** `Card plugins: integration tests against the testbed, out of the server`.

### Task 10: hq-pets integration tests; the server reads no bundled plugin

**Files:**
- Create: `plugins/bundled/hq-pets/test/pets.ispec.ts`
- Modify: `plugins/bundled/hq-pets/fdash.json` (Task 4 created it), `server/fdash.json` (no `/plugins/**`, no `/web/dev/**` unless still read)
- Delete: `server/internal/plugin/sample_test.go`

- [ ] **Step 1: Write the tests**: the 9 `TestSample*` tests; the 60-80-member cases seed KV with `seedKv` and join the members over sockets.
- [ ] **Step 2: Run** `fdash run build test:integration --pkg hq-pets` → PASS.
- [ ] **Step 3: Check** `grep -rn "plugins/bundled\|\.\./\.\./\.\./plugins" server --include=*.go` → nothing; `go test -race ./...` PASS.
- [ ] **Step 4: Commit** `hq-pets: integration tests against the testbed; the server tests read no bundled plugin`.

### Task 11: plugin e2e runner and `hq-chess-e2e`

**Files:**
- Create: `e2e/plugin-run.ts`, `plugins/e2e/hq-chess-e2e/fdash.json`, `plugins/e2e/hq-chess-e2e/chess.ts` (from `e2e/scenarios/chess.ts`), `plugins/e2e/hq-chess-e2e/tsconfig.json`
- Modify: `fdash-workspace.json` (`projects` gains `plugins/e2e/*`), `e2e/fdash.json` (drop item `chess`), `e2e/shards.ts` (balances items and the e2e projects), `.github/workflows/ci.yml`
- Delete: `e2e/scenarios/chess.ts`

**Interfaces:**
- Produces: `node e2e/plugin-run.ts --plugin DIR [--plugin DIR]... SCENARIO.ts...`: takes an e2e slot (`e2e/slots.ts`), starts `homequarters testbed` with `--static web/dist` on the slot's server port, joins the administrator as `run.ts` does, gives each scenario a `RunContext` with `adminCookie`, `adminId`, `dir`, `bin` (`startServer`/`stopServer`/`defer` throw "not available without LiveKit"), sets `HQ_APP`/`HQ_API`, writes `FDASH_REPORT`, prints `ALL SCENARIOS PASSED` or `SOME CHECKS FAILED`. No LiveKit.
- `hq-chess-e2e`: `dependsOn: ["hq-chess", "web"]`; `test:e2e` with inputs `/e2e/lib.ts`, `/e2e/plugin-run.ts`, `/e2e/slots.ts`, `/e2e/globals.d.ts`.

- [ ] **Step 1: Red**: `fdash run test:e2e --pkg hq-chess-e2e` → no such project.
- [ ] **Step 2: Implement** the runner and move the scenario (imports now `../../../e2e/lib.ts` and `../../bundled/hq-chess/public/*`).
- [ ] **Step 3: Run** `fdash run build test:e2e --pkg hq-chess-e2e` → every check of the former scenario PASS, with no LiveKit running (`livekit-server` not on PATH for the run).
- [ ] **Step 4: Commit** `hq-chess-e2e: the chess browser scenario as its own project, without LiveKit`.

### Task 12: `cards.ts` split into three e2e projects

**Files:**
- Create: `plugins/e2e/hq-cards-e2e/{fdash.json,cards.ts,tsconfig.json}` (empty table), `plugins/e2e/hq-card-pouilleux-e2e/{…,oldMaid.ts}` (Old Maid only), `plugins/e2e/hq-card-lastcard-e2e/{…,lastCard.ts}` (Last Card only)
- Modify: `e2e/fdash.json` (drop item `cards`), `e2e/shards.ts`
- Delete: `e2e/scenarios/cards.ts`

- [ ] **Step 1: List** every `check(...)` of `cards.ts` with the project it goes to (table, Old Maid, Last Card); the list goes in the PR.
- [ ] **Step 2: Move** them; the variants' projects depend on their plugin and `web`, and start the bed with `hq-cards` and the variant.
- [ ] **Step 3: Run** `fdash run build test:e2e --pkg hq-cards-e2e --pkg hq-card-pouilleux-e2e --pkg hq-card-lastcard-e2e` → PASS; the count of checks equals the former scenario's.
- [ ] **Step 4: Check** the platform scenarios `plugins`, `a11y`, `offline`: drop `/plugins/bundled/**` from their items' inputs when they load no bundled plugin; note the verdict per scenario in the PR.
- [ ] **Step 5: Commit** `Card e2e projects: table, Old Maid and Last Card scenarios split out`.

### Task 13: documentation, changelog, gates, critics

**Files:**
- Create: `docs/decisions/0037-test-pyramid.md`
- Modify: `docs/decisions/0035-fdash.md`, `tools/fdash/README.md`, `docs/plugins.md` ("Testing a plugin"), `docs/gauntlet.md`, `AGENTS.md` (commands, repository map with `server/internal/testbed`, `plugins/e2e/`, testing notes), `docs/status.md`, `README.md` status table, `site/build.ts` `NAV` only if a page is added, `server/CHANGELOG.md`

- [ ] **Step 1: Write** the ADR: tiers, testbed, conventions, graph, outputs; measured times per tier from this branch's runs (cold and cached) and the CI cache size added by outputs.
- [ ] **Step 2: Changelog**: `fchange added "homequarters testbed: the server without LiveKit, with the given plugins enabled, for plugin integration tests (#54)" --pkg server`.
- [ ] **Step 3: Run** `node scripts/gauntlet.ts` (whole suite) → `GATES GREEN`; record which tasks ran and which were cached.
- [ ] **Step 4: Critics** per the gauntlet skill (UX, invariants, regression, cli-tools); fix blockers and majors; rerun gates.
- [ ] **Step 5: Commit** `Docs: test pyramid, testbed, fdash conventions`; push; mark the PR ready only on the user's word.
