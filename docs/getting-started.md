# Getting started

This guide runs the full development stack on one machine: LiveKit, the Go server and the Vite dev server.

> The dev stack is **not** for production. It uses the well-known LiveKit development key pair and an unauthenticated join endpoint. Production mode refuses to start with those defaults (see [Privacy and security](privacy-and-security.md)).

## Requirements

| Tool | Notes |
| --- | --- |
| Go | 1.27 or newer |
| Node.js and pnpm | developed with Node 26.4 and pnpm 11.9; other recent versions are untested |
| LiveKit server | `brew install livekit` on macOS, or the official release binary / image on Linux |
| A Chromium-based browser | for the end-to-end tests: Google Chrome |

## Run it

~~~bash
git clone https://github.com/christphe/homequarters.git
cd homequarters
./scripts/dev.sh
~~~

The script starts three processes and writes their logs to `.run/`:

| Service | URL |
| --- | --- |
| App (Vite) | http://127.0.0.1:5173 |
| Go server | http://127.0.0.1:8080 (`/healthz`, `/readyz`, `/metrics`) |
| LiveKit (dev mode) | ws://127.0.0.1:7880 |

Open the app in **two different browsers or profiles** (a session is stored in a cookie), pick a name and avatar, walk toward each other, and enable audio and video when asked.

## Run the tests

~~~bash
# Go: world simulation, collisions, access rules, proximity groups, backpressure
cd server && go test -race ./...

# Web: type-check and production build
cd web && pnpm install && pnpm exec tsc --noEmit && pnpm exec vite build
~~~

The browser suite drives real Chrome instances (fake camera and microphone) against a **real LiveKit server**. It builds the app, starts its own server with a fresh database on port 18080 (and LiveKit in dev mode if nothing listens on 7880), and needs neither the dev stack nor any cleanup:

~~~bash
cd e2e && pnpm install
node run.mjs                     # all scenarios
node run.mjs proximity rooms     # some of them
HQ_EXTERNAL_URL=http://127.0.0.1:8080 node run.mjs   # against a running stack, e.g. Docker Compose
~~~

Scenarios: proximity, consent, rooms, access, editor, social, security, resilience (see [Status](status.md) for what each proves).

## Run it with Docker

~~~bash
docker compose -f deploy/docker-compose.local.yml up --build   # http://localhost:8080
~~~

That stack is for local evaluation only. The production stack, HTTPS, ports, backups and upgrades are described in [deploy/README.md](../deploy/README.md).

## Configuration

Everything is configured through environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HQ_ENV` | `dev` | `dev` or `production` |
| `HQ_ADDR` | `:8080` | HTTP listen address |
| `HQ_DB` | `data/homequarters.db` | SQLite file (WAL mode) |
| `HQ_STATIC_DIR` | empty | Directory with the built web app to serve |
| `HQ_PLUGINS_DIR` | empty (plugins off) | Folder holding `bundled/` (shipped, `hq-*`) and `installed/` (yours), both optional; administrators turn each plugin on in the admin dialog ([Plugins](plugins.md)). The image sets `/app/plugins`; `scripts/dev.sh` uses the repository's `plugins/` |
| `HQ_ALLOWED_ORIGINS` | empty | WebSocket origin patterns; **required in production** |
| `HQ_OFFICE_SLUG` / `HQ_OFFICE_NAME` | `default` / `Office` | Single-office deployment identity. The name only applies when the office is created; afterwards an administrator renames it under Administration > Office |
| `HQ_SESSION_DAYS` | `30` | Session cookie lifetime |
| `HQ_AUTH_PROVIDERS` | `none` | How people sign in: `none` (the session cookie is the account, joins by invite) or a list of `google`, `fake-oidc` (development only). With a provider, signing in is mandatory ([decision 0021](decisions/0021-sign-in-providers.md)) |
| `HQ_AUTH_DOMAINS` | empty | Domains whose accounts enter without an invite (Google: Workspace accounts of that domain), comma separated; others need an invite |
| `HQ_PUBLIC_URL` | empty | The address people open, like `https://office.example.com`; required by Google sign-in (the callback is built from it), https in production |
| `HQ_GOOGLE_CLIENT_ID` / `HQ_GOOGLE_CLIENT_SECRET` | empty | The Google OAuth client, required with `google` |
| `HQ_SOURCE_URL` | `https://github.com/christphe/homequarters` | Where people using the office get its source code, shown with the running version on the about page (`/about`, linked from the join screen). The AGPL-3.0 (section 13) requires this offer: if you run modified code, point it at your own repository |
| `HQ_OPERATOR` / `HQ_CONTACT` | empty | Who runs the office and an address for questions about personal data, shown on the privacy policy (`/privacy`) |
| `HQ_TICK_HZ` | `15` | World tick rate, 5 to 30 |
| `HQ_AOI_CELLS` | `2` | Area-of-interest radius in 128 px cells |
| `HQ_AOI_MAX_CELLS` | `8` (or `HQ_AOI_CELLS` if wider) | Largest radius a zoomed-out player may ask for (`HQ_AOI_CELLS`..8); bounds how far the map zooms out |
| `HQ_MAX_PLAYERS` | `2000` | Hard cap per office |
| `HQ_MAX_GROUP` | `8` | Maximum people in a proximity group |
| `HQ_JOIN_RATE` | `20` | Join requests per second per IP (raise only for load tests) |
| `HQ_MEDIA_TOKEN_TTL_SECONDS` | `30` | Validity of a media join token |
| `HQ_MEDIA_RECONCILE_SECONDS` | `10` | How often SFU rooms are compared with the world membership |
| `HQ_STOP_ON_STDIN_CLOSE` | unset | Local tests only: `1` shuts the server down gracefully when its stdin closes (the browser runner's stop on Windows, where a signal is a hard kill). Production refuses it |
| `LIVEKIT_URL` | empty | Public `ws(s)://` URL browsers use; empty disables media |
| `LIVEKIT_API_URL` | derived | `http(s)://` URL the server uses for admin calls |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | empty | LiveKit credentials |

## Endpoints and command line

See the endpoint table in [WebSocket protocol](protocol.md#http-endpoints). The binary also has three one-shot commands:

~~~bash
homequarters -invite admin       # print a new invite path (bootstrap the first production administrator)
homequarters -account-link Name  # print a member's personal link (refused for a member who signs in with a provider)
homequarters -backup out.db      # consistent online backup of the SQLite database
homequarters -healthcheck        # exit 0 if /readyz answers (used by the container health check)
~~~
