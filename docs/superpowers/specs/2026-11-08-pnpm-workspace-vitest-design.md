# pnpm workspace and Vitest: design

Status: decisions taken by the user on 2026-11-08 (Vitest for all TypeScript tests but fdash's, a pnpm workspace);
the calls marked "controller's call" are proposals the user can correct.

## Why

The next step of the test pyramid moves browser checks down: client and plugin-view logic to component tests
(React Testing Library on jsdom), server rules to the testbed and Go. Node's test runner cannot run `.tsx`, and
each tooling folder borrows TypeScript, oxlint and `@types/node` from `web/node_modules` (so any web dependency
bump reruns their lint). One test runner for the TypeScript, and one install for the repository, fix both.

This change is infrastructure only: every existing test keeps what it checks; moving browser checks down is the
next pull request.

## Decisions

- **pnpm workspace** at the root: `pnpm-workspace.yaml`, one `pnpm-lock.yaml`, a root `package.json` with the
  shared tooling (TypeScript, oxlint and oxlint-tsgolint, Vitest, `@types/node`). Members: `web`, `e2e`, `site`,
  `desktop`, `plugins/sdk`, the bundled plugins and their e2e projects that have tests, `scripts`. The four
  per-package lockfiles go. `pnpm install` at the root installs everything.
- **Vitest for every TypeScript test** (`*.test.ts`, `*.test.tsx`, `*.ispec.ts`): web, plugin unit tests,
  plugin views, the SDK's and plugins' integration tests, `scripts`, `e2e`'s unit tests. One root Vitest config
  declares one Vitest project per fdash project; each fdash task runs its own (`vitest run --project <name>`).
  Web and plugin views run on jsdom, the rest on Node. React Testing Library and user-event are dev
  dependencies of the packages that test components.
- **fdash keeps `node --test`**: it is the runner that starts everything, installation included, and stays a
  tool without dependencies (decision 0035).
- **Browser scenarios unchanged**: `e2e/run.ts` and `e2e/plugin-run.ts` are our runners, not test files.
- **Cache keys**: tasks read the root lockfile instead of a package's (controller's call: one global input, simple
  and safe; splitting it per package is an optimisation for later if the cost shows).
- **Tools through the workspace**: commands use `pnpm exec tsc`, `pnpm exec vitest`, never a path into another
  package's `node_modules`.
- **Docker image**: installs only what the client build needs (`pnpm install --filter web...` with the root
  lockfile); its size must not grow.

## Acceptance criteria

1. A fresh clone needs one `pnpm install` at the root; no `pnpm install` in a sub-folder anywhere (scripts,
   CI, Dockerfile, docs).
2. Every TypeScript test that ran before runs under Vitest, with the same number of tests passing per project
   (counts before and after recorded); fdash's tests still run under `node --test`.
3. A test that is made to fail turns its fdash task red (seen once per tier: unit, component, integration).
4. One React Testing Library test of `Modal` (focus trap, Escape closes) and one jsdom test of a plugin view
   module prove the component tier works; each is seen red when the behaviour is broken.
5. No fdash command or tsconfig reaches into another package's `node_modules`.
6. `node scripts/gauntlet.ts` reaches GATES GREEN; CI's unit, integration and e2e jobs pass; the desktop and
   pages workflows pass; the Docker image builds and is no bigger than before (sizes recorded).
7. A decision record (0038) gives the choice, its install and time cost (test times before and after,
   measured), and what it means for contributors; `AGENTS.md`, `docs/gauntlet.md`, `tools/fdash/README.md`,
   `deploy/README.md` and the status page say how to install and run tests.

## Left to the builder

The exact Vitest config layout, pool and timeouts (integration suites start a server: generous timeouts), how
`tsResolve.ts` and other Node-runner workarounds are retired, and the order of the migration.
