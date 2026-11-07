# fdash, its cache, and the gauntlet on top of it (steps A, B and C, one pull request)

## Intent

The browser suite takes about 20 minutes serial, and every change reruns everything. The goal over three
steps is to stop rerunning what has not changed and to move every check that needs no browser into unit
tests.

The work is split between a **generic tool**, **fdash** (run declared tasks in parallel; later, skip those
whose inputs already passed), and the **gauntlet**, Home Quarters' own process (its gates, the record its
critics read, `GATES GREEN`). fdash follows the model of fchange: one small config file at the root
(`fdash.json`, like `fchange.json`), no knowledge of the project. Unlike fchange it is **not published**:
it lives in this repository (`tools/fdash/`) until it is proven, so anyone who clones can run it with Node
alone, and it evolves in the same pull requests as its use.

All three steps land in one pull request (the user's choice), in this order:

- **Step A**: fdash runs tasks, the gates move into `fdash.json`, the gauntlet calls fdash.
  Same gates and same report as `gauntlet.sh` today; new: static gates in parallel, any OS, no bash.
- **Step B**: fdash's cache (section "Step B" below).
- **Step C**: the browser suite cached per scenario, and `cards` slimmed down to what needs a browser
  (section "Step C" below).

## Approaches considered

- **moon**: project graph, inputs per task, a remote cache over the Bazel protocol. Rejected for now: a
  structuring dependency maintained by a small team, a breaking v1 to v2 migration, Go and Rust through
  WASM plugins less mature than JS.
- **Turborepo, Nx**: JS-first; their graph comes from `package.json` workspaces, and here the manifests
  link nothing (`e2e` runs the Go binary and serves `web/dist`, plugins reach `plugins/sdk` through a
  tsconfig, the site reads `docs/`): a manifest graph would be nodes without edges.
- **Task (go-task), mise**: skip-if-unchanged, local only; no gain over our own code for one more dependency.
- **One "gauntlet" script that does everything** (the first version of this document): mixes a generic
  runner with the project's process. Rejected for the split above.
- **fdash in its own repository, published like fchange**: rejected for now: releases to synchronise while
  it is iterated on, and a clone would not run until it is published.

## fdash (generic, `tools/fdash/`)

- Plain TypeScript run by Node (types stripped natively; no TypeScript-only runtime syntax), zero
  dependency, no import from outside `tools/fdash/`, no mention of Home Quarters. Its own README (config,
  CLI, API) and its own tests in `tools/fdash/test/`.
- **Config `fdash.json`** at the repository root:

  ```json
  {
    "tasks": {
      "default": { "jobs": 1, "tasks": ["static", "e2e"] },
      "static": { "tasks": ["gofmt", "site-build"] },
      "gofmt": { "cwd": "server", "run": [["gofmt", "-l", "."]], "failOnOutput": true },
      "site-build": { "cwd": "site", "run": [["node", "build.mjs"], ["node", "check.mjs"]] },
      "e2e": { "cwd": "e2e", "run": [["node", "run.mjs"]], "env": { "E2E_VIEWPORT": "small" }, "args": true }
    }
  }
  ```

  Two kinds of task. A **command** has `run`, a list of steps, each an argv (no shell parsing); the first
  failing step fails it. `failOnOutput`: anything on stdout fails it. `env` is added to the inherited
  environment. `args`: extra arguments given to fdash are appended to its last step. A **group** has
  `tasks`, the names of its members (commands or groups), and an optional `jobs`: how many of its members
  run at once; without `jobs`, the global value. A group runs every member even when one fails, and fails
  when any member failed. A task is a command or a group, never both. Unknown keys, bad types, a name that
  does not exist and a cycle between groups are refused with a message naming the task. A command reached
  twice in one run runs once.
- **Running**: `fdash run` without a name runs the task `default`; with names, those tasks. The global
  `jobs` is `--jobs N` or `FDASH_JOBS` (default half the logical CPUs, at least 1). `--skip <name>` leaves a
  task out wherever it appears. Results are reported per command. In step C, `e2e` becomes a group of one
  command per scenario with `"jobs": 1`. Each task's stdout and
  stderr go to its own log file in a temp folder. A missing command is a failed task with the spawn error
  in its log, not a crash. On Windows a command that resolves to a `.cmd` or `.bat` (`pnpm`) is spawned
  through the shell; nothing else is. Ctrl+C: no new task starts, running children get the signal from the
  terminal and finish, the run reports itself interrupted.
- **CLI**: `node tools/fdash/cli.ts run [task ...] [--skip task ...] [--jobs N] [-- extra args]` prints one
  `PASS <task>` / `FAIL <task> (log: <path>)` line per task as it finishes, with the last 15 lines of a
  failed task's log indented by 5 spaces; exit code = number of failed tasks, 130 when interrupted.
  `node tools/fdash/cli.ts list` prints the tasks in order.
- **API** (for the gauntlet): `run({ root, tasks?, skip?, jobs?, extraArgs?, onResult? })` resolves with
  each task's result (name, ok, log path, duration) in config order and whether it was interrupted.

## The gauntlet (Home Quarters, `scripts/gauntlet.ts`)

- `fdash.json` holds the gates of `gauntlet.sh` at the baseline, same names, order and commands: gofmt,
  go-vet, staticcheck, go-test-race, tsc, tsc-tests, vite-build, protocol-docs, oxlint, plugin-types,
  web-unit (plus fdash's and the gauntlet's own tests), site-build, e2e. The group `static` holds the
  twelve static gates (no `jobs`: the global value); `default` is `{ "jobs": 1, "tasks": ["static", "e2e"] }`.
  With step B every gate declares its `inputs` (wider when in doubt: `site-build`, which checks links to
  any repository file, takes the whole tree but `site/dist` and `node_modules`), and `tools` for the
  toolchain versions it depends on (`go version`, `pnpm --version`).
- `scripts/gauntlet.ts` keeps what belongs to the process: the scenario arguments (passed to e2e),
  `GAUNTLET_SKIP_E2E=1` (skips e2e, prints `SKIPPED e2e`), the tree fingerprint (same rules as today:
  index, diff against HEAD, untracked non-ignored files, leaving out `server/CHANGELOG.md`,
  `desktop/CHANGELOG.md` and `docs/superpowers`; the hex value may differ from bash's), the record
  `.gauntlet/last-gates.log` (same header, `PASS`/`FAIL` lines in gate order, `GATES GREEN` /
  `GATES RED: N failed` / `STATIC GATES GREEN; browser verification SKIPPED`, `finished <time>`), and
  `FAIL working tree changed during gates; rerun on the final tree`. Exit code = number of failures.
- `scripts/gauntlet.sh` stays as one line, `exec node "$(dirname "$0")/gauntlet.ts" "$@"`, so docs, skills
  and the PR template keep working. `E2E_PARALLELISM` still reaches e2e through the environment.

## Step B: the cache

- A command may declare **`inputs`**; a command without `inputs` is never cached. Each input is either a
  path pattern relative to the root (git glob pathspec, `**` allowed; a leading `!` excludes), resolved to
  the tracked and untracked non-ignored files that match (so git is required for cached commands), or a
  **provider** `{ "go": "<package pattern>", "cwd": "<module dir>", "tests": <bool> }`: the files of every
  package of that module reached by `go list -deps` from the pattern (`GoFiles`, `CgoFiles`, `EmbedFiles`,
  and the test files when `tests` is true) plus the module's `go.mod` and `go.sum`. No Vite or Cargo
  provider in this pull request: the web client is described with path patterns (decision: a Vite module
  list would miss `public/`, CSS and HTML, so patterns are needed anyway).
- Optional **`envKeys`** (names of environment variables whose values enter the key) and **`tools`** (argv
  list whose stdout enters the key, for example `[["go", "version"]]`).
- **Key** = SHA-256 of: the command's definition (cwd, run, env, failOnOutput, the extra arguments it
  gets), the values of `envKeys`, the output of `tools`, the OS, the architecture, Node's version, and the
  sorted list of (path, SHA-1 of content, or "missing") of its inputs.
- A pass writes `<cacheDir>/<name>-<key>.json` (`{ "ok": true, "at": <ISO>, "ms": <n> }`); failures are not
  recorded. `cacheDir` is `.fdash/cache` at the root (git-ignored), or `FDASH_CACHE_DIR`. A command whose
  key is there is not run and is reported `CACHED <name>`. `--force` runs everything and still records.
  CI may keep the folder with `actions/cache` (not done in this pull request; CI runs as today).
- **Items**: a command may declare `items`, an ordered map `{ "<item>": { "inputs": [...] } }`, each item
  keyed separately (command inputs + item inputs). When it runs, fdash appends the names of the items not
  already passed to its last step, runs it once, and sets `FDASH_REPORT` to a file where the command
  appends one JSON line per item (`{"item":"cards","ok":true}`). An item missing from the report takes
  the command's exit status. Each item is reported as `<command>:<item>` (`PASS e2e:cards`,
  `CACHED e2e:chess`). With extra arguments, only the items named are considered; an extra argument that
  is not an item makes the run uncached and passes the arguments as given.

## Step C: the browser suite per scenario, and cards

- `fdash.json` declares e2e with one item per scenario of `ALL` (`e2e/shards.mjs`). Shared inputs: the
  server's Go packages reached from `./cmd/homequarters` (provider), the web client (`web/**` without
  `web/test`, `web/dev`, `web/dist`, `web/node_modules`), `e2e/*.mjs`, `e2e/package.json`,
  `e2e/fixtures/**`, every `plugins/bundled/*/plugin.json` (the catalog the admin pages list) and
  `plugins/sdk/**`; `envKeys` `E2E_VIEWPORT`, `E2E_PARALLELISM`, `HQ_EXTERNAL_URL`; `tools`
  `go version`. Each item adds its scenario file; a scenario that turns a bundled plugin on adds that
  plugin's folder (cards: `hq-cards`, `hq-card-*`; chess: `hq-chess`; plugins: every bundled plugin; the
  builder checks each scenario with a search for plugin names and `setPlugin`).
- `e2e/run.mjs` writes one line per scenario to `FDASH_REPORT` when it is set: a scenario passes when its
  checks and its deferred checks passed. `E2E_PARALLELISM` also applies when scenarios are named (today
  it only applies to the whole suite), so a subset still runs in shards.
- `cards.mjs`: every check that tests a rule, a label, a list of buttons or a log sentence rather than
  what only a browser shows moves to `web/test` (extracting a pure function from the plugin's view where
  it is tangled with the DOM), the browser keeping the wiring: real controls, drags, the keyboard, what
  each page draws, sync between pages, a game's own sheet. Each moved check is named in the commit and
  its unit test is seen red first (by breaking the rule) and green after. The duration of `cards` before
  and after goes in `e2e/shards.mjs` and the PR.
- Other scenarios keep their checks in this pull request; a list of the next candidates (plugins, chess,
  presence) goes in the PR text.

## Projects and the workspace (decided after the first runs)

One flat `fdash.json` made every unit test one cache key: touching any file reran all of them. fdash gets
projects, as Rush has: no language awareness (a later step may read `package.json`, `go.mod`, `tsconfig.json`).

- **`fdash-workspace.json`** at the root: `projects`, a list of folders (a `*` matches one level:
  `plugins/bundled/*`; a folder a `*` matches without `fdash.json` is skipped, a folder named in full without one is refused), and `tasks`, the workspace's own
  commands (run from the root, inputs written from the root) and groups.
- **`<project>/fdash.json`**: `name` (default: the folder's name; two projects with one name are refused),
  `files` (what other projects see of it, patterns relative to the project, default `**`), `dependsOn`
  (project names), `tasks`. Task names are `<project>:<task>` (items `<project>:<task>:<item>`).
- **Default inputs** of a project's command: every file of its folder, plus the `files` of its
  `dependsOn`, transitively. The command's own `inputs` add to them (relative to the project; a leading
  `/` is relative to the root; a Go provider's `cwd` is relative to the project), and its `!` patterns
  remove from the whole set. `"cache": false` turns the cache off for a command. A workspace command
  without `inputs` is not cached, as before.
- **References** in a group: a qualified name (`server:test`), a name of the same project (`test`), or
  `*:<task>`: that task in every project that has it, in project order.
- Without `fdash-workspace.json`, a root `fdash.json` is one project whose task names are not qualified
  (the single-file format above keeps working).

The repository's projects: `server` (fmt, vet, staticcheck, test), `web` (tsc, tsc-tests, build, test),
`site` (build), `e2e` (test: shards and slots, browser: the scenarios as items), `scripts` (test,
protocol-docs, oxlint, plugin-types), `tools/fdash` (test), `plugins/sdk` (no task, depended on), and one
project per bundled plugin that has unit tests (`hq-cards`, `hq-card-pouilleux`, `hq-card-lastcard`,
`hq-chess`): their tests move from `web/test/` to `plugins/bundled/<plugin>/test/` (still type-checked by
`web/tsconfig.test.json` and linted by oxlint). The workspace holds `default` and `static`
(`*:fmt`, `*:vet`, ..., `*:test` and the rest). Files a test reads at run time stay declared by hand (web's
tests read `server/internal/gamemap/map.go` and `server/internal/httpapi/avatar.go`; Go's plugin tests read
`plugins/bundled`).

## Non-goals

No language-aware projects. No change to CI's jobs beyond running the new unit tests (no `actions/cache` yet). No change to the e2e
slots. No gate added or removed (Rust's `cargo` checks are a later gate). No Vite or Cargo provider.

## Anti-goals

- A task reported PASS when its command failed, or a stale record that looks current.
- A run that leaves processes behind on Ctrl+C.
- fdash growing project knowledge (a Home Quarters path or name inside `tools/fdash/`).

## Acceptance criteria and seams

1. `fdash.json` lists the gates of `gauntlet.sh` with the same names, order and commands. Seam: a unit test
   reading `fdash.json` against the expected table.
2. fdash: a failing step, a missing command and output under `failOnOutput` each fail their task; a pass
   passes; a group runs at most its `jobs` members at once (the global value when it has none), runs them
   all when one fails, and fails if any failed; `default: { jobs: 1, tasks: [static, e2e] }` starts e2e
   only after every static gate ended; a command reached twice runs once; results come back in config
   order; a bad config (unknown name, cycle, both `run` and `tasks`) is refused naming the task. Seam: fdash
   unit tests with `node -e` tasks.
3. A failing gate prints `FAIL`, its log tail, and the gauntlet ends `GATES RED: 1 failed` with exit code 1.
   Seam: gauntlet unit test on the closing lines; one real run with an unformatted Go file.
4. `GAUNTLET_SKIP_E2E=1` ends `STATIC GATES GREEN; browser verification SKIPPED`. Seam: unit test and a run.
5. The fingerprint ignores the two changelogs and `docs/superpowers` and changes when any other tracked,
   staged, modified or untracked file changes (names with spaces and accents included). Seam: unit test on
   a temporary git repository.
6. A file edited during the run fails it with the "working tree changed" line. Seam: unit test and a run.
7. Serial (`FDASH_JOBS=1`) and default runs both reach `GATES GREEN` on the whole suite; the wall time of
   the static gates for both goes in the PR. Seam: two runs.
8. Runs on Linux, macOS and Windows from any shell, no bash needed. Seam: a run from PowerShell without Git
   Bash on PATH, one on Linux if a Linux shell is available; macOS reported as not verified unless run.
9. `tools/fdash/` imports nothing outside itself and names no Home Quarters path. Seam: a unit test that
   scans its sources for imports leaving the folder.
10. Cache: a second run with nothing changed reports every cached command `CACHED` and runs none; editing
    one input file, an `envKeys` value, the definition or the extra arguments reruns that command only; a
    failed command is not recorded; `--force` reruns; a Go file of a package reached by the provider
    changes the key, a Go file outside them does not. Seam: fdash unit tests on a temporary git
    repository (the Go provider test skipped when `go` is missing).
11. Items: with `FDASH_REPORT` lines, a failed item reruns alone next time; all items cached means the
    command does not run. Seam: fdash unit tests.
12. The gauntlet record shows `CACHED <gate>` lines and counts them as passed. Seam: unit test on the
    record lines; a second real run of the static gates showing them cached.
13. e2e per scenario: after a whole green suite, editing `plugins/bundled/hq-cards/main.ts` reruns
    `e2e:cards` (and `e2e:plugins`) only; editing a Go file of the server reruns every scenario. Seam: two
    real runs, the lines in the PR.
14. `cards.mjs` keeps only browser checks; each moved check has a unit test seen red then green; the
    whole suite stays green; the before/after duration of `cards` is recorded. Seam: the tests, the runs.

15. Projects: a change inside `plugins/bundled/hq-chess` reruns `hq-chess:test` (and the Go tests, which
    read it) but not `web:test` nor `hq-cards:test`; a change in `hq-cards` reruns the tests of
    `hq-cards`, `hq-card-pouilleux` and `hq-card-lastcard`; a change in `web/src` reruns `web:*` only.
    Seam: fdash unit tests on a temporary workspace; one real run per case, lines in the PR.
16. A plugin test imports nothing outside its plugin and its `dependsOn`. Seam: a unit test over
    `plugins/bundled/*/test/*.ts`.

## Anti-goals (cache)

- A false green: a scenario or gate skipped while something it runs has changed. When in doubt, an input
  is declared wider, never narrower.
