# 0033: Staticcheck for Go, Oxlint for the web client and the plugins

Date: 2026-10-26. Status: accepted.

## Context

The gates checked Go with `gofmt` and `go vet`, and TypeScript with `tsc` (`strict`) plus three regular expressions in `scripts/lint-web.mjs`. The plugin type check listed its folders by hand in `scripts/gauntlet.sh` and in CI, and one of them (`ui-demo/public/views`) was in neither list. Promise mistakes (a dropped promise, an async function where a callback's result is ignored) and hook dependencies were left to review, although they are the class of the chat crash ([gauntlet](../gauntlet.md)).

The client is on TypeScript 7.0.2. typescript-eslint 8.72.0 (2026-10-25) declares `typescript >=4.8.4 <6.1.0`: TypeScript 7 has no compiler API for it yet, so its type-aware rules would need a second compiler, TypeScript 6, installed only for the linter.

## Decision

- **Go: staticcheck**, pinned as a tool in `server/go.mod` (`go tool staticcheck ./...`; v0.8.2) and run with the same version on `bench/mediagen` (CI reads it from `server/go.mod`). Its defaults, no configuration file; a deliberate exception is a `//lint:ignore` with its reason.
- **Web and plugins: Oxlint with type-aware rules** (`oxlint` 1.89.0, `oxlint-tsgolint` 7.0.2005, which builds the program with TypeScript 7's Go compiler). One `.oxlintrc.json` at the root covers `web/src`, `web/test`, `plugins/` and `e2e/fixtures/plugins/`; each file is typed by its nearest `tsconfig.json`. `scripts/oxlint.mjs` runs it. On top of the `correctness` category: promise rules (`no-floating-promises`, `no-misused-promises` without JSX attributes, `await-thenable`), `switch-exhaustiveness-check` (a `default` counts, so a new protocol message is handled or sent to the default on purpose), `rules-of-hooks`, `exhaustive-deps`, and a few type-aware ones (`no-for-in-array`, `require-array-sort-compare`, `no-base-to-string`, `only-throw-error`, `no-implied-eval`). The rules turned off say why in the file.
- **tsc**: `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch` in the client; the plugin configs get them and `noUnusedLocals`/`noUnusedParameters`. Plugin configs stay self-contained (no `extends`): authors copy the sample's.
- **Plugin type check by discovery**: `scripts/check-plugin-types.mjs` type-checks every `tsconfig.json` under `plugins/` and `e2e/fixtures/plugins/` that git tracks or would add (git-ignored folders such as `plugins/installed/` are skipped).
- `scripts/lint-web.mjs` stays for the project's own rules (effects' return values, inline UI text).

## Alternatives

- **ESLint 10 with typescript-eslint:** the reference rule set, but on TypeScript 7 it needs TypeScript 6 beside it (the `@typescript/typescript6` alias) until typescript-eslint supports TypeScript 7's API, and two compilers may disagree on a type.
- **Biome 2.6:** linter and formatter in one, with its own type inference; `noFloatingPromises` and `noMisusedPromises` are still in its nursery group.
- **golangci-lint:** many linters behind one configuration, at the cost of a large tool dependency and a configuration to curate; staticcheck alone first.

## Impact

- **Performance:** none at run time (dev tools only). Measured on 2026-10-26, Windows 11, AMD Ryzen 5 9600X: Oxlint with type-aware rules on the four trees takes about 0.7 s, and staticcheck on the server about 0.8 s once its cache is warm.
- **Maintenance:** two web dev dependencies with native binaries, one Go tool line. Oxlint's custom JavaScript rules (which could replace `lint-web.mjs`) are alpha and outside semver, so they are not used yet.
- **Install:** nothing changes in the image or the binary (the tools are not linked in); its build stage downloads a few more modules (`go mod download` fetches the Go tool's) and dev packages. Contributors run `pnpm install` in `web/` as before.
