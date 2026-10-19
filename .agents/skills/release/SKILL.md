---
name: release
description: Cut a Home Quarters release. Write the changelog from the commits since the last release (Keep a Changelog, with fchange), promote it with frelease, tag the version, and publish the GitHub release ("What's Changed") and the Docker image. Use when asked to make, cut or publish a release.
---

# Release

A release is a version tag on `main`. It comes with:

- a `CHANGELOG.md` section in the [Keep a Changelog](https://keepachangelog.com) format;
- a GitHub release whose notes are that section, under "What's Changed";
- the Docker image `ghcr.io/christphe/homequarters:X.Y.Z`, which `.github/workflows/docker.yml` publishes when the tag is pushed.

The changelog is kept with [fantastic-change](https://github.com/fantastic-jam/fantastic-change), configured by `fchange.json`:

- `fchange <type> "<entry>"` adds an entry under `## [Unreleased]` and records the version bump it implies;
- `frelease` turns `[Unreleased]` into the next version.

## 0. Before

- The tools: `fchange --version`. If they are missing, run `npm install -g @fantastic-jam/fchange` (Node 22.7 or later). `gh` must be signed in; the repository is `christphe/homequarters`.
- Work in a fresh worktree from `origin/main` (`git fetch origin`, then `git worktree add -b release/next .claude/worktrees/release origin/main`), never in a shared checkout.

## 1. What the release covers

- **The range.** The last tag is `git describe --tags --abbrev=0 origin/main`, and the range runs from it to `origin/main`.
- **No tag yet** (the first release): `git fetch upstream` and use `upstream/main..origin/main`. That is this fork's own work, not the history inherited from the original project.
- **The commits:** `git log --reverse --format='%h %s' <range>`.
  - A squash-merged pull request ends with `(#N)`: read it with `gh pr view N --repo christphe/homequarters --json title,body`.
  - For other commits, read `git show --stat <hash>`.
- **Entries already there.** Read `## [Unreleased]` in `CHANGELOG.md`: entries recorded with `fchange` during development are already there. Do not add them twice.

## 2. Write the entries

Write one `fchange` call per change people notice, not per commit:

| Type | For | Version bump |
| --- | --- | --- |
| `added` | something new members, administrators, operators or plugin authors can do | minor |
| `changed` | something that now works differently, including configuration, environment variables, the plugin API, the protocol | minor |
| `deprecated` | something that still works but will go | minor |
| `removed` | something gone | major |
| `fixed` | a bug that no longer happens | patch |
| `security` | a security fix | patch |

How to write them:

- In English, for the people who run or use an office, not for whoever wrote the code: what it does for them, in one sentence, with the pull request at the end (`(#9)`).
- **Something an operator must do** (a renamed variable, new required configuration, a step before upgrading) is a `changed` entry starting with `**Upgrade:**`, saying what to do.
- **Describe the result, not how it was made.** No commit hashes, no rebases, no review rounds, no "first version then fixed". Group the commits of one change into one entry.
- **Leave out** tests, CI, refactors and docs-only commits, unless they change something for operators (a new migration, a new image tag, a new requirement).

Example: `fchange added "Plugins: operator-installed TypeScript plugins, turned on per office by administrators (#9)"`.

## 3. The version

`frelease --dry-run` prints the version the entries imply, from the last version in `CHANGELOG.md` (0.0.0 when there is none: a first release is 0.1.0).

The project is in alpha. **If the dry run gives a major version (X.0.0), stop and ask the user**: a `removed` entry implies one, and a removal in an alpha rarely means 1.0. Otherwise go on.

## 4. Promote, merge, tag

1. Run `frelease` in the worktree: it writes the version heading into `CHANGELOG.md` and prints the version.
2. Commit `CHANGELOG.md` (and `fchange.json` the first time) as `Release vX.Y.Z`. Push the branch, open a pull request (`gh pr create --repo christphe/homequarters`) and squash merge it at once, without waiting for CI.
3. Tag the merge commit and push the tag:

   ~~~bash
   git fetch origin
   git tag -a vX.Y.Z origin/main -m "vX.Y.Z"
   git push origin vX.Y.Z
   ~~~

   Pushing the tag starts `docker.yml`, which publishes the image tags `X.Y.Z` and `X.Y`.

## 5. The GitHub release

The notes are the version's section, under "What's Changed", followed by the comparison with the previous release:

~~~bash
{
  printf "## What's Changed\n\n"
  frelease changelog X.Y.Z
  printf "\n**Full Changelog**: https://github.com/christphe/homequarters/compare/vPREVIOUS...vX.Y.Z\n"
} > notes.md
gh release create vX.Y.Z --repo christphe/homequarters --title "vX.Y.Z" --notes-file notes.md --latest
~~~

For the first release, compare from the first commit of the range instead of a previous tag. Read `notes.md` before publishing: the headings must be `### Added`, `### Fixed` and so on, under "What's Changed".

## 6. Report

Tell the user:

- the version;
- the release URL;
- the image tag;
- whether the Docker workflow started (`gh run list --repo christphe/homequarters --workflow docker.yml --limit 1`).

Say what is not finished yet: the image is still building while that run is in progress.
