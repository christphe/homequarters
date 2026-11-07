# gauntlet.ts: the gauntlet's gates in TypeScript (step 1 of 3)

## Intent

The browser suite takes about 20 minutes serial, and every change reruns everything. The goal over three
steps is to stop rerunning what has not changed and to move every check that needs no browser into unit
tests. This document covers step 1 only: rewrite `scripts/gauntlet.sh` in TypeScript run by Node 24
(types stripped natively, as `node --test 'web/test/*.test.ts'` already does), **with the same behaviour**,
so that steps 2 and 3 build on code that is tested and runs natively on Windows.

- Step 2 (later): a cache per gate. Each gate declares its inputs; a pass is recorded under a key made of
  the inputs' hash and the environment, and a gate whose key already passed is skipped. `actions/cache`
  shares the records with CI.
- Step 3 (later): scenario by scenario, starting with `cards`, move rules to unit tests and give each
  scenario its own inputs.

## Approaches considered

- **moon** (moonrepo): project graph, inputs per task, a remote cache over the Bazel protocol. Rejected for
  now: a structuring dependency maintained by a small team, a breaking v1 to v2 migration, Go and Rust
  through WASM plugins less mature than JS; and for the costly part (browser scenarios) it would only run
  shell commands with inputs we declare anyway. Remains the next step if a shared remote cache is needed;
  the input declarations would carry over.
- **Turborepo, Nx**: JS-first (a `package.json` beside the Go module, or experimental `go.work` support),
  a root pnpm workspace and three lockfiles to merge. Rejected.
- **Task (go-task), mise**: skip-if-unchanged per task, but local only (mise's cache for tasks without
  outputs is experimental). No gain over our own code for one more dependency.
- **Bash, extended** (keep `gauntlet.sh`): no tests, needs Git Bash on Windows, no parallel gates.
- **Our own code in TypeScript**: chosen (by the user). Zero dependency, tested like the rest of the repo.

Not done: restructuring the repository into workspace packages. The cache keys on paths; the layout is
already split by area, and the costly scenarios depend on the whole server and client anyway.

## Goals

1. `node scripts/gauntlet.ts [scenario ...]` runs the same gates, with the same commands, as
   `gauntlet.sh` today: gofmt, go-vet, staticcheck, go-test-race, tsc, tsc-tests, vite-build,
   protocol-docs, oxlint, plugin-types, web-unit, site-build, then e2e (`E2E_VIEWPORT=small node run.mjs
   <scenarios>`).
2. Same interface: scenario arguments, `GAUNTLET_SKIP_E2E=1`, `E2E_PARALLELISM` passed through to e2e;
   exit code = number of failed gates.
3. Same report: one `PASS <gate>` / `FAIL <gate> (log: <path>)` line per gate on stdout (with the last 15
   lines of a failed gate's log, indented), each gate's full output in a temp folder, and
   `.gauntlet/last-gates.log` with the header (commit, tree fingerprint, start time, scenarios), the gate
   lines, `GATES GREEN` / `GATES RED: N failed` / `STATIC GATES GREEN; browser verification SKIPPED`, and
   `finished <time>`.
4. Same fingerprint rules: the content of the files the gates read (tracked index, diff against HEAD,
   untracked non-ignored files), leaving out `server/CHANGELOG.md`, `desktop/CHANGELOG.md` and
   `docs/superpowers`; computed before and after the gates, and a change during the run is a failure
   (`FAIL working tree changed during gates; rerun on the final tree`). The hex value may differ from the
   bash one; the rules may not.
5. `scripts/gauntlet.sh` stays, as one line: `exec node scripts/gauntlet.ts "$@"`, so docs, skills, the PR
   template and habits keep working.

## New behaviour (the only ones)

- **Static gates run in parallel**, `GAUNTLET_JOBS` at once (default: half the logical CPUs, at least 1;
  `GAUNTLET_JOBS=1` is the old serial run). Lines print as gates finish; the record lists them in the
  fixed gate order. e2e always runs alone, after the static gates, as today.
- **No bash needed** to run it, on any OS (Linux, macOS, Windows without Git Bash): gates are spawned as processes; the few that
  are shell pipelines today (gofmt's `test -z`) become code.

## Non-goals

- No cache, no skipping (step 2). No change to CI (`ci.yml` keeps its own steps). No change to e2e, its
  slots or its shards. No new gate, no gate removed.

## Anti-goals

- A gate that reports PASS when its command failed, or a stale record that looks current.
- A run that leaves processes behind on Ctrl+C (children are killed with the run).

## Structure (builder's call where not stated)

- `scripts/gauntlet.ts`: the CLI (spawning, logs, printing).
- A pure module (name left to the builder) with the gate list, the env/argument parsing, the record and
  summary lines, and the fingerprint computed from given inputs; unit-tested in `scripts/gauntlet.test.ts`,
  added to the `web-unit` gate and to CI's unit-test step.
- Type-checked by an existing gate (for example included in `web/tsconfig.test.json`); builder's call.

## Acceptance criteria and seams

1. Same gates and commands as `gauntlet.sh` at the baseline. Seam: unit test on the gate list; a full run.
2. A failing gate prints `FAIL`, its log tail, and the run ends `GATES RED: 1 failed` with exit code 1.
   Seam: unit test on the summary; one run with a deliberately broken gate (e.g. a gofmt-unformatted file
   in a scratch copy, or an env hook the builder adds for tests).
3. `GAUNTLET_SKIP_E2E=1` ends `STATIC GATES GREEN; browser verification SKIPPED`. Seam: unit test and a run.
4. The fingerprint ignores the two changelogs and `docs/superpowers`, and changes when any other tracked,
   modified or untracked file changes. Seam: unit tests on a temporary git repository.
5. Editing a file during the run fails the run with the "working tree changed" line. Seam: unit test.
6. `GAUNTLET_JOBS=1` and the default both reach `GATES GREEN` on the whole suite; record the wall time of
   the static gates for both. Seam: two runs, times in the PR.
7. Runs on Linux, macOS and Windows from any shell (bash, zsh, PowerShell, cmd), with no shell needed by
   the gates themselves; on Windows `pnpm` is a `.cmd` and must be spawned as `e2e/run.mjs` does. Seam: a
   run from PowerShell without Git Bash on PATH, and one on Linux; macOS is reported as not verified unless
   someone runs it.
8. `scripts/gauntlet.sh` still works (Git Bash, and Linux in a CI-like shell if available). Seam: a run.
