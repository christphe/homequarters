# 0024: Home Quarters identity and runtime namespace

Date: 2026-10-18. Status: accepted. Supersedes the names chosen in [0016](0016-tilework-name.md).

## Context

This repository started as a fork of [guhcostan/tilework](https://github.com/guhcostan/tilework) and has diverged a lot since (desks and private offices, sign-in providers, presence, its own operations). Carrying the original's name makes the two projects hard to tell apart for users, for search and for container images, and it implies an endorsement the original never gave. The fork needs its own identity while still crediting where it comes from.

## Decision

Use **Home Quarters** (short form **HQ** where space is tight) as the brand, and `homequarters` as the repository (`github.com/christphe/homequarters`), Go module, command (`server/cmd/homequarters`), Docker image (`ghcr.io/christphe/homequarters`), Compose project and service, and default database file (`data/homequarters.db`). The documentation site moves to `https://christphe.github.io/homequarters/`.

Runtime names use the short form: environment variables `HQ_*`, Prometheus metrics `hq_*`, the session cookie `hq_session` (and `hq_auth_*`, `hq_signup` during sign-in), browser storage `hq.*`, the deploy version meta tag `hq-version` and the test hook `window.__hq`.

- **Configuration reads `HQ_*` only.** Unlike 0016, which refused retired `OG_*` variables, the server neither refuses nor reads `TILEWORK_*`, and the `OG_*` refusal is removed. The upgrade guide tells operators to rename their variables; a variable left under an old name is ignored and falls back to its default.
- **Browser storage is migrated once.** Before the client reads its preferences, every `tilework.*` key is copied to its `hq.*` name (an existing `hq.*` value wins) and removed. Settings, devices, avatar, name, zoom, status note and camera/microphone consent survive the upgrade.
- **The session cookie moves by itself.** A request that carries only the old `tilework_session` is served as if it carried `hq_session`, and its answer sets `hq_session` and clears the old cookie, so nobody signs in again (sessions created before the rename, including Google sign-ins, stay valid). It costs one cookie lookup per request; the code can go once the longest session (30 days by default) has expired.
- **A plain wordmark.** The name is set in Schibsted Grotesk 800 (SIL OFL), navy `#241f42` and mint `#dcf3ec`, with no decoration: stacked ("Home" over "Quarters") where there is room, on one line in headers. The icon is "HQ" in the same font, mint on a navy tile, drawn as outlines so it never falls back to another font; the 16 px favicon has its own spacing. The site serves a Latin subset of the font itself (11 KB) rather than loading it from Google, so self-hosted installs make no third-party request.
- **Credit and history stay.** The README and licence credits name guhcostan/tilework; ADR 0016, the earlier upgrade notes, dated status rows and benchmark results under `bench/results/` keep the names they were written or measured with. The benchmark report reader recognises the OpenGather, Tilework and Home Quarters container names.

## Impact

- Performance: none. No change to the tick, networking, rendering, media or storage paths. The storage migration is one pass over the browser's `localStorage` keys at start-up, then a no-op.
- Maintenance: one namespace across code, scripts, CI, docs and the site. The legacy-variable scan is gone from the configuration code; the only code that knows the old name is the storage migration and its tests, which can be removed once browsers from before the rename no longer matter.
- Installation: fresh installations use Home Quarters names throughout. Existing ones must, before starting the new release, rename `TILEWORK_*` variables to `HQ_*`, point `HQ_DATA_VOLUME`, `HQ_DB` and the Caddy volume overrides at their existing volumes and database file (otherwise Compose creates an empty office), switch the image, update monitoring to `hq_*` and expect one sign-in per person. The steps are in [Upgrading to Home Quarters](../../deploy/README.md#upgrading-to-home-quarters).
