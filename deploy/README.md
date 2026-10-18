# Self-hosting Home Quarters (single node)

Two stacks, deliberately different:

| | `docker-compose.local.yml` | `docker-compose.yml` (production) |
|---|---|---|
| `HQ_ENV` | `dev` | `production` (refuses insecure config) |
| `HQ_VERSION` (names the deploy; browsers on a page from another version are asked to reload) | unset: a hash of the built page | the commit, set at build time in the published image (`--build-arg HQ_VERSION=...` when building yourself) |
| LiveKit keys | public dev pair (`devkey`/`secret`) | yours, from `.env`; the server aborts on the dev key or a secret shorter than 32 chars |
| TLS | none (`http://localhost` is a secure context) | Caddy, automatic certificates |
| Joining | anyone reaching the port | invite links only, or [sign-in with Google](#sign-in-with-google) |
| Exposed | 127.0.0.1 only | 80/443, 7881/tcp, 7882/udp, 3478/udp |

## Local evaluation

```sh
docker compose -f deploy/docker-compose.local.yml up --build
# open http://localhost:8080 — the first person to join becomes the administrator
```

## Production

1. Two DNS names pointing to the server: one for the app (`APP_DOMAIN`) and one for LiveKit (`LIVEKIT_DOMAIN`).
2. `cp deploy/.env.example deploy/.env` and fill it in (keys: `openssl rand -hex 8` / `openssl rand -hex 32`).
3. Open the firewall: **80/tcp, 443/tcp, 7881/tcp, 7882/udp, 3478/udp**.
4. Create the first administrator invite: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm homequarters -invite admin` prints `/?invite=…`; open it on your domain. Then invite others from *Settings → Invite people* (admins only).
5. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`.

The stack uses the prebuilt image `ghcr.io/christphe/homequarters:latest` (linux/amd64 and linux/arm64, published by `.github/workflows/docker.yml`). Drop `--build` to pull it instead of building on the server; set `HQ_IMAGE` in `.env` to pin a version.

### No domain yet?

Any wildcard-IP DNS service works for a first try, for example `APP_DOMAIN=office.203-0-113-7.sslip.io` and `LIVEKIT_DOMAIN=rtc.203-0-113-7.sslip.io` (replace with your public IP, dots as dashes). Caddy gets real certificates for them. Use your own domain for anything that matters: these hostnames depend on a third-party resolver and share Let's Encrypt rate limits with everyone else using them.

## Sign in with Google

Optional. Without it (`HQ_AUTH_PROVIDERS=none`, the default) the session cookie is the account and people join with invite links. With it, everybody signs in with a Google account; the name and avatar are still chosen in Home Quarters ([decision 0021](../docs/decisions/0021-sign-in-providers.md)).

1. In the Google Cloud console (any project, no Workspace administrator rights needed): *APIs & Services > OAuth consent screen*, user type **External** (so invited guests outside your organisation can sign in), scopes `openid` and `email` only, then **Publish app** (in *Testing*, only listed test users can sign in). With only these scopes Google does not review the app. Home page `https://APP_DOMAIN/about`, privacy policy `https://APP_DOMAIN/privacy`, authorized domain `APP_DOMAIN`'s registrable domain: Home Quarters serves both pages without sign-in, written from this server's configuration; set `OPERATOR` and `CONTACT` in `.env` so they name you and an address for data requests. (`https://APP_DOMAIN` itself is the sign-in screen, which Google's branding review refuses as "behind a login".) To show your app name and logo on the consent screen, Google also verifies the branding: prove you own the domain in [Google Search Console](https://search.google.com/search-console) (a DNS `TXT` record) with an account that is an owner or editor of the Cloud project, then ask for verification. Without branding verification sign-in still works; the consent screen just shows the domain instead of your logo.
2. *Credentials > Create credentials > OAuth client ID*, type **Web application**, authorised redirect URI `https://APP_DOMAIN/auth/google/callback`.
3. In `deploy/.env` (Compose passes them as `HQ_AUTH_PROVIDERS`, `HQ_AUTH_DOMAINS`, `HQ_GOOGLE_CLIENT_ID`, `HQ_GOOGLE_CLIENT_SECRET`, and `HQ_PUBLIC_URL=https://APP_DOMAIN`):

   ```sh
   AUTH_PROVIDERS=google
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   AUTH_DOMAINS=example.com      # Workspace accounts of this domain enter on their own; others need an invite
   ```

4. Restart. Accounts of the domain come in by themselves as members; invite links still let anybody else in, once signed in. The first administrator of a new office still comes from `homequarters -invite admin` (step 4 of Production).

Switching it on for an office that already has members: each member who comes back with a valid session is asked, by name, to connect a Google account once and keeps their account (desk, role, history). For a member whose session has expired, print their personal link with `docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec homequarters /app/homequarters -account-link "Name"`: it opens their session, which then asks them to connect. Sessions last `HQ_SESSION_DAYS` (30) from when they were created.

If your Workspace administrators block unconfigured third-party apps, colleagues cannot sign in until they allow this client id; try it with your own account first. Removing a member is not a ban: someone from the domain who signs in again becomes a new member.

## Plugins

The image sets `HQ_PLUGINS_DIR=/app/plugins` and ships its bundled plugins (named `hq-*`) in `/app/plugins/bundled`; each stays off until an administrator turns it on (Administration > Plugins). To install your own, mount a folder at `/app/plugins/installed`, for example `- ./my-plugins:/app/plugins/installed:ro` under the `homequarters` service, and restart; the bundled ones stay available. Installed plugins must not use the `hq-` prefix. Plugins are trusted code that runs in the server: install only what you have read. See [Plugins](../docs/plugins.md).

## Public demo mode

`DEMO=1` turns a production stack into a public sandbox ([decision 0011](../docs/decisions/0011-public-demo.md)):

- anyone can join **without an invite, always as a member** (never as administrator, even as the first visitor); anonymous sign-ups are limited to about one every 5 s per IP, burst 5;
- every `DEMO_RESET_HOURS` (default 6, on wall-clock boundaries) the office map is restored to the starter office and the office chat and all whiteboards are wiped; members and their sessions are kept;
- the join screen and the top bar tell visitors it is a public demo and when it resets.

Recommended with it: `MAX_PLAYERS=60`, `SESSION_DAYS=1`. The operator still creates an administrator with a CLI invite (step 4 above). Production guard rails stay on (HTTPS, real LiveKit keys, origin list).

## Oracle Cloud "Always Free"

Scripts in [`deploy/oracle/`](oracle/) reproduce the public demo host:

1. `deploy/oracle/provision.sh` (needs the OCI CLI configured) creates a VCN, an internet gateway, a security list that opens exactly 22, 80, 443, 7881/tcp, 7882/udp and 3478/udp, a public subnet and an Ubuntu 24.04 VM, and prints its public IP. Default shape: Ampere A1 (2 OCPU, 12 GB). A1 capacity is often exhausted ("Out of host capacity"); `HQ_OCI_SHAPE=VM.Standard.E2.1.Micro` uses the always-free AMD micro VM (1 GB RAM) instead.
2. `ssh ubuntu@IP "bash -s" < deploy/oracle/bootstrap-host.sh` opens the host firewall (Oracle's Ubuntu image rejects everything but SSH even when the security list allows it), adds 2 GB of swap and installs Docker with Compose.
3. Copy `deploy/` to the VM, write `deploy/.env` and start the stack as above.

Nothing here is billed while you stay inside the Always Free limits. The micro VM's CPU is small: it is fine for a handful of people in calls, not for a large meeting (no capacity was measured on it).

### HTTPS, ICE, STUN/TURN and credentials

- Browsers only allow camera, microphone and screen capture on HTTPS (or localhost), so TLS is not optional. Caddy obtains and renews certificates; ports 80/443 must be reachable for the ACME challenge.
- **ICE/STUN:** LiveKit runs with `use_external_ip: true` and a single UDP port (7882) plus 7881/tcp as a fallback. The server discovers its public address with STUN, so it must be able to reach the internet.
- **TURN:** LiveKit's embedded TURN listens on 3478/udp for clients that cannot use UDP directly. Networks that block all UDP fall back to ICE/TCP on 7881. **TURN over TLS on 443 is not configured** (it needs a certificate mounted into the LiveKit container); strict corporate firewalls may need it.
- **Credentials are short-lived and scoped:** the app server mints a LiveKit join token per conversation (valid 30 seconds plus LiveKit's 60 s clock-skew tolerance, one room, one identity, publish sources limited to microphone/camera/screen share) and removes the participant from the SFU when they leave or lose permission. There are no long-lived shared media credentials in the browser. `LIVEKIT_API_SECRET` never leaves the server.
- **Not verified in this repository:** the TURN relay path and behaviour behind strict NAT/firewalls. Test it (e.g. with a phone on mobile data and UDP blocked) before relying on it.

### Operations

- Health: `/healthz` (liveness), `/readyz` (database reachable), `/metrics` (Prometheus text; **disabled unless `METRICS_TOKEN` is set** in `.env`, at least 16 characters; then scrape `homequarters:8080/metrics` from inside the network with `Authorization: Bearer <token>`; also blocked on the public hostname by the Caddyfile). Logs are structured JSON on stdout and contain no chat content and no tokens.
- **Backup** (consistent while running): `docker compose … run --rm homequarters -backup /data/backup-$(date +%F).db`, then copy it out of the volume (`docker compose … cp` or a bind mount). Store copies off the host.
- **Restore:** stop the stack, replace `/data/homequarters.db` in the volume with the backup (delete any `-wal`/`-shm` files next to it), start the stack. Everyone is signed out of nothing: sessions are in the database.
- **Upgrade:** take a backup, `git pull`, `docker compose … up -d --build`. Schema migrations run automatically at start, inside a transaction, forward-only. To roll back the code, restore the backup taken before the upgrade.
- **Update LiveKit:** the image is pinned to `v1.13.7`. Re-read the release notes and re-run the end-to-end suite (`e2e/`) before bumping.

## Upgrading to Home Quarters

The project was called Tilework until 2026-10-18 ([decision 0024](../docs/decisions/0024-home-quarters.md)). Nothing changes in the database schema, LiveKit or the network ports; names do. An existing installation keeps its data only if you point the new stack at the volumes and database file it already has, so follow the steps in order.

1. **Before `git pull`**, with the files you have now, take an online backup and save `deploy/.env`:
   `docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm tilework -backup /data/backup-before-hq.db`
2. Still before pulling, stop the old stack: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env down` (never `down -v`: it deletes the volumes, that is your office). The Compose project is renamed, so the old containers would otherwise keep ports 80 and 443.
3. List the volumes with `docker volume ls` and note the office's data volume and Caddy's two volumes. With the previous defaults they are `tilework_tilework-data`, `tilework_caddy-data` and `tilework_caddy-config` (a custom project name gives other names; an installation from before Tilework may still use `opengather_*` ones through overrides).
4. In `deploy/.env`, rename every `TILEWORK_` variable to `HQ_` (`TILEWORK_IMAGE` to `HQ_IMAGE`, `TILEWORK_DB` to `HQ_DB`, and so on). **The old names are ignored**: a variable left under its old name silently falls back to its default, and a forgotten database path or volume opens an empty office. An install that does not use this Compose file (the binary, systemd, `docker run` with an env file) must set `HQ_ENV=production` itself, or it starts in development mode: open metrics, cookies without `Secure`, and the first person to join becomes administrator without an invite. Then make sure these four lines name what step 3 found (with the previous defaults):

   ```env
   HQ_DATA_VOLUME=tilework_tilework-data
   HQ_DB=/data/tilework.db
   HQ_CADDY_DATA_VOLUME=tilework_caddy-data
   HQ_CADDY_CONFIG_VOLUME=tilework_caddy-config
   ```

   If you already had overrides (for example `opengather_og-data` and `/data/opengather.db`), keep their values and only rename the keys. Fresh installations need none of this: they use `homequarters` names throughout.
5. `git pull`, then start as usual (`docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d`). Compose may warn that the volumes were created for another project; that is expected. Check that the office has its members and map, and that `docker volume ls` shows no new `homequarters_homequarters-data` volume: if one appeared, the overrides were not read (stop the stack and fix `.env`; that new volume is empty).
6. Local evaluation stack: the same applies with `HQ_DATA_VOLUME=tilework-local_tilework-data` and `HQ_DB=/data/tilework.db` in the shell or an env file passed with `--env-file`.

What else changes:

- **Image, binary, service:** `ghcr.io/christphe/homequarters` (set `HQ_IMAGE` to pin a tag), `/app/homequarters`, Compose service and project `homequarters`. Commands in this guide use the new service name (`run --rm homequarters -invite admin`). Git remote `https://github.com/christphe/homequarters.git`; docs at `https://christphe.github.io/homequarters/`. `bench/run-vm.sh` expects the checkout in `~/homequarters` on the host.
- **Nobody signs in again.** The session cookie is now `hq_session`. A browser that still holds the old `tilework_session` keeps its session: the server reads it, sets `hq_session` with the same session and clears the old cookie on that browser's next request. Accounts, desks, roles and history stay in the database.
- **Metrics** are `hq_*` instead of `tilework_*`: update Prometheus queries, dashboards and alerts.
- **Browser preferences** (settings, devices, avatar, name, zoom, status note, camera and microphone consent) move from `tilework.*` to `hq.*` keys on the first visit after the upgrade; nobody has to choose them again. Media capture still starts only after the explicit opt-in.
- To roll back, stop the stack, restore the backup from step 1 and start the previous release with its previous `.env`.

### Earlier rename: OpenGather to Tilework (2026-10-02)

The earlier rename, from OpenGather to Tilework on 2026-10-02, moved `OG_` variables to `TILEWORK_`, the image to `ghcr.io/guhcostan/tilework`, metrics to `tilework_*`, the cookie to `tilework_session` and browser keys to `tilework.*`, and kept data through `opengather_og-data`, `opengather_caddy-data`, `opengather_caddy-config` and `/data/opengather.db` overrides. An installation that still runs an OpenGather release follows the steps above, renaming `OG_` variables straight to `HQ_` and keeping those values; Home Quarters no longer recognises `OG_` names either.

Historical benchmark files under `bench/results/` keep the names captured when they were measured (OpenGather and Tilework). They are not measurements of the renamed release. The report reader accepts the historical container names as well as the Home Quarters ones.
