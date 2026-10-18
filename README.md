# Home Quarters

> A fork of [Tilework](https://github.com/guhcostan/tilework) by [Gustavo Costa](https://github.com/guhcostan).

![Home Quarters: an office seen from above, with assigned desks, two people talking at a desk, others at their desks and two walking down the aisles with their pets](site/assets/banner.png)

**Home Quarters (HQ) is an open source, self-hosted 2D virtual office.** Everyone has a pixel-art avatar on a shared map; a call starts with proximity audio and video when you walk up to someone and ends when you walk away. It runs in the browser and you host it yourself: one Go binary, SQLite and a LiveKit media server, no paid service.

Why it has its own name: [decision 0024](docs/decisions/0024-home-quarters.md); existing installations follow [Upgrading to Home Quarters](deploy/README.md#upgrading-to-home-quarters)). This fork keeps the original's rules (efficiency first, the server decides, only measured claims, every change through the [gauntlet](docs/gauntlet.md)) and makes its own product choices. It is alpha software; the documentation lives in [docs/](docs/).

## What this fork changes

- **Desks and offices.** A room's call starts with two people, so nobody captures alone. An assigned desk is a small room with its own call that its owner can lock; one desk or private office per person. A member without one takes a free desk with the button next to it and gives it back from its room. Ctrl+D (Cmd+D) runs back to your desk. Administrators knock at closed doors like anyone, or force them on purpose, which is announced and logged. A room that did not change keeps its call when the map changes. Decisions [0019](docs/decisions/0019-room-calls-from-two-and-desk-rooms.md) and [0020](docs/decisions/0020-members-take-free-desks.md).
- **Sign-in.** Optional Google sign-in with admission by Workspace domain or by invite, a privacy policy page and a public page about the office generated from the configuration ([decision 0021](docs/decisions/0021-sign-in-providers.md)). A one-time sign-in link opens your account on a second machine.
- **Getting around.** Shortcuts follow key positions (ZQSD works on AZERTY), Ctrl+wheel zooms one level per notch, left-drag looks around, the camera stays within the office, and "Walk to" goes onto the person's tile or stops at a closed door. Everybody's position survives a server restart. [Decision 0018](docs/decisions/0018-physical-keys-and-map-zoom.md).
- **Presence.** You go away when the computer is idle or locked (never during a call or a presentation); busy and away grey the map out, Ctrl+U toggles busy, and busy or away people can still be waved at. A chime marks entering and leaving a conversation, and a page from an older deploy asks to reload.
- **Audio and video.** Optional noise suppression (RNNoise, Speex or GTCRN); microphone, camera and speaker can be changed from the settings at any time.
- **Avatars.** Beards, hats, a hijab, more hair styles, any colour, and appearance in its own dialog.
- **Administration.** Administrators rename the office live for everybody.
- **Look.** The Jersey 10 pixel font, the people panel's main actions on each row, and one button size across dialogs.
- **Operations.** Abnormal disconnects are logged at WARN, and the tooling, the browser suite and the gauntlet run on Windows.

## Features

Inherited from the original and kept:

- **Proximity conversations** with hysteresis and small groups; nothing is captured before you opt in. Available, busy, away and invisible.
- **Meeting rooms** with access rules enforced by the server (open, members, admins, list), lockable rooms and knocking.
- **Screen sharing** up to 1080p, expandable over the map, full screen or picture-in-picture; a **spotlight** pad broadcasts to the whole office.
- **Chat**: office (last 500 messages kept), conversation and direct messages (never stored).
- **Office editor** for administrators: walls, objects, rooms and their access rules, desk assignments; changes go live and persist.
- **Invites, roles and an activity log**; the last administrator can never be removed.
- Reactions, waves, raised hands, status notes, follow, portals, shared whiteboards, interactive objects (notes, embedded sites, images), a minimap, pets, a touch pad on phones and tablets, and every shortcut behind `?`.
- **Efficiency**: one goroutine per office, a spatial grid and areas of interest, state changes sent at 10-15 Hz instead of a position stream, bounded queues, a map baked into one texture and rendering on demand. See [Efficiency and benchmarks](docs/efficiency-and-benchmarks.md).

## Quick start

**Self-host with Docker.** Try the whole stack locally; the first person to join becomes the administrator:

~~~bash
git clone https://github.com/christphe/homequarters.git
cd homequarters
docker compose -f deploy/docker-compose.local.yml up --build
# open http://localhost:8080
~~~

For a real server, follow the [self-hosting guide](deploy/README.md) (Caddy for HTTPS, LiveKit, invite-only joins). This fork's CI publishes its image to `ghcr.io/christphe/homequarters`, which the production Compose file uses by default.

**Develop.** You need Go, Node.js with pnpm and a LiveKit server binary. On Windows, run the scripts from Git Bash.

~~~bash
./scripts/dev.sh
~~~

Open http://localhost:5173 in two browser profiles, walk the avatars toward each other and enable audio and video when asked. The dev stack uses LiveKit's public development keys and an unauthenticated join; production mode refuses to start with those defaults.

~~~bash
cd server && go test -race ./...      # world, store, media
cd web && pnpm exec tsc --noEmit      # type-check the client
scripts/gauntlet.sh                   # every gate, including the real-browser suite
~~~

Every environment variable is in [Getting started](docs/getting-started.md). More answers in the [FAQ](docs/faq.md).

## Status

What was run, on which machine, and what was not, is in [docs/status.md](docs/status.md). In short:

- The Go tests (with the race detector) and the real-browser suite (Chrome with a real LiveKit) pass on Windows 11 for this fork's changes. On Windows, the video RTP checks of `proximity` and `spotlight` cannot run (Docker Desktop's network); CI runs them.
- Sign-in with the real Google service was checked by hand; the suite uses a development provider that walks the same path.
- The rename to Home Quarters (2026-10-18) passed every gate and 16 browser scenarios on Windows 11; `proximity` and `spotlight` ran up to their video RTP checks. The upgrade path of an existing installation is documented, not yet run on a real one.

## Architecture

~~~mermaid
flowchart LR
  subgraph Browser
    UI[React UI]
    W[PixiJS world]
    LK[LiveKit client]
  end
  subgraph Server[Go server]
    WORLD[Authoritative world<br/>spatial grid + interest areas]
    TOK[Token issuer]
  end
  DB[(SQLite WAL)]
  SFU[LiveKit SFU]
  UI --- W
  W <-- WebSocket --> WORLD
  WORLD --> DB
  WORLD --> TOK
  TOK -. scoped tokens / remove user .-> SFU
  LK <-- WebRTC --> SFU
~~~

Details in [Architecture](docs/architecture.md) and the [decision records](docs/decisions/). The repository map and the rules every change follows are in [AGENTS.md](AGENTS.md).

## Contributing

Read [CONTRIBUTING](docs/contributing.md) and [AGENTS.md](AGENTS.md) first. Everything in the repository is written in English. Report security problems privately as described in [SECURITY.md](SECURITY.md).

## Licence and credits

Home Quarters is free software: you can redistribute it and modify it under the terms of the **GNU Affero General Public License, version 3** ([LICENSE](LICENSE)). It comes with no warranty.

- **A modified version of Tilework.** Home Quarters is a modified version of [Tilework](https://github.com/guhcostan/tilework) by [Gustavo Costa](https://github.com/guhcostan), also AGPL-3.0. This fork's changes start on 2026-10-14 and are listed in [What this fork changes](#what-this-fork-changes) and in the [commit history](https://github.com/christphe/homequarters/commits/main); the original's history is kept in the same repository.
- **Source for network users.** The AGPL asks anyone who runs the software for others over a network to offer them its source. Every office does so on its about page (`/about`, linked from the join screen): the licence, a link to the source and the version running. If you run a modified version, publish your changes and set `HQ_SOURCE_URL` to your repository ([Getting started](docs/getting-started.md)).
- Sprites, map and UI are drawn by the project's own code (`web/src/game/art`), see [Art style](docs/art-style.md).
- Fonts: [Jersey 10](https://github.com/scfried/soft-type-jersey) for the interface and [Schibsted Grotesk](https://github.com/schibsted/schibsted-grotesk) for the name and the HQ icon, both SIL Open Font License 1.1.
- Third-party licences: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
