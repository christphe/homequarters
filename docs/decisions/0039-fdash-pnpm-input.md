# 0039: fdash keys a task on its member's part of the pnpm lockfile

Date: 2026-11-08. Status: accepted. Amends [decision 0035](0035-fdash.md) and the cache keys of
[decision 0038](0038-pnpm-workspace-vitest.md).

## Context

Decision 0038 put every TypeScript project in one pnpm workspace with one `pnpm-lock.yaml`, and every fdash
task that runs installed tools listed that lockfile as an input. A package bumped for one project (the
site's Markdown renderer) changed the key of every TypeScript task of every project: on this repository, 26
of `static`'s 31 cached commands ran again for a change only `site` installs.

## Decision

**A new input, `{ "pnpm": "<member folder>" }`** (relative to the project, like the Go provider's `cwd`).
It contributes to the key `pnpm:<importer>` and a digest of what that member installs, in the way
`{ "go": ... }` contributes only the packages a pattern reaches:

- the importer's entry (its `dependencies`, `devDependencies`, `optionalDependencies`, with specifiers and
  resolved versions);
- every snapshot reached from them, transitively, peer-suffixed keys included, and each one's package
  (version, integrity, platform fields);
- the importers it links to (`link:`), followed: a workspace member's files are already fdash's `dependsOn`,
  its external packages are not;
- the sections that change every install: `settings`, `overrides`, `patchedDependencies` (and the content of
  the patch files they name), `pnpmfileChecksum`, and any other top-level section except the catalogs, so
  that a section a later pnpm adds counts everywhere instead of nowhere. A catalog change shows up as the
  resolved versions of the members that use it.

Entries are put in a canonical form (keys sorted, entries sorted), so a reordered lockfile keeps its keys.
`node_modules` is not read: the lockfile pins each package's version and integrity.

**The lockfile is parsed by hand.** fdash stays without dependency and runs under `node --test` (decisions
0035, 0038), so no YAML library: a reader of the subset pnpm writes (block mappings and sequences by
indentation, quoted and plain scalars, one-line flow collections), about 150 lines. The other option, `pnpm
list --depth Infinity --json --filter <dir>`, was measured at 950 ms and 524 ms for one member (two runs);
a run computes a key before and after each command, about 60 computations for `static`, so it would add
about a minute. The reader fails loudly: a `lockfileVersion` other than `9.0`, or YAML it does not parse,
makes the input hash the whole lockfile, with a line saying so in the command's log. An importer the lockfile
lacks is refused (the inputs do not resolve; the command runs without the cache and its log says why).

**The lockfile stays in the signature.** The key holds the part; the list of files whose time and size are
compared after a run still holds the lockfile, so a `pnpm install` during a run still records nothing.

**The projects' tasks declare `{ "pnpm": "." }` instead of `/pnpm-lock.yaml`**, plus the members whose code
they read: a plugin's lint and tests type-check `hq-cards`' and the SDK's sources, e2e's lint reads
`web/src` and the plugins', a plugin's browser suite runs `e2e/`'s libraries. Data files (`fdash.json`,
`package.json`) and the oxlint wrapper and its rules (which import nothing installed: each project's own
oxlint loads them) do not count as reading a member. `scripts/gauntlet.test.ts` refuses an `fdash.json` that
lists the raw lockfile, a pnpm input naming no member, a task running installed tools without its own
member's part, and a task reading another member's code without declaring it.

## Consequences

- **Measured (2026-11-08, Windows 11 desktop, 12 logical CPUs, Node 24.14.1, pnpm 11.28.9, other agents
  running on the same machine):**
  - Keys of `static` (resolve, key and signature of its 31 cached commands, in one process, before and after
    interleaved, six rounds each after a warm-up): median 875 ms with the raw lockfile, 882 ms with the parts
    (each member's part computed once per lockfile content; without that memo, 833 ms against 893 ms).
    Parsing the 2,423-line lockfile takes 1.7 to 4.2 ms; a member's part 0.2 to 7 ms the first time.
    A whole `static` run with everything cached: 2.0 to 2.6 s before, 1.6 to 1.8 s after (three runs each,
    wall time; noisy, not a measured gain).
  - **Experiment:** `pnpm --filter homequarters-site update marked` (18.0.14 to 18.1.3; it also rewrote
    `site/package.json`'s range), then `fdash run static` on a cache filled on the unchanged tree. Before:
    26 of 31 commands ran (every lint, build and unit test of every TypeScript project; `server:*` and
    `fdash:test:unit` stayed `CACHED`). After: 4 ran (`site:lint`, `site:build`, `site:test:unit`, and
    `scripts:test:unit`, whose input is the whole tree), 27 stayed `CACHED`. The bump was reverted and the
    lockfile restored (`git checkout`, `pnpm install --frozen-lockfile`) after each run.
- **Not run:** a lockfile with `patchedDependencies`, `overrides` or `link:` dependencies on this repository
  (it has none; the unit tests cover them on fixtures); pnpm's lockfile v9 written by other pnpm versions
  than 11.28.9; Linux, macOS and CI.
- **Risk:** a task that uses another member's installs without reading its code (a runner calling a tool
  from another folder's `node_modules`) must declare that member by hand; the guard only sees code it can
  match by path. A wrong part is a check skipped; when in doubt, declare more members.
- **Maintenance:** about 300 lines in `tools/fdash/pnpm.ts` with their tests. A new lockfile version needs
  the reader checked against it, then added to `KNOWN_VERSIONS`; until then it costs only cache hits.
- **Install:** nothing.
