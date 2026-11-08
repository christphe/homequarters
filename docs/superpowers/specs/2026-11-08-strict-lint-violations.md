# Strict linters: what they find on the tree (2026-11-08)

The tools and their configuration of [decision 0040](../../decisions/0040-strict-linters.md), run on `main` at
`54dc9d5` plus this change, before any fix. Every finding is in
[`2026-11-08-strict-lint-violations.json`](2026-11-08-strict-lint-violations.json) as
`{project, tool, rule, file, line, message}` (1172 entries), so the fixes can be split by fdash project.

How each rule was judged: run on the tree, a sample of its findings read (all of them under about 30, a random
sample of 14 to 45 above), each sorted as **real** (a defect, or code that is clearer and safer written the way
the rule wants) or **false positive** (correct code the rule cannot understand). Mostly real: on, as an error.
A few false positives with one narrow cause: on, with a narrow exclusion that says why in the config. Mostly
false positives or taste: off, listed below. Nothing is a warning.

Measured on the Windows 11 desktop (12 logical CPUs, Go 1.27.0, Node 24.14.1); clippy and rustfmt in a
`rust:1.93-bookworm` container (Docker Desktop), since this machine has no MSVC linker. Counts in "real / false
positive" are of the findings that remain with the configuration as committed; "sample" means the split was
read on a sample and extended to the rule.

## Per project

| fdash project | findings | tools |
| --- | --- | --- |
| server | 286 | golangci-lint 273, govulncheck 13 |
| mediagen (CI step `Lint and build the media benchmark tool`, no fdash project) | 23 | golangci-lint 13, govulncheck 10 |
| hq-cards | 260 | oxlint |
| e2e | 183 | oxlint |
| workspace `lint:actions` | 61 | zizmor 56, actionlint (shellcheck in `run:`) 5 |
| web | 47 | oxlint |
| hq-card-pouilleux | 42 | oxlint |
| hq-card-lastcard | 40 | oxlint |
| hq-pets | 35 | oxlint |
| hq-cards-e2e | 33 | oxlint |
| scripts | 27 | oxlint |
| fdash | 26 | oxlint |
| hq-chess | 23 | oxlint |
| desktop | 20 (+2 expected on macOS) | rustfmt 17, clippy 3 (`unsafe_code` on macOS: not run) |
| workspace `lint:shell` | 20 | shellcheck |
| sdk | 20 | oxlint |
| hq-chess-e2e | 13 | oxlint |
| site | 4 | oxlint |
| hq-card-lastcard-e2e | 4 | oxlint |
| hq-card-pouilleux-e2e | 3 | oxlint |
| workspace `lint:docker` | 2 | hadolint |
| workspace `lint:secrets` | 0 | gitleaks |
| tsc (every project) | 0 | the flags kept add no error |

Ordering note: fdash starts a project's `lint` after the `lint` of the projects it depends on, so while
`server:lint` fails, the plugins' and the plugin e2e projects' lints print `FAIL ... (after server:lint
failed)`; run one alone with `node tools/fdash/cli.ts run lint --pkg <project>`.

## Rules turned on, with what they found

| project | tool / rule | violations | real | false positive | decision |
| --- | --- | --- | --- | --- | --- |
| server | golangci-lint / errcheck | 80 | 80 (prod: dropped `os.WriteFile`, `vm.SetEvalTimeout`, `hs.Shutdown`, `st.Close` of the database...; tests: unchecked `json.Unmarshal`, store setup calls, `os.WriteFile`) | 0 after the exclusions; before them 231, of which the responses written to a gone client, closes of read-only things, test teardown and `<-done` were 151 false positives | on, with `exclude-functions` (response and stream writes, `sql.Rows.Close`, `Tx.Rollback`, WebSocket closes) and two test-only exclusions (teardown, waiting on a stopped process). Prod `Close` of a read file or a VM stays reported: write `_ =` to say it |
| server | golangci-lint / noctx | 52 | 52 (migrations without a context, `http.Get` in tests: `t.Context()` bounds them) | 0 | on |
| server | golangci-lint / intrange | 55 | 55 | 0 | on |
| server | golangci-lint / modernize | 29 | 29 (slices.Contains, maps.Copy, min/max, SplitSeq, WaitGroup.Go...) | 0 after `embedlit` off (7, taste) | on, without `embedlit` |
| server | golangci-lint / errorlint | 21 | 21 (`err != ErrX` in tests, `%v` for errors in the plugin API) | 0 | on |
| server | golangci-lint / musttag | 8 | 8 (structs marshalled with Go field names: the wire format follows a rename silently) | 0 | on |
| server | golangci-lint / bodyclose | 6 | 6 (`http.Get` in tests and `main.go`'s readiness probe without `Body.Close`) | 9 removed (`websocket.Dial`: its documentation says the body needs no close) | on, `websocket.Dial(` excluded by source |
| server | golangci-lint / unparam | 6 | 6 (unused `now` parameters, `except` always nil, an unused result) | 2 removed (test helpers keeping a general parameter) | on, "always receives" excluded in tests |
| server | golangci-lint / gocritic (diagnostic tag + equalFold) | 5 | 5 (2 `os.Exit` after `defer`, 2 `strings.Index` without -1 check in tests, 1 `EqualFold`) | 4 `appendAssign` (buffer reuse on purpose), 1 `deferInLoop` (in the returning branch) | on, `appendAssign`, `ifElseChain`, `sloppyReassign` off; one path exclusion |
| server | golangci-lint / usestdlibvars, canonicalheader, copyloopvar, unconvert, wastedassign, govet unusedwrite, staticcheck QF1002, gosec G122 | 4, 1, 1, 1, 1, 1, 1, 1 | all | gosec: every other rule's findings (G101, G104, G115, G124, G202, G204, G301, G302, G304, G306, G404; 84) were false positives | gosec on with those rules excluded (each says why); G122 (symlink race in `filepath.WalkDir`) kept: its one prod finding is in the plugin compiler; tests excluded |
| server | golangci-lint / depguard | 0 | — | — | on: the package graph of `go list` as allow-lists, LiveKit modules only in `internal/media`; seen red by importing `store` from `world`, `gamemap` from `store`, a LiveKit module from `store` (and allowed in `media`) |
| server | golangci-lint / govet (all analyzers), staticcheck (all checks), ineffassign, unused, misspell, nilerr, nilnesserr, durationcheck, makezero, mirror, reassign, rowserrcheck, sqlclosecheck, fatcontext, asciicheck, bidichk, gocheckcompilerdirectives, nosprintfhostport, usetesting, nolintlint (explanation and linter name required), gofmt, goimports | 0 | — | — | on (govet without `fieldalignment` and `shadow`, staticcheck without QF1001) |
| server | govulncheck | 13 | 13 (the standard library of go1.27.0: net/http, http2, crypto/tls, crypto/x509, html/template, net/textproto; fixed in 1.27.2 and 1.27.3) | 0 | on (`server:lint:vuln`, keyed on the day too); the fix is a newer Go (a `toolchain go1.27.3` line), CI's `1.27` probably has it already (not run) |
| mediagen | golangci-lint | 13 | 13 (5 errcheck incl. unchecked writes of the IVF fixer, 3 noctx, 2 intrange, 2 modernize, 1 musttag) | 2 removed (gosec G703: a command-line tool reading its arguments) | same config, path exclusion |
| mediagen | govulncheck | 10 | 10 (`golang.org/x/net` v0.55.0, fixed in v0.60.0, and the standard library) | 0 | CI step |
| all TS projects | oxlint / typescript/no-unnecessary-type-assertion | 371 (hq-cards 176, e2e 39, hq-card-pouilleux 37, hq-cards-e2e 28, web 27, ...) | 371 (sample of 14 read: `alice!` on values the types already say are defined; `x as T` where x is a T) | 0 in the sample | on |
| all TS projects | oxlint / typescript/no-unsafe-member-access, -assignment, -return, -call, -argument | 208, 85, 32, 14, 17 | all (JSON payloads typed `any` in tests and e2e: `Frame = Record<string, any>`, `res.json()`; `new Map()` inferred `Map<any, any>` in hq-cards; `m.data` of a MessagePort in the plugin host) | 0 after the files without types were excluded (below) | on |
| sdk, hq-cards, hq-chess, hq-pets | oxlint / typescript/no-explicit-any | 9 | 9 (the plugin SDK's `args: any`, `msg: any`, `metadata: any`; test helpers) | 0 | on |
| web, e2e | oxlint / typescript/no-deprecated | 9 | 9 (`React.FormEvent`, puppeteer's `overridePermissions`) | 0 | on |
| web | oxlint / oxc/approx-constant | 6 | 6 (`0.70710678` for `Math.SQRT1_2`) | 0 | on (suspicious category) |
| fdash | oxlint / eslint/preserve-caught-error | 3 | 3 (rethrown errors without `cause`) | 0 | on (suspicious category) |
| web, hq-pets | oxlint / typescript/prefer-nullish-coalescing | 2 | 2 | 0 after `ignorePrimitives` (strings, numbers, booleans: `name \|\| identity` falls back on "" on purpose; 26 such) | on, configured |
| web, e2e, hq-cards | oxlint / consistent-type-imports, no-self-compare, restrict-plus-operands, no-unnecessary-type-arguments | 1 each | all | `typeof import()` in types (5) allowed by option | on |
| all | oxlint / restrict-template-expressions, import/no-cycle | 0 | — | — | on (no cycle in any linted tree: an import-graph scan of `web/src` agrees) |
| all | oxlint / correctness, suspicious, perf categories | counted above | — | — | on, with the rules listed under "Turned off" |
| desktop | rustfmt (`max_width = 120`, `use_small_heuristics = "Max"`) | 17 hunks | 16 | 1 (the `KEYS` table of `layout.rs`, a grid on purpose: `#[rustfmt::skip]` is its fix) | on; the defaults would give 56 hunks |
| desktop | clippy `all` (deny) | 0 | — | — | on |
| desktop | clippy pedantic/nursery selected: stable_sort_primitive, redundant_clone, derive_partial_eq_without_eq | 3 | 3 | 0 | on |
| desktop | rustc unsafe_code = deny | 0 on Linux; 2 expected on macOS (`idle.rs`, `layout.rs` FFI) | — | — | on: each unsafe block takes `#[allow(unsafe_code)]` with its reason (`forbid` cannot hold: the macOS calls need unsafe). Not run on macOS |
| workspace | zizmor (offline) / unpinned-uses | 37 | 37 (actions by tag, not by commit) | 0 | on |
| workspace | zizmor / dependabot-cooldown | 8 | 8 | 0 | on |
| workspace | zizmor / artipacked | 7 | 7 (`persist-credentials` not set to false) | 0 | on |
| workspace | zizmor / cache-poisoning | 2 | 2 (caches restored in the desktop release build) | 0 | on |
| workspace | zizmor / excessive-permissions | 2 | 2 (`pages: write`, `id-token: write` at workflow level) | 0 | on |
| workspace | zizmor / template-injection | 0 | — | 1 (`${{ matrix.os }}`: runner names from the matrix or a three-choice dispatch input) | on, one line ignored in `.github/zizmor.yml` |
| workspace | actionlint (+ shellcheck on `run:`) | 5 | 5 (SC2086, SC2046 word splitting meant as a list: arrays say it; SC2155; an unused loop variable) | 0 | on |
| workspace | shellcheck | 20 | 19 (SC2086 on unquoted numbers and names, SC2164 `cd` without `\|\| exit` in scripts without `set -e`, SC2034 unused loop variables) | 1 (SC1010: `echo done` to a file; quoting it is the fix) | on |
| workspace | hadolint | 2 | 2 (`cd` in `RUN` instead of `WORKDIR`; `USER nonroot` where the numeric 65532 is used above) | 0 | on |
| workspace | gitleaks (tree, not history) | 0 | — | 4 (tests' `0123456789abcdef...` keys) | on, that pattern allow-listed; a planted `ghp_` token was found |

## Turned off or not added, with why

| tool | rule | findings | why |
| --- | --- | --- | --- |
| tsc | `noUncheckedIndexedAccess` | 680 | a sample of 45: bounded loops, `split()[0]`, regex groups after a match, pixel buffers, indices validated just before (`hq-pets`' `msg.i`); none clearly real |
| tsc | `exactOptionalPropertyTypes` | 37 | `undefined` passed where a property is optional and read with `!== undefined` (`fetch`'s `body`, LiveKit's `deviceId`, the plugin commands' optional fields): correct code |
| tsc | `noPropertyAccessFromIndexSignature` | not run | style, as the brief says; nothing showed it would catch a bug here |
| tsc | kept: `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` aligned on every tsconfig | 0 | — |
| oxlint | typescript/strict-boolean-expressions | 421 (100 with nullable strings, numbers, booleans allowed) | "" and 0 mean "absent" on purpose; the 100 left are feature detection the DOM types call always present (`el.setSinkId`, `navigator.mediaDevices`), `any` and mixed unions |
| oxlint | typescript/no-unnecessary-condition | 219 | same cause: checks at run time of values the types declare present (feature detection, `window.__hq` before load, members set after construction); worth it once those types are honest |
| oxlint | typescript/no-unsafe-type-assertion | 464 | `as` narrows on purpose (DOM queries, e2e page globals, `e as Error`) |
| oxlint | jsx-a11y/prefer-tag-over-role | 17 | taste: the tags it suggests do not fit (`<img>` for a canvas or an emoji, `<output>` outside a form, `<dialog>` for Modal) or mean the same. The plugin's other rules are on (27 findings in all, re-evaluated: decision 0040) |
| oxlint | react/react-in-jsx-scope | 779 | the automatic JSX runtime |
| oxlint | eslint/no-underscore-dangle | 557 | `window.__hq` |
| oxlint | eslint/no-await-in-loop | 222 | sequential browser steps |
| oxlint | eslint/no-shadow | 147 | taste |
| oxlint | unicorn/consistent-function-scoping | 87 | taste |
| oxlint | unicorn/no-array-sort, no-array-reverse | 54, 6 | on copies |
| oxlint | unicorn/prefer-add-event-listener | 28 | taste |
| oxlint | typescript/no-unnecessary-type-conversion | 17 | half are `String(x)` on input whose type nothing checks at run time |
| oxlint | typescript/no-unnecessary-boolean-literal-compare | 21 | e2e `=== true` on page values that may be undefined |
| oxlint | promise/always-return | 16 | `.then` setting state |
| oxlint | react/no-array-index-key | 15 | static lists |
| oxlint | unicorn/require-post-message-target-origin | 14 | `MessagePort.postMessage` |
| oxlint | typescript/consistent-return | 14 | effects with a cleanup in one branch |
| oxlint | eslint/no-useless-return | 7 | a `return;` closing each branch, the art code's style |
| oxlint | oxc/no-map-spread, unicorn/prefer-set-has, no-unmodified-loop-condition, import/default, no-unassigned-import, no-named-as-default-member, unicorn/require-module-specifiers, no-array-fill-with-reference-type, react/exhaustive-effect-dependencies, typescript/no-unnecessary-type-parameters, no-unsafe-enum-comparison | 6, 5, 5, 3, 2, 4, 4, 2, 2, 2, 1 | spread off hot paths; few-item lists; flags changed by callbacks; Vite `?url` and CSS imports; `export {}` in `.d.ts`; PixiJS `fill()`; deliberate effect triggers; the SDK's generic `onMessage<T>`; LiveKit enum strings |
| oxlint | pedantic: require-await (21), no-promise-executor-return (36), prefer-includes (11), no-loop-func (4), no-useless-promise-resolve-reject (3), return-await (3), and the style ones (prefer-readonly-parameter-types 2583, no-inline-comments 766, no-confusing-void-expression 566, require-unicode-regexp 369, sort-vars 170, max-lines..., explicit-length-check 97, ...) | | async stubs, the `new Promise((r) => setTimeout(r))` idiom, regex `.test` for clarity, closures over `const`, style. Kept from pedantic: `eqeqeq` (with `== null` allowed: 11 findings, all that idiom, so 0), `no-self-compare`, `restrict-plus-operands`, `no-deprecated` |
| golangci-lint | govet `fieldalignment`, `shadow` | 102, 50 | padding order; `if err := ...` |
| golangci-lint | contextcheck | 34 | the WebSocket loop and the shutdown flush use the server's context on purpose |
| golangci-lint | forcetypeassert | 54 | 51 in tests (a panic fails the test with its line), 2 of 3 in prod on `net.Listen("tcp")`'s `*net.TCPAddr` |
| golangci-lint | thelper | 31 | 25 table-case closures (`t.Setenv` one-liners); the 4 named helpers without `t.Helper()` are real but too few to carry the rule's noise; `tb` naming is taste |
| golangci-lint | errchkjson | 53 | `b, _ := json.Marshal(x)`: an explicit discard, mostly of types that cannot fail |
| golangci-lint | exhaustive | 3 | the world's two-phase event switches handle subsets on purpose; WebSocket close codes |
| golangci-lint | predeclared, gocritic builtinShadow/importShadow/hugeParam/rangeValCopy/unnamedResult/paramTypeCombine/typeDefFirst/ifElseChain/sloppyReassign/httpNoBody/emptyStringTest/initClause | 1, 3, 1, 29, 31, 16, 2, 1, 1, 2, 6, 2, 1 | taste or copy-cost hints off the hot paths |
| golangci-lint | gosec rules listed above | 84 | each excluded with its reason in `.golangci.yml` |
| golangci-lint | staticcheck QF1001 | 1 | De Morgan: taste |
| clippy | needless_pass_by_value | 4 | every one a `#[tauri::command]`, which takes its arguments by value |
| clippy | doc_markdown, similar_names, items_after_statements, option_if_let_else, map_unwrap_or, missing_const_for_fn, clippy::cargo | 9, 1, 1, 1, 1, 2, 4 | taste; `const fn` on platform stubs; package metadata of an unpublished binary |
| licence check | Go and npm against THIRD_PARTY_LICENSES.md | not added | no pinned tool did it cleanly for both ecosystems in this step |

## Files without types (a configuration defect the strict rules exposed)

Oxlint's type-aware rules type a file with its nearest `tsconfig.json`. `web/test`, `tools/fdash`, `scripts/`,
`plugins/sdk` and every plugin's `test/` and `tools/` had none that held them (their configs are named
`tsconfig.test.json`), so every value there was an error type: the existing promise rules saw nothing in those
files, and the `no-unsafe-*` rules reported 3000 findings that were only the missing types (fdash alone went
from 2242 findings to 181). Each now has a `tsconfig.json` that only extends its `tsconfig.test.json`;
`scripts/oxlint-tsconfigs.ts` lists linted files outside their program and a test in `scripts/oxlint.test.ts`
fails on any but 11 known ones (the plain-JavaScript SDKs, three JavaScript fixture plugins, a fixture without
config, the plugins' `vitest.config.ts`), whose type-dependent rules are off in `.oxlintrc.json`'s first
override. With types, `no-floating-promises` found 60 `test(...)` calls of `node:test` in fdash's tests: its
`allowForKnownSafeCalls` now names `node:test`.

## Time each tool adds (measured, this machine)

| tool | before | after |
| --- | --- | --- |
| Go lint (`server`) | gofmt + vet + staticcheck: 1.6 s warm | golangci-lint: 11.0 s with an empty cache, 2.0 s warm |
| govulncheck (`server:lint:vuln`) | — | 9.9 s (network: the vulnerability database) |
| Oxlint, 16 projects one after another | 5.2 s | 5.9 s |
| tsc | — | no measurable change (the kept flags add no file) |
| actionlint + zizmor | — | 4.7 s the first time (`go tool` builds actionlint), then under 1 s; zizmor 0.2 s |
| gitleaks (tree, 4.7 MB) | — | 0.3 to 0.6 s scanning, about 9 s the first time (build) |
| shellcheck, hadolint | — | 0.4 s, under 0.2 s |
| clippy (container) | — | 86 s the first time (dependencies), 1.5 s after; rustfmt 0.2 s |
| first download of shellcheck, hadolint, zizmor | — | a few seconds, once per version |

The cache of fdash skips each of them when its inputs did not change: `lint:secrets` and `desktop:lint` were
seen `CACHED` on a second run. A failing command is never cached, so until the fixes land every lint runs.
