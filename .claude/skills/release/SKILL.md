---
name: release
description: Cut a Home Quarters release, of the server (server and web client, Docker image) or of the desktop app, each with its own changelog and tags. Write the changelog from the commits since that product's last release (Keep a Changelog, with fchange --pkg), promote it with frelease, tag the version, and publish the GitHub release ("What's Changed") with the Docker image or the desktop builds. Use when asked to make, cut or publish a release.
---

# Release

Home Quarters ships two products from this repository. Each has its own changelog, version and tags:

| Product | What it is | Changelog | Tag | What the tag publishes |
| --- | --- | --- | --- | --- |
| `server` | the Go server, the web client it serves, the Docker image | `server/CHANGELOG.md` | `server-vX.Y.Z` | the image `ghcr.io/christphe/homequarters:X.Y.Z` and `:X.Y` (`.github/workflows/docker.yml`) |
| `desktop` | the desktop app (`desktop/`) | `desktop/CHANGELOG.md` | `desktop-vX.Y.Z` | the Windows installer and the macOS `.dmg`, attached to the release (`.github/workflows/desktop.yml`) |

A release is one product's version tag on `main`. It comes with that product's changelog section in the [Keep a Changelog](https://keepachangelog.com) format, and a GitHub release whose notes are that section, under "What's Changed".

The changelogs are kept with [fantastic-change](https://github.com/fantastic-jam/fantastic-change). `fchange.json` lists the repository's top-level folders as packages, so every command needs its product, `--pkg server` or `--pkg desktop` (there is no command for all of them):

- `fchange <type> "<entry>" --pkg <product>` adds an entry under `## [Unreleased]` and records the version bump it implies;
- `frelease --pkg <product> --dry-run` prints the next version, or fails with "No [Unreleased] section found" when there is nothing to release;
- `frelease --pkg <product>` turns `[Unreleased]` into that version;
- `frelease --pkg <product> changelog-version` prints the last released version, and `frelease --pkg <product> changelog [X.Y.Z]` its notes.

## Which product

A release is of one product. Each step below is for that product only.

- **The user names it** (`/release server`, `/release desktop`, "release the desktop app"): release that one. If `frelease --pkg <product> --dry-run` finds nothing to release, say so and stop.
- **The user names none**: run `frelease --pkg server --dry-run` and `frelease --pkg desktop --dry-run`, and say which products have something to release and at what version. Release only what the user asked for; "release whatever there is" means each product with entries, one after the other, each a full pass through the steps below.

Never release a product whose `[Unreleased]` is empty.

## 0. Before

- The tools: `fchange --version`. If they are missing, run `npm install -g @fantastic-jam/fchange` (Node 22.7 or later). `gh` must be signed in; the repository is `christphe/homequarters`.
- Work on `main`, up to date with `origin/main` (`git pull --ff-only`).

## 1. What the release covers

- **The range.** The product's last tag is `<product>-v` followed by `frelease --pkg <product> changelog-version`, and the range runs from it to `origin/main`.
- **The commits:** `git log --reverse --format='%h %s' <range>`. For the desktop app, `-- desktop/` keeps the ones that touch it; for the server, the commits that change `server/` or `web/` (and the Dockerfile and deploy files).
  - A squash-merged pull request ends with `(#N)`: read it with `gh pr view N --repo christphe/homequarters --json title,body`.
  - For other commits, read `git show --stat <hash>`.
- **Entries already there.** Read `## [Unreleased]` in the product's changelog: entries recorded with `fchange` during development are already there. Do not add them twice.

A change that spans both (say, a server route the desktop app uses) has an entry in each changelog, each saying what it does for that product. The desktop entry names the server version it needs ("needs server 0.4.0 or later").

What the web client does ships with the **server**, even when only the desktop app shows it: the app loads the client from the office's server. Texts the client adapts for the app, or an API it uses that the app provides, are server entries; only what `desktop/` itself does is a desktop entry.

## 2. Write the entries

Write one `fchange` call per change people notice, not per commit:

| Type | For | Version bump |
| --- | --- | --- |
| `added` | something new members, administrators, operators or plugin authors can do | minor |
| `changed` | something that now works differently, including configuration, environment variables, the plugin API, the protocol | minor |
| `deprecated` | something that still works but will go | minor |
| `removed` | something gone | major |
| `fixed` | a bug that no longer happens, or something missing that people expected (a button to go back) | patch |
| `security` | a security fix | patch |

How to write them:

- In English, for the people who run or use an office, not for whoever wrote the code: what it does for them, in one sentence, with the pull request at the end (`(#9)`).
- **Something an operator must do** (a renamed variable, new required configuration, a step before upgrading) is a `changed` entry starting with `**Upgrade:**`, saying what to do.
- **Describe the result, not how it was made.** No commit hashes, no rebases, no review rounds, no "first version then fixed". Group the commits of one change into one entry.
- **Leave out** tests, CI, refactors and docs-only commits, unless they change something for operators (a new migration, a new image tag, a new requirement).

Example: `fchange added "Plugins: operator-installed TypeScript plugins, turned on per office by administrators (#9)" --pkg server`.

## 3. The version

`frelease --pkg <product> --dry-run` prints the version the entries imply, from the last version in that product's changelog.

The project is in alpha. **If the dry run gives a major version (X.0.0), stop and ask the user**: a `removed` entry implies one, and a removal in an alpha rarely means 1.0. Otherwise go on.

## 4. Promote, commit, tag

1. Run `frelease --pkg <product>` on `main`: it writes the version heading into the product's changelog and prints the version.
2. Commit that changelog on `main` as `Release <product> vX.Y.Z` and push `main`. No branch, no pull request.
3. Tag that commit and push the tag:

   ~~~bash
   git tag -a <product>-vX.Y.Z -m "<product>-vX.Y.Z"
   git push origin <product>-vX.Y.Z
   ~~~

   A `server-v` tag starts `docker.yml`, which publishes the image tags `X.Y.Z` and `X.Y`. A `desktop-v` tag starts `desktop.yml`, which builds the app with that version and attaches the installer and the `.dmg` to the release once it exists, with the signed update files; its feed job then writes `latest.json` and, for the newest desktop release, moves it to the `desktop-latest` release that installed apps read. Without the `TAURI_SIGNING_PRIVATE_KEY` secret the run warns and installed apps get no update. GitHub's hosted macOS runners are sometimes never assigned: a macOS job cancelled after about 15 minutes with no steps is rerun with `gh run rerun <run> --job <job>`. If it still gets no runner, build the release again by hand, later or on another macOS runner: `gh workflow run desktop.yml --repo christphe/homequarters -f tag=desktop-vX.Y.Z -f macos=macos-15` (or `macos-14`). It builds that tag's code and attaches its files to the release.

## 5. The GitHub release

The notes are the version's section, under "What's Changed", followed by the comparison with the product's previous release:

~~~bash
{
  printf "## What's Changed\n\n"
  frelease --pkg <product> changelog X.Y.Z
  printf "\n**Full Changelog**: https://github.com/christphe/homequarters/compare/<product>-vPREVIOUS...<product>-vX.Y.Z\n"
} > notes.md
gh release create <product>-vX.Y.Z --repo christphe/homequarters --title "<Title> vX.Y.Z" --notes-file notes.md <latest>
~~~

- The title is `Server vX.Y.Z` or `Desktop vX.Y.Z`.
- `<latest>` is `--latest` for a server release, and `--latest=false` for a desktop release: GitHub's "Latest" badge stays on the server, which is what most people install.

Read `notes.md` before publishing: the headings must be `### Added`, `### Fixed` and so on, under "What's Changed".

## 6. Report

Tell the user:

- the product and the version;
- the release URL, and the product's list of releases: `https://github.com/christphe/homequarters/releases?q=server-v&expanded=true` or `?q=desktop-v&expanded=true` (GitHub has no labels on releases; the tag prefix and the title tell the products apart);
- for the server, the image tag and whether the Docker workflow started (`gh run list --repo christphe/homequarters --workflow docker.yml --limit 1`);
- for the desktop app, whether the Desktop workflow started, and later whether the installer and the `.dmg` are attached (`gh release view <tag> --repo christphe/homequarters --json assets`).

Say what is not finished yet: the image is still building, or the desktop builds are not attached, while those runs are in progress.
