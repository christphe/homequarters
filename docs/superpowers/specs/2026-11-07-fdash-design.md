# fdash, and the gauntlet on top of it (step A of 3)

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

- **Step A (this document)**: fdash runs tasks, the gates move into `fdash.json`, the gauntlet calls fdash.
  Same gates and same report as `gauntlet.sh` today; new: static gates in parallel, any OS, no bash.
- Step B (later): fdash's cache. Each task declares inputs: paths, or providers that ask the toolchain
  (`go list -deps` for a Go package, the modules of a Vite build, later `cargo metadata`). A pass is
  recorded under the hash of the inputs and the declared environment; a task whose key already passed is
  skipped. The cache folder can be shared with CI through `actions/cache`.
- Step C (later): scenario by scenario, starting with `cards`, move rules to unit tests and give each
  scenario its own inputs.

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
      "gofmt": { "cwd": "server", "run": [["gofmt", "-l", "."]], "failOnOutput": true },
      "site-build": { "cwd": "site", "run": [["node", "build.mjs"], ["node", "check.mjs"]] },
      "e2e": { "cwd": "e2e", "run": [["node", "run.mjs"]], "env": { "E2E_VIEWPORT": "small" }, "exclusive": true, "args": true }
    }
  }
  ```

  Tasks run in the order of the file. `run` is a list of steps, each an argv (no shell parsing); the first
  failing step fails the task. `failOnOutput`: anything on stdout fails it. `env` is added to the inherited
  environment. `exclusive`: runs alone, after the others. `args`: extra arguments given to fdash are
  appended to its last step. Unknown keys and bad types are refused with a message naming the task.
- **Running**: non-exclusive tasks run in parallel, `--jobs N` or `FDASH_JOBS` at once (default half the
  logical CPUs, at least 1; `1` is serial); exclusive tasks then run one at a time. Each task's stdout and
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
  web-unit (plus fdash's and the gauntlet's own tests), site-build, e2e.
- `scripts/gauntlet.ts` keeps what belongs to the process: the scenario arguments (passed to e2e),
  `GAUNTLET_SKIP_E2E=1` (skips e2e, prints `SKIPPED e2e`), the tree fingerprint (same rules as today:
  index, diff against HEAD, untracked non-ignored files, leaving out `server/CHANGELOG.md`,
  `desktop/CHANGELOG.md` and `docs/superpowers`; the hex value may differ from bash's), the record
  `.gauntlet/last-gates.log` (same header, `PASS`/`FAIL` lines in gate order, `GATES GREEN` /
  `GATES RED: N failed` / `STATIC GATES GREEN; browser verification SKIPPED`, `finished <time>`), and
  `FAIL working tree changed during gates; rerun on the final tree`. Exit code = number of failures.
- `scripts/gauntlet.sh` stays as one line, `exec node "$(dirname "$0")/gauntlet.ts" "$@"`, so docs, skills
  and the PR template keep working. `E2E_PARALLELISM` still reaches e2e through the environment.

## Non-goals (step A)

No cache, no inputs, no skipping. No change to CI's jobs beyond running the new unit tests. No change to
e2e, its slots or its shards. No gate added or removed (Rust's `cargo` checks are a later gate).

## Anti-goals

- A task reported PASS when its command failed, or a stale record that looks current.
- A run that leaves processes behind on Ctrl+C.
- fdash growing project knowledge (a Home Quarters path or name inside `tools/fdash/`).

## Acceptance criteria and seams

1. `fdash.json` lists the gates of `gauntlet.sh` with the same names, order and commands. Seam: a unit test
   reading `fdash.json` against the expected table.
2. fdash: a failing step, a missing command and output under `failOnOutput` each fail their task; a pass
   passes; `--jobs 1` runs one at a time and the default runs several; exclusive tasks run alone after the
   others; results come back in config order; a bad config is refused naming the task. Seam: fdash unit
   tests with `node -e` tasks.
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
