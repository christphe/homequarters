# 0036: the tooling in TypeScript, the served scripts checked through JSDoc

Date: 2026-11-07. Status: accepted.

## Context

The client, the plugins, fdash and `scripts/gauntlet.ts` were TypeScript, but the rest of the tooling was
plain JavaScript (`.mjs`): the browser suite (`e2e/`, about 7,700 lines, its runner and 34 scenarios), the
gate scripts in `scripts/`, the site generator and the plugins' sprite tools. No gate type-checked or linted
them: a scenario could read a field of `window.__hq` that the client no longer has, and only a run of the
suite (minutes, a browser, LiveKit) would tell. Five more files are JavaScript on purpose: the plugin SDKs
(`web/src/plugins/sdk.js`, `viewSdk.js`, inlined into an iframe's `srcdoc` as text), the desktop app's
`ui/setup.js` (served as is) and `src-tauri/src/missing-apis.js` (inlined by the Rust shell), and the site's
`src/site.js` (copied as is).

## Decision

- Every `.mjs` became a `.ts` file that Node 24 runs as is (type stripping): no build step, the same
  commands with `.ts` (`node run.ts`, `node build.ts`, `node scripts/oxlint.ts`). `.ts` rather than `.mts`:
  `e2e/` and `site/` declare `"type": "module"`, and Node detects the ES module syntax of the typeless ones,
  like `tools/fdash`.
- They are type-checked in strict mode like the client, with `verbatimModuleSyntax` (a type import Node would
  try to load is an error): `e2e/` and `site/` have their own `tsconfig.json`, `typescript` and `@types/node`
  (gates `e2e:tsc`, `site:tsc`); `scripts/` and the sprite tools are in `web/tsconfig.test.json` (gate
  `web:tsc-tests`). The browser suite's page code is typed with the client's own test handle: `web/src/session.ts`
  exports `HqHandle`, the type of `window.__hq`, and `e2e/globals.d.ts` declares it, so the suite and the
  client cannot drift apart without a type error. `erasableSyntaxOnly` is on for `site/` but not for `e2e/`,
  whose check also reads the client (which uses parameter properties); Node refuses such syntax when it loads
  a file, so it cannot hide in the suite either.
- The five served scripts stay JavaScript, with `// @ts-check` and JSDoc types, checked through `checkJs`:
  the SDKs by `web:tsc` (typed against `plugins/sdk/*.d.ts`, the API they implement), the desktop's two by
  the new `desktop-types` gate (`desktop/tsconfig.json`, with `desktop/globals.d.ts` for what the shell
  provides), `site.js` by `site:tsc`. The two one-line plugin fixtures under `server/internal/httpapi/testdata`
  are left as they are.
- Oxlint (`scripts/oxlint.ts`) now lints `e2e/` (not only its fixtures), `scripts/`, `site/` and the desktop
  scripts too.

## Consequences

- Performance: nothing changes at run time (Node strips the types as it loads a file). The new gates take a
  few seconds and are cached by fdash like the others; CI's `static` job also installs `e2e/`'s dependencies.
- Maintenance: a scenario is written in TypeScript; a property a scenario puts on `window` is typed where it
  is used, and a client class's private member is reached through a cast with the minimal shape it needs.
  `typescript` and `@types/node` are pinned in three `package.json` files (`web/`, `e2e/`, `site/`), kept in
  step by Dependabot's grouped updates.
- Install: none for operators. Developers run `pnpm install` in `e2e/` and `site/` as before.
