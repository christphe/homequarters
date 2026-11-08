# 0038: one pnpm workspace, and Vitest for the TypeScript tests

Date: 2026-11-08. Status: accepted.

## Context

The next step of the test pyramid ([decision 0037](0037-test-pyramid.md)) moves browser checks down: the
client's and the plugin views' logic to component tests (React Testing Library on jsdom), the server's rules to
the testbed and Go. Two things stood in the way:

- **Node's test runner cannot run `.tsx`.** Node 24 strips types but does not transform JSX, has no DOM
  environment, and does not resolve `web/src`'s extensionless imports: the client's tests needed a resolve hook
  (`web/test/tsResolve.ts`) imported before the module under test, and a React component could not be tested at
  all.
- **Four installs, borrowed tools.** `web/`, `e2e/`, `site/` and `desktop/` each had a lockfile and their own
  `pnpm install`; `scripts/`, `tools/fdash/`, `plugins/sdk/` and the plugins had none and borrowed TypeScript,
  Oxlint and `@types/node` from `web/node_modules` or `e2e/node_modules` (relative paths in fdash commands,
  `typeRoots` in their tsconfigs). Any bump of the client's dependencies changed their lint's inputs, and a fresh
  clone needed several installs in the right order before the static gates could run.

The design note is `docs/superpowers/specs/2026-11-08-pnpm-workspace-vitest-design.md`.

## Decision

**One pnpm workspace.** `pnpm-workspace.yaml` at the root lists every TypeScript project (`web`, `e2e`, `site`,
`desktop`, `scripts`, `tools/fdash`, `plugins/sdk`, `plugins/bundled/*`, `plugins/e2e/*`); one `pnpm-lock.yaml`
replaces the four. The root `package.json` is private, pins pnpm (`packageManager`) and declares **no
dependency**. `pnpm install` at the root, once, installs everything; nothing runs `pnpm install` in a sub-folder
(scripts, CI, Dockerfile, docs).

**Each project declares its own tools.** A project that runs `tsc` declares TypeScript, one that runs Vitest
declares Vitest (and jsdom, Testing Library where it tests components or views), `@types/node` where its
tsconfig uses it, Oxlint where its lint runs it. fdash commands call them through the workspace (`pnpm exec tsc`,
`pnpm exec vitest`), never through a path into another project's `node_modules`; `scripts/oxlint.ts` runs the
calling project's Oxlint.

**Versions through pnpm's catalog.** A version that more than one project uses is written once, in the `catalog`
of `pnpm-workspace.yaml`, and referenced as `"catalog:"`. A guard in `scripts/gauntlet.test.ts` fails when a
shared dependency is written with a literal version, when a command runs a tool its project does not declare,
when a file reaches into a `node_modules` by a relative path, or when the root declares a dependency.

**Vitest for every TypeScript test but fdash's.** `*.test.ts`, `*.test.tsx` and `*.ispec.ts` of the client, the
plugins, the SDK, `scripts/` and `e2e/`'s own unit tests run under Vitest. Each fdash project has its own
`vitest.config.ts`, whose Vitest project is named after the fdash project (`web`, `hq-chess`,
`hq-chess:integration`, ...); each fdash task runs its own (`pnpm exec vitest run`, or `--project <name>` where a
config holds a unit and an integration project). There is no root Vitest config: with no dependency at the root,
nothing there could import `vitest/config` (the design note proposed one; the builder chose per-project configs).
Tests run on Node; a component or view test asks for jsdom with its first line (`// @vitest-environment jsdom`). Integration projects get generous
timeouts, since each file starts a server.

**fdash keeps `node --test`.** It is the runner that starts everything else, installs included, and stays a tool
without dependency ([decision 0035](0035-fdash.md)). The browser suites are unchanged: `e2e/run.ts` and
`e2e/plugin-run.ts` are runners, not test files.

**Cache keys.** Every fdash command of a project with a `package.json` reads the root `package.json`,
`pnpm-workspace.yaml` and `pnpm-lock.yaml`: one global input, simple and safe. (Since [decision
0039](0039-fdash-pnpm-input.md), only the part of `pnpm-lock.yaml` its member installs.)

**The Docker image** installs only what the client's build needs: `pnpm install --frozen-lockfile --filter
homequarters-web` from the root lockfile, in the build stage.

## Alternatives

- **Keep Node's runner and add a loader** (`tsx`, an esbuild register hook): it would run `.tsx`, but jsdom,
  module mocking and the extensionless resolution would each be one more hook of ours, like `tsResolve.ts`.
  Vitest reuses Vite, which already builds the client, so a test resolves and transforms `web/src` exactly as the
  build does. Its cost is the time measured below.
- **One set of shared dependencies at the root** (TypeScript, Vitest, Oxlint declared once, every project
  using them): fewer lines, but a project's `package.json` would no longer say what its tasks run, and a project
  moved out of the repository (fdash, a plugin) would find nothing. Rejected by the maintainer: each project
  declares its own.
- **syncpack or manypkg** to keep repeated versions aligned: one more tool and one more gate that report drift
  after it happened. pnpm's catalog makes the drift impossible to write (one version, referenced by name), and
  the guard above checks that shared dependencies use it.

## Measurements

The client's tests, 209 tests in 32 files, the same count in every file before and after (counted per file by
the foundation of this change). Measured on the Windows 11 desktop (12 logical CPUs, Node 24.14.1) on
2026-11-08, three runs each after one warm-up run, wall time of the whole command:

| Runner | Command | Runs |
| --- | --- | --- |
| `node --test`, at `c085b86` (the commit before the switch) | `node --test 'web/test/*.test.ts'` | 1.25 s, 1.18 s, 1.27 s |
| Vitest, every file on jsdom | `cd web && pnpm exec vitest run` | 5.65 s, 5.91 s, 5.91 s (Vitest's own duration 4.67 s, 4.91 s, 4.79 s) |
| Vitest on Node, jsdom only for component tests (as shipped) | `cd web && pnpm exec vitest run` | 2.82 s, 2.82 s (a first, cold run 5.8 s; Vitest's own duration 1.94 s, 1.96 s; 216 tests, the 7 of `Modal` included) |

With every file on jsdom, Vitest reported 92 % of its duration as environment setup: jsdom is created once per
test file. The unit tests never needed a DOM (they ran under `node --test`), so the client's project runs on Node
and a component test asks for jsdom with its first line, `// @vitest-environment jsdom`.

Docker image (`docker image inspect`, Docker Desktop 4.84.0, built locally by the foundation): 27,590,278 bytes
before, 27,589,909 bytes after (the test tools stay in the build stage).

Not measured: the other projects' test times before and after, a cold `pnpm install` from an empty store, CI's
times with the new installs, and any of it on Linux or macOS.

## Consequences

- **Performance:** the client's tests take about 1.6 s more per run than under `node --test` (above), in a static
  stage that runs its tasks at once and caches them; jsdom is paid only by the files that ask for it. Component tests are possible now; each moves
  a check out of a browser scenario that costs seconds in every run. The root lockfile is an input of every
  TypeScript task, so any dependency change reruns them all (splitting it per project is left for when the cost
  shows).
- **Maintenance:** one lockfile and one install to keep; a version shared by two projects changes in one place;
  `web/test/tsResolve.ts` is gone. A new project with tests adds itself to the workspace, declares its tools
  (`"catalog:"` for the shared ones) and writes a `vitest.config.ts` named after its fdash project. A test that
  reads a file outside its folder builds the path from `import.meta.dirname`: Vite rewrites
  `new URL("…", import.meta.url)` into an http address under Vitest. On jsdom, code that touches a canvas at load
  prints `Not implemented: HTMLCanvasElement's getContext()` without failing.
- **Install:** for contributors, `pnpm install` once at the root replaces the per-folder installs; pnpm 10 or
  newer switches by itself to the pinned version. CI, the desktop and Pages workflows install at the root (the
  latter two with `--filter`). Operators see no change: the image is built the same way from the same Dockerfile,
  needs only Docker, and is no bigger.
