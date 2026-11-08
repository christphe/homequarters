# 0040: strict linters, with no false positive

Date: 2026-11-08. Status: draft. The tools and their configuration are in; the fixes of what they find are
pending, split by fdash project (below). Amends [decision 0033](0033-linters.md).

## Context

Decision 0033 put staticcheck on Go and Oxlint with a few type-aware rules on TypeScript, and left other
linters for later. The maintainer asked for the strictest setup that reports no false positive: every finding a
real defect, or code that is clearer and safer written the way the rule wants. The tools are added first, with
what they find on the tree measured and classified; fixing the findings is a later step, one fdash project per
agent.

## Decision

The rule applied to every linter and every rule: run it, read its findings (all of them under about 30, a sample
above), and sort each into real or false positive. Mostly real: on, as an error. A few false positives with one
narrow cause: on, with a narrow exclusion that says why where it is configured. Mostly false positives, or
taste: off, with the reason. Nothing is lowered to a warning. The classification, the counts and the rules
left out are in `docs/superpowers/specs/2026-11-08-strict-lint-violations.md`; every finding, with its project,
in the `.json` beside it.

- **Go: golangci-lint v2.15.0** replaces `gofmt -l`, `go vet` and staticcheck in `server`'s `lint` task, and
  staticcheck in CI's step for `bench/mediagen`. One `.golangci.yml` at the root: govet with every analyzer but
  `fieldalignment` and `shadow`, staticcheck with every check but QF1001 (the ST checks included: they report
  nothing here), errcheck (with the writes and closes whose error has no reader excluded by name), errorlint,
  bodyclose, noctx, sqlclosecheck, rowserrcheck, gosec (eleven rules excluded, each with its reason), unparam,
  unconvert, copyloopvar, intrange, usestdlibvars, modernize, musttag, misspell, gocritic (the `diagnostic`
  checks and `equalFold`), nolintlint (a `//nolint` names its linter and says why, as `//lint:ignore` did),
  depguard and smaller ones; gofmt and goimports as formatters. Every analyzer `go vet` runs is in govet's set.
  **depguard** makes the server's package graph a rule: each package may import the internal packages it
  imports today (`go list`), the leaves none, and only `internal/media` may import a LiveKit module (AGENTS.md).
  Left out: contextcheck, forcetypeassert, thelper, errchkjson, exhaustive, predeclared (why in the spec).
  The one `//lint:ignore` of the tree became a `//nolint:staticcheck` with the same reason (golangci-lint does
  not read the former).
- **Pinned as `go tool`s in a module of their own each**, `tools/go/<tool>/go.mod`: golangci-lint,
  govulncheck v1.9.0, actionlint v1.7.12, gitleaks v8.30.1. A tool in the server's `go.mod` would share its
  dependency graph (golangci-lint brings hundreds of modules, whose versions MVS would raise for the server
  too); one module per tool keeps each tool's graph its own and the server's untouched, and Dependabot updates
  them. The server runs them with `go tool -modfile=../tools/go/<tool>/go.mod`; the repository-wide ones are
  built with `go tool -n` and run from the root. staticcheck left `server/go.mod`.
- **govulncheck** is its own task, `server:lint:vuln`, keyed on the day as well as on the code (its database
  changes without the code changing), run by CI's unit job and not by the local `static` stage, since it needs
  the network.
- **tsc:** every tsconfig has `noImplicitOverride`, `noFallthroughCasesInSwitch` and `verbatimModuleSyntax`
  (web, desktop, `web/tsconfig.sdk.json` and the plugins' configs lacked some; no error). Not added:
  `noUncheckedIndexedAccess` (680 errors, a sample of 45 with none clearly real) and
  `exactOptionalPropertyTypes` (37, `undefined` passed to optional properties read as absent anyway), nor
  `noPropertyAccessFromIndexSignature` (style).
- **Oxlint:** the `suspicious` and `perf` categories, the typed `no-unsafe-*` rules, `no-explicit-any`,
  `no-unnecessary-type-assertion`, `restrict-template-expressions`, `restrict-plus-operands`, `no-deprecated`,
  `prefer-nullish-coalescing` (primitives ignored: `||` falls back on "" or 0 on purpose), `consistent-type-imports`,
  `import/no-cycle`, and from `pedantic` only `eqeqeq` (with `== null`) and `no-self-compare`. Twenty-five rules
  of the two categories are off with their reason in `.oxlintrc.json`. Not added: `strict-boolean-expressions`
  and `no-unnecessary-condition` (their findings, once nullable strings and numbers are allowed, are feature
  detection that the DOM types call always present), `no-unsafe-type-assertion`, the jsx-a11y plugin (as in
  0033: the `a11y` axe scenario is the gate).
- **Types for every linted file.** The type-aware rules read each file's nearest `tsconfig.json`; the test and
  tool folders had only a `tsconfig.test.json`, so they were linted against error types (the promise rules of
  0033 saw nothing there). A `tsconfig.json` that extends the test config now sits in `web/test`, `scripts`,
  `tools/fdash`, `plugins/sdk` and each plugin's `test/` and `tools/`; `scripts/oxlint-tsconfigs.ts` and a test
  keep it so, with eleven known exceptions whose type-dependent rules are off.
- **Rust (desktop/src-tauri):** `cargo fmt --check` with a `rustfmt.toml` at 120 columns, and `cargo clippy
  --all-targets --locked -- -D warnings` with a `[lints]` table: clippy's default groups denied, plus
  `stable_sort_primitive`, `redundant_clone`, `derive_partial_eq_without_eq`; `unsafe_code = "deny"` (`forbid`
  cannot hold: the macOS idle time and keyboard layout call system APIs, which then carry
  `#[allow(unsafe_code)]` with their reason). Run by desktop's task `lint:rust` (not in `static`: it needs Rust
  and, on Windows, the MSVC build tools) and by the Desktop workflow on its three systems, since clippy only
  sees what each system compiles. On Linux, clippy needs the Tauri libraries the workflow already installs
  (`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`).
- **Repository-wide**, workspace tasks grouped as `lint:repo` in `static`, run by `scripts/lint-repo.ts`:
  `lint:actions` (actionlint, which runs shellcheck on each `run:` script, then zizmor offline on `.github/`),
  `lint:secrets` (gitleaks on the working tree with `.gitleaks.toml`; the history is not scanned),
  `lint:shell` (shellcheck on every tracked `*.sh`), `lint:docker` (hadolint on `deploy/Dockerfile`).
  shellcheck v0.11.0, hadolint v2.15.1 and zizmor v1.31.1 are no Go or npm package: `scripts/tools.ts` pins each
  release file's URL and SHA-256 for five platforms, downloads it on first use into `.tools/` (git-ignored),
  checks it and unpacks it.

## Alternatives

- **golangci-lint from its release binaries** (as `scripts/tools.ts` does for the others): one fewer module, but
  a binary built with an older Go than the module's `go 1.27.0` cannot load it; building it with the local Go
  through `go tool` avoids that. golangci-lint's own documentation advises against `go tool` in the project's
  module, for the dependency reason above, which the separate module answers.
- **zizmor through pip or uv, shellcheck through npm wrappers:** a Python or a postinstall script for one tool;
  the pinned download needs only Node.
- **Online zizmor audits** (known-vulnerable actions, impostor commits): their result changes with GitHub's data,
  which fdash's cache cannot key on.

## Pending (depends on the fixes)

- The violations: 1172 findings (golangci-lint 286, govulncheck 23, Oxlint 760, rustfmt 17, clippy 3,
  zizmor 56, actionlint 5, shellcheck 20, hadolint 2), to fix project by project. Until then the gates are red:
  every lint task fails on findings only.
- The two `unsafe_code` findings expected on macOS (not run), and clippy on Windows (not run: no MSVC on the
  machine that wrote this).
- Whether CI's Go 1.27.x already fixes the 13 standard-library vulnerabilities govulncheck reports with 1.27.0.
- A dependency licence check: not added.

## Impact

- **Performance:** none at run time (development tools). Measured on the Windows 11 desktop (12 logical CPUs):
  golangci-lint on the server 11.0 s with an empty cache and 2.0 s warm, against 1.6 s for gofmt, vet and
  staticcheck; Oxlint over the 16 projects 5.9 s against 5.2 s; govulncheck 9.9 s; the repository-wide tools
  each under a second once built or downloaded; clippy 1.5 s warm in a Linux container. fdash caches each task
  on its inputs.
- **Maintenance:** four small Go modules under `tools/go/` (Dependabot updates them monthly), three pinned
  downloads bumped by hand in `scripts/tools.ts` (version, URLs, SHA-256), and configurations that list every
  exclusion with its reason. A new import between Go packages is a line in `.golangci.yml`'s depguard rules.
- **Install:** nothing changes in the image or the binary. Contributors need Go and Node as before; the first
  run of a lint builds the Go tools (about 30 s) and downloads the three binaries (network once); `lint:rust`
  needs Rust. None of these tools is linked into or shipped with Home Quarters, so THIRD_PARTY_LICENSES.md
  does not list them. Licences: golangci-lint GPL-3.0, govulncheck BSD-3-Clause, actionlint MIT, gitleaks MIT,
  shellcheck GPL-3.0, hadolint GPL-3.0, zizmor MIT; each runs as a separate program on the developer's or CI's
  machine.
