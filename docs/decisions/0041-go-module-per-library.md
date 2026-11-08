# 0041: one Go module per library of the server

Date: 2026-11-08. Status: accepted. Amends [decision 0040](0040-strict-linters.md) (depguard) and
[decision 0035](0035-fdash.md) (fdash's projects).

## Context

The server was one Go module (`server/go.mod`) and one fdash project: any change to any package reran the
whole server's lint and tests, and the package graph was a rule in `.golangci.yml` (depguard), written by hand
beside the code it described. The maintainer asked for one Go module per library, so that each library declares
its dependencies once, Go itself enforces them, and fdash builds, lints and tests each library on its own and
caches it.

## Decision

- **Layout: the folders and import paths stay.** Each of `server/internal/<lib>` (auth, config, gamemap,
  httpapi, media, plugin, store, testbed, world) and `server/cmd/<command>` (homequarters, loadgen) holds a
  `go.mod`; the module path is the import path the packages already had (`homequarters/internal/world`,
  `homequarters/cmd/homequarters`), so no Go file changed. `server/go.mod` is gone: `server/` is a folder of
  modules. A module requires each local library it uses at `v0.0.0` and replaces it with its folder
  (`replace homequarters/internal/gamemap => ../../internal/gamemap`), the equivalent of pnpm's
  `workspace:*`. Go reads only the main module's `replace` directives, so a module also replaces the libraries
  it reaches through another (the command's go.mod replaces all nine); `go mod tidy` marks those `// indirect`.
  Module paths without a dot cannot be fetched from a proxy, so `go mod tidy` never resolves a local import by
  downloading something.
- **No committed go.work.** With a go.work, Go accepts an import of a workspace module that the importer's
  go.mod does not require, which would hide undeclared dependencies. Without it, such an import fails the
  library's own build, lint and tests: `package homequarters/internal/store is not in std` (seen, a planted
  import in world). A command that already replaces that library still builds; and Go's messages do not say
  what to do (`go mod tidy` ignores the import, `go get` refuses a path without a dot). So `lint:go-modules`
  (below) also checks each module's imports, tests included, against its go.mod, and prints the command to run.
- **Internals.** A library hides what others must not use in its own `internal/`
  (`homequarters/internal/world/internal/x`): another module importing it fails with `use of internal package
  … not allowed` (seen), the library itself may. No library has such a folder today; the mechanism is there
  when one needs it.
- **`lint:go-modules`**, a workspace task in `lint:repo` (so in `static`, cached on `server/**` but the
  changelog), runs `node scripts/lint-repo.ts go-modules`. (1) Each module requires and replaces, at `v0.0.0`,
  every library its packages and tests import, and replaces every library it reaches through those (Go reads
  only the main module's replaces); a miss prints `(cd <module> && go mod edit -require=… -replace=… && go mod
  tidy)` (seen: a planted import of store in world; config imported by media and not replaced in world).
  (2) One version per third-party module: a copy of `server/` in a temporary folder, a go.work there that uses
  every module (passed by `GOWORK`), then `go work sync`, which raises each module's requirements to what the
  modules select together. A go.mod it changed held another version than its neighbours: the check prints the
  line and fails (`--fix` writes the raised files into the tree). The tree is never written otherwise, so a run
  beside the other static tasks, or one stopped halfway, leaves it as it was. Seen red: store's `modernc.org/sqlite` lowered to v1.60.0
  while httpapi and the command select v1.60.1. The bench and tool modules (`bench/*`, `tools/go/*`) are left
  out: separate programs, with graphs of their own on purpose (decision 0040).
- **depguard:** its package-graph rules are gone, Go enforces them. The rule that only `internal/media` may
  import a LiveKit module stays: a go.mod accepts whatever `go get` adds (seen: a LiveKit import planted in world
  builds once `go get` added the module, and depguard fails it).
- **fdash: one project per module**, named after its folder (the command's is named `server`, so the plugins'
  `dependsOn: ["server"]` and `--pkg server` keep their meaning), each with `lint` (golangci-lint on the
  module), `lint:vuln` (govulncheck), `test:unit` (`go test -race -count=1 ./...`) and, for the two commands,
  `build` (`bin/homequarters*` and `bin/loadgen*`, outputs cached). Its `dependsOn` is
  `[{ "goMod": "go.mod" }]`: fdash reads the go.mod's local requires (the `replace`d folders) and makes them the
  project's dependencies, so they are written once, in the go.mod. A module's `files` (what its dependents
  read of it) leave its `*_test.go` out: editing a library's tests reruns only that library's tasks. Its
  `lint`, `lint:vuln` and `test:unit` have `"afterDependsOn": false` (new in fdash): a Go command compiles the
  libraries it needs itself, so waiting for their checks would only chain the modules one after the other
  (with the chain, the forced run below took 101 s instead of 52 s). Every Go task runs with `GOWORK=off`.
  fdash's Go input provider follows the
  modules a module replaces with a folder (e2e's key on the server's sources). A test keeps the Dockerfile's list
  of go.mod files in step with the command's go.mod; the guard of `scripts/gauntlet.test.ts` on files a test
  reads outside its project now walks every module.
- **Editors:** gopls (v0.15 and later) opens a view per go.mod it finds above an opened file, so the modules
  work without a go.work. `go.work` is git-ignored; a contributor who wants one for their editor may keep one,
  and fdash's Go tasks run with `GOWORK=off`, so the gates still refuse an undeclared import on that machine (a
  bare `go test` there does not). Not tried in an editor here (no gopls on the machine that wrote this).

## Alternatives

- **`server/<lib>/` with module paths `homequarters/<lib>`:** shorter paths, but every import and every path in
  the docs, fdash files, Dockerfile, CI, linter exclusions and tests changes, for no difference in what Go
  enforces. Kept the folders.
- **A committed go.work:** one `go test ./...` across modules and no `replace` lines, but undeclared imports
  build (seen), which defeats the purpose.
- **depguard as before, one module:** the graph stays a hand-written list, and fdash cannot cache one library
  without the others.
- **Writing `dependsOn` by hand and a test comparing it with the go.mod files:** duplicated; fdash reading the
  go.mod is a few lines and generic (any Go repository with local replaces).
- **The version check as a comparison of the go.mod files' versions:** no Go needed, but it is an approximation
  of what MVS selects; `go work sync` is Go's own answer.

## Impact

- **Performance:** none at run time: the image's files and size are the same (27 623 212 bytes before and
  after, the same file list and sizes). Development, measured on the Windows 11 desktop (12 logical CPUs, Go
  1.27.3, fdash's default of 6 jobs), the server's lint, unit tests and build:

  | Run | One module (before) | One module per library (after) |
  | --- | --- | --- |
  | Cold: empty Go build and golangci-lint caches | 103 s (lint 45.0, build 0.3, tests 57.4) | 255 s |
  | Warm Go caches, every task run (`FDASH_FORCE`) | 38.6 s (lint 2.7, build 0.3, tests 35.6) | 51.9 s |
  | Nothing changed | `CACHED` (not measured) | 0.9 s, 24 tasks `CACHED` |
  | `world/world.go` changed | everything again (estimate: the row above) | 43.7 s: world, httpapi, testbed and the command rerun (9 tasks), 15 `CACHED` |
  | `world/world_test.go` changed | everything again (estimate: the row above) | 10 s: world's lint and tests rerun, the 20 other lint and test tasks `CACHED` (build not run) |

  Each task alone, warm: golangci-lint 1.6-1.9 s per module; tests: plugin 20.5 s, store 12.8, httpapi 29.5,
  the others 3-6 s. What the split saves depends on where a change lands: every library but loadgen sits under
  httpapi, whose tests take 29.5 s, so a change to a library's code still reruns them; a change to tests,
  to the testbed, the commands or loadgen reruns little. The cold run is slower: eleven golangci-lint processes
  start at once on an empty cache, each building the tool and analysing the shared dependencies before the
  others have stored them. CI restores the Go caches (setup-go, keyed on every go.sum), so it rarely starts
  cold. The forced run is slower by the cost of eleven processes and of test binaries linked per module.
- **Maintenance:** eleven go.mod files instead of one; a new import between libraries is a `require` and a
  `replace` in the importer's go.mod and a `replace` in each module above it; Go's own messages do not say so,
  `lint:go-modules` does, with the command to run. A plain `go build` in a command's folder writes the binary
  there (git-ignored); `cd server && go test ./...` no longer works (`server/` is no module). Dependabot updates the eleven folders with one pull request per dependency
  (`group-by: dependency-name`), so a shared module moves everywhere at once.
- **Install:** nothing for operators (same binary, same image). Contributors run Go commands inside a module
  folder (`cd server/internal/world && go test ./...`) or through fdash; `cd server && go test ./...` no longer
  works.
