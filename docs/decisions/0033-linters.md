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
- **The project's own rules** are an Oxlint JS plugin, `scripts/oxlint-hq.mjs`, tested with Oxlint's `RuleTester` (`scripts/oxlint-hq.test.mjs`); they replace `scripts/lint-web.mjs`, whose regular expressions saw `aria-label="..."` but not text between JSX tags. `hq/effect-cleanup`: an effect returns a cleanup or nothing (the chat crash). `hq/ui-text`: words in JSX (text, a string child, either side of a ternary, `||` or `+`) or in `aria-label`, `title`, `placeholder`, `alt` come from `t()`; it found the people panel's untranslated " · admin". Strings in `.ts` files (the old expressions read those too) and ones passed to `toast()` or as props are left to review. `hq/dialog-through-modal`: `role="dialog"` and `<dialog>` only in `Modal.tsx`.
- **No `fetch` in `web/src/ui`** (`no-restricted-globals`, and `no-restricted-properties` for `window.`, `globalThis.` and `self.fetch`): requests go through `request()` in `web/src/net/http.ts`, which never throws (a network failure is status 0), so a handler cannot leave an unhandled rejection. The promise rules found handlers that showed nothing when the network failed (Settings, Administration, the map editor, app tokens, "Not me"); the `offline` browser scenario covers eight of them through the real controls. `pixi.js` (and its subpaths) is not imported in `web/src/ui` either (`no-restricted-imports`).
- **`scripts/check-protocol-docs.mjs`** compares `docs/protocol.md` with the messages the server dispatches (`ws.go`) and the ones the client types (`protocol.ts`), with tests on fixtures; a message the server sends without a type in `protocol.ts` is not seen.
- **Left to the critics**, because a rule would be wrong or noisy: `requestAnimationFrame` in the UI (the noise dialog's level meter uses it on a DOM node, outside React's state, which the invariant allows); an `AudioContext` made after an `await` (the media dialog's meter does, and works with the page's earlier user activation); jsx-a11y (27 findings on the tree, mostly role and tag preferences that the `a11y` axe scenario does not report); secrets in Go logs (it would need a `go vet` analyzer of our own).

## Alternatives

- **ESLint 10 with typescript-eslint:** the reference rule set, but on TypeScript 7 it needs TypeScript 6 beside it (the `@typescript/typescript6` alias) until typescript-eslint supports TypeScript 7's API, and two compilers may disagree on a type.
- **Biome 2.6:** linter and formatter in one, with its own type inference; `noFloatingPromises` and `noMisusedPromises` are still in its nursery group.
- **golangci-lint:** many linters behind one configuration, at the cost of a large tool dependency and a configuration to curate; staticcheck alone first.

## Impact

- **Performance:** none at run time (dev tools only). Measured on 2026-10-26, Windows 11, AMD Ryzen 5 9600X: Oxlint with type-aware rules on the four trees takes about 0.7 s, and staticcheck on the server about 0.8 s once its cache is warm.
- **Maintenance:** two web dev dependencies with native binaries, one Go tool line. Oxlint's JS plugins are alpha and outside semver: `oxlint` is pinned to an exact version, and an upgrade runs the rules' tests first.
- **Install:** nothing changes in the image or the binary (the tools are not linked in); its build stage downloads a few more modules (`go mod download` fetches the Go tool's) and dev packages. Contributors run `pnpm install` in `web/` as before.
