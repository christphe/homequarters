# 0035: fdash, a task runner with a cache, under the gauntlet

Date: 2026-11-07. Status: accepted.

## Context

`scripts/gauntlet.sh` ran every gate, one after the other, every time: about 1 min 45 s of static gates and
about 12 minutes of browser suite in two shards on a 12-thread Windows machine, whatever changed. It needed
bash. Every unit test of the client and of the plugins was one `node --test` call, and the browser suite was
one call too, so a change to a card game reran the 28 scenarios.

Tools that skip work whose inputs already passed were considered (design note
`docs/superpowers/specs/2026-11-07-fdash-design.md`): Turborepo and Nx build their graph from `package.json`
workspaces, which link nothing here (the browser suite runs the Go binary and serves `web/dist`; plugins
reach `plugins/sdk` through a tsconfig); moon has the right model but is a structuring dependency kept by a
small team, with a breaking major version in 2026; Task and mise skip unchanged tasks locally only; Bazel was
tried before and left as too heavy.

## Decision

**fdash** (`tools/fdash/`, its README) is a small task runner in TypeScript, run by Node 24 as is, with no
dependency. It lives in this repository until it is proven, then may move to its own; it imports nothing
from the repository and names none of its paths (a test checks it).

- `fdash-workspace.json` lists the projects; each project's `fdash.json` declares its tasks (commands or
  groups), what other projects see of it (`files`) and the projects it depends on (`dependsOn`), like the
  workspaces of Rush. No reading of `package.json`, `go.mod` or `Cargo.toml` yet.
- A group runs its members `jobs` at once (the global `--jobs`/`FDASH_JOBS` by default): the static gates
  run in parallel, the browser suite alone after them.
- A command whose inputs (its project's files, its dependencies' files, its own patterns, the Go packages
  `go list -deps` reaches) already passed with the same definition, arguments, environment keys, tool
  versions, OS and Node is reported `CACHED` and not run. Only passes are recorded, in `.fdash/cache/`.
- A command can have items, cached one by one: the browser suite's scenarios, each with its own file and the
  plugins it turns on. `e2e/run.mjs` writes each scenario's result to `FDASH_REPORT`.

The gauntlet keeps the process: `scripts/gauntlet.ts` (and `gauntlet.sh`, now one line calling it) runs the
workspace's `default` task through fdash's API and writes `.gauntlet/last-gates.log` for the critics as
before, `CACHED` lines included. The plugins' unit tests moved from `web/test` into each plugin's `test/`
folder, so a plugin's change reruns its tests and those of the plugins that depend on it, not the client's.

## Consequences

- **Performance (measured, this machine):** static gates 1 min 46 s serial, 1 min 26 s in parallel (the Go
  race tests take most of it); a run with nothing changed takes seconds; a change in one plugin reruns its
  own tests, the Go tests, the linters and the site, not the client's tests nor the other plugins'.
- **What the cache cannot skip yet:** every scenario depends on the whole server binary, so a server change
  reruns the 28; the Go tests of the plugins live in `server/internal/plugin` and read `plugins/bundled`, so a
  plugin change reruns all Go tests (`-count=1`). A plugin test bed and plugin-owned Go tests are the next
  steps.
- **Risk:** a missing input is a check skipped while what it tests changed. Inputs are declared wider when in
  doubt, tests check the declarations the repository can verify (every scenario has its file, a scenario
  naming a plugin follows its folder, a plugin's tests import nothing outside its `dependsOn`), and `--force`
  (`FDASH_FORCE=1` for the gauntlet) runs everything.
- **Assumptions the cache makes:** the scenarios of the browser suite share one server and one database in a
  run, and each is cached on its own; a scenario that leaves state behind and breaks a later one is caught
  only when both run. No scenario may import another (a test checks it). A pass is recorded only if the
  inputs give the same key after the run as before it, and never after Ctrl+C. The local Chrome's version
  is not in the key (CI sets `CHROME_VERSION`); after a Chrome update, run the gauntlet with `FDASH_FORCE=1`.
  A file a test reads at run time outside its project must be declared; a test checks the reads it can
  find (Go tests' `filepath.Join("..", ...)`, tests' `new URL(...)`, imports of another project's
  `node_modules`).
- **CI:** the records come only from runs of a push to `main`, which publish them as an artifact of their
  own run (only the records that run used or made); every job, a pull request's too, downloads the artifact
  of `main`'s latest finished run (`scripts/ci-fdash-records.mjs`), a run kept only if its commit is on
  `main` (a pushed tag named `main` also reports `main` as its run's branch). A pull request's run publishes nothing,
  so nothing it runs can mark one of its checks as passed; reading records from elsewhere would need a change
  to the workflow in its final diff. `actions/cache` was tried first and dropped: it searches a pull
  request's own scope first, where an earlier commit of the pull request could have saved forged records.
  The Go build cache and the pnpm store that `setup-go` and `setup-node` restore still come through
  `actions/cache`, as before this change; this decision does not change that. The jobs are now `static` and
  `e2e (shard i/4)`: the branch protection of `main`, which required `server` and `web`, must name them.
- **Maintenance:** about 700 lines of TypeScript with their own tests; a new gate is a few lines of JSON.
- **Install:** nothing; Node 24 and git, which the repository already needs.
