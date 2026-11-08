# The gauntlet loop

How changes are built and reviewed in this repository. Every change, by a person or an agent, runs it before it is called done. The procedure for agents lives in [`.agents/skills/gauntlet/SKILL.md`](https://github.com/christphe/homequarters/blob/main/.agents/skills/gauntlet/SKILL.md); this page is the why.

## What it is

A gauntlet loop separates **building** from **judging**. A builder implements against a written target; critics inspect the result; the builder addresses supported findings and repeats. Research checked on 2026-10-01:

- [RoboNuggets, by Jay E, crediting Matt Shumer's technique](https://github.com/robonuggets/gauntlet-loop): separate critics with fresh context and blind comparison against a named, accessible reference. Its stopping rule is winning the comparison or user interruption.
- [kamtS/gauntlet-loop](https://github.com/kamtS/gauntlet-loop/blob/main/SKILL.md): bounded worker/critic passes, evidence-backed verdicts and an integration review; its runtime implementation routes workers and critics to different clients.
- [Anthropic's evaluator-optimizer pattern](https://www.anthropic.com/engineering/building-effective-agents): generation and evaluation repeat with feedback when criteria are clear and iterative improvement is useful.

Our local skill is an original, repository-specific procedure informed by these patterns; no external skill code was copied. We use acceptance tests rather than mandatory blind comparison, a maximum of five rounds, and read-only critics. These are local choices, not requirements shared by all gauntlet implementations.

Risks we address in this repository:

| Failure mode | Answer here |
| --- | --- |
| **False independence** | fresh-context critics receive acceptance criteria and raw evidence; fallback passes are labelled self-review |
| **Weak acceptance metrics** | criteria describe observable behaviour; bug regressions are seen **red** first |
| **Invented findings**: a critic told to find problems finds some | a finding needs severity, `file:line`, a reproduction and the check that would catch it, or it is dropped |
| **Regressions across rounds** | record the baseline and run the whole suite at completion |
| **Review side effects** | critics are read-only; mutations follow the AGENTS.md rules and the user's authorization |

## Why this repository needs it

Two bugs from 2026-10-01 shaped it:

- **The pet passed its test and still felt wrong.** The test checked "the pet ends up within 24 px of its owner", which is exactly what a glued, corner-cutting pet does. The fix started from observable criteria (follow the owner's trail ~20 px behind, never cut a corner, never outrun a walker, rest behind and not on top), a frame-by-frame recorder that went red on all four, and a **UX critic** that looked at a captured contact sheet. Metrics alone had already approved the bad pet once.
- **Sending a chat message blanked the whole app.** An effect returned `scrollIntoView()`'s value, which Chrome 154 turned into a Promise; React called it as a cleanup and unmounted everything. The browser suite sent chat through the API and never with the panel open. The fix added a real-UI regression check and a static rule (now `hq/effect-cleanup` in `scripts/oxlint-hq.ts`), so this bug class is now a gate.

## Gates

`scripts/gauntlet.ts` (or `scripts/gauntlet.sh`, which calls it) runs the workspace's `default` task through fdash ([decision 0035](decisions/0035-fdash.md), [decision 0037](decisions/0037-test-pyramid.md)): first `static`, the `lint`, `build` and `test:unit` of every project (formatting, Go vet, staticcheck and race tests, the type checks of the client, the tooling, the desktop app and each plugin, Oxlint on each project's folder with the project's own rules, the protocol docs check, the client, server and site builds, the unit tests of each project), then every `test:integration` (each plugin's `*.ispec.ts` and the SDK's, against `homequarters testbed`), then every `test:e2e`: the browser suite of `e2e/` and the plugin e2e projects of `plugins/e2e/`, with the CI viewport (`E2E_VIEWPORT=small`, 800x450). The integration suites run at once (each testbed has its own port and database); the browser suites run one after the other (the `e2e/` suite shards itself with `E2E_PARALLELISM`, and a plugin suite run beside it once starved its plugin of its 50 ms budget). The static gates run in parallel (`FDASH_JOBS`); a gate, or a browser scenario, that already passed on the same inputs is reported `CACHED` and not run again (`FDASH_FORCE=1` runs everything); each project's `fdash.json` says what its tasks read. Pass scenario names to run only those scenarios of `e2e/` (the plugin e2e projects are then left out); the final round runs the whole suite. `E2E_PARALLELISM=N` runs the `e2e/` suite as N shards at once, each with its own server, LiveKit and Chrome; CI runs the browser tests as four parallel jobs, each with a share of the `e2e/` scenarios and of the plugin e2e projects (`e2e/shards.ts`). Local runs wait for one of `E2E_MAX_PARALLEL` machine-wide slots (set in `.env`, default 2), each with its own ports (and LiveKit, for `e2e/run.ts`), so several agents can run the gauntlet on one machine without overloading it; on a CI runner (`CI` set) each job is one run on its own runner, so it takes no slot and keeps the default ports with LiveKit on 7880. `GAUNTLET_SKIP_E2E=1` reports a partial static result, never completion. A log in `.gauntlet/last-gates.log` records the tree fingerprint and detects edits during the run. The fingerprint covers the content of the files the gates read, not the commit: the changelogs and `docs/superpowers/` are left out, so a commit that only touches them keeps the record current.

Each check goes to the cheapest seam that can see it. Rules and logic (a game's moves, who may press a button, what a view announces) are unit tests: Go tests for the server, `web/test` for the client and each plugin's own `test/*.test.ts` for its code, with a pure function extracted when the logic is tangled with I/O. What a plugin's server code does with real members (seats, presence, stored data, restarts) is an integration test in the plugin (`*.ispec.ts`, against the testbed). The browser tests check what only a browser shows: real controls, pixels, iframes and their messages, sync between pages; they keep each feature checked once through its real controls. A browser check a lower tier already covers costs seconds in every run and finds nothing more: the `chess` and `cards` scenarios lost such checks to `plugins/bundled/hq-chess/test/chessView.test.ts` and the Go tests (2026-10-26, `docs/status.md`), which are now the plugins' integration tests.

## Critics

| Critic | Lens | Evidence it must produce |
| --- | --- | --- |
| **UX** | does it *feel* right: motion, timing, layout at 800x450 and on a phone, overlap with other UI | frames or a contact sheet (see `e2e/scenarios/capture-*.ts`), viewed, plus the scenario run |
| **Invariants** | the AGENTS.md invariants: authoritative server, no per-frame sends, bounded queues, no content in logs, consent, audit, i18n, a11y | the `file:line` that breaks one, and the test that would catch it |
| **Regression and security** | what else this change can break; input validation, token scope, rate limits | a failing command |

## Limits

The loop reviews the requested change; it is not proof that the entire repository is defect-free. A critic verdict complements executed checks. Performance and capacity claims still need their own recorded measurements.
