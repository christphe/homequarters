# Privacy and security

This page states what the current code does and, just as important, what it does **not** do. "Tested" means an automated check exists and was run; see [Status](status.md) for the counts.

## Implemented and tested

- **Consent gate:** media capture only starts after an explicit opt-in and never for people whose status is not *Available*. Leaving a conversation stops local capture. (Browser test.)
- **Server-side room access:** meeting rooms have access rules (open, members, admins, list, office). The world refuses to move a player into a room they cannot use and only issues a media token for the room the player is legitimately in. Bypassing the client with raw inputs does not help. (Browser and unit tests.)
- **Scoped, short-lived media tokens:** one room, one identity, publish limited to microphone/camera/screen share, data channels off, **valid 30 seconds, plus a 60 s clock-skew tolerance applied by LiveKit** ([decision 0008](0008-token-lifetime-and-reconciliation.md)). (Unit and browser tests decode the token.)
- **Revocation and reconciliation:** leaving a group removes the participant from the SFU at once (with retries), and a reconciler removes any SFU participant the server does not consider a member every 10 s. Replayed, edited and expired tokens were tried against a real LiveKit server. (Browser test.)
- **Invites and roles:** hashed, use-limited, expiring invites; administrator-only invite and map endpoints; production joins require an invite. (Store, HTTP and browser tests.)
- **Sessions:** opaque random tokens, only a SHA-256 hash is stored; the cookie is HttpOnly, SameSite=Lax and Secure outside dev mode.
- **Sign-in with a provider (optional, [decision 0021](decisions/0021-sign-in-providers.md)):** OpenID Connect code flow with PKCE run by the server; the state is single use and bound to the browser by a cookie, the id_token's issuer, audience, expiry and nonce are checked, and only `openid email` is requested. A person is the provider's subject, never their email. Admission by a verified Workspace domain (`hd`) or an invite; a member from before sign-in reaches nothing until they link an account, and an account already linked to someone else is refused. Codes, tokens and addresses are never logged; the activity log records sign-ins, links and joins with the provider name only. In-progress sign-ins are bounded in memory. A desktop app signs in through the person's own browser, never in its window: the browser gets only the hash of a secret the app keeps, stays signed out, and the app trades the secret for the session (kept for 5 minutes after the provider's answer, used once, at most 256 waiting). The development provider (`fake-oidc`) signs anybody in and is refused in production. (Go tests through the whole flow, browser scenario `auth`; the real Google service is **not verified** by automated tests.)
- **Input validation:** WebSocket frames are size- and rate-limited; avatars are re-serialised from validated fields; names are bounded; maps are validated and compiled before being accepted; request bodies are size-limited.
- **Production guard rails:** `HQ_ENV=production` refuses to start without a real LiveKit key and a secret of at least 32 characters, a `wss://` media URL and an explicit allowed-origins list. Verified with the built container image.
- **Logs:** structured JSON. Chat text, tokens and secrets are not logged (invite creation logs who and how many uses, never the token). Abnormal disconnects are logged at `WARN` with a user id, the office, a reason and a duration, never a name, content or an address: a WebSocket that drops without a normal close (`websocket dropped`), a session the server closes for invalid messages or the rate limit, a client too slow for its queue, each participant the media reconciler removes from an SFU room, and problems a browser reports once reconnected (`client reported a problem`: an unexpected media drop with LiveKit's reason code, a failed media join, or a lost WebSocket with its close code and time offline; allow-listed kinds and bounded numbers, at most 20 per session). Normal leaves are not logged: walking away, leaving a room, changing status, closing the page, a second tab, or an administrator's removal (that one is in the activity log).
- **Interactive objects:** note/site/image content is validated at map save (notes bounded, only absolute https URLs without credentials) and stripped from the public map; it is sent only to a player standing next to the object and allowed in its area. Embedded sites and images load only after an explicit click, in a sandboxed iframe or referrerless image.
- **Lockable rooms:** locks are in-memory door state; movement refuses outsiders, administrators included (admitted visitors pass; an administrator can force the door on purpose, which the people inside are told about and the audit log records, see [decision 0019](decisions/0019-room-calls-from-two-and-desk-rooms.md)), so a locked call cannot be joined from outside and media isolation follows automatically. Knocks reach only people inside and expire.
- **Spotlight:** one extra SFU room with a single speaker; the audience gets subscribe-only tokens scoped to that room, revoked on step-off or consent withdrawal; the room is covered by the reconciler.
- **Whiteboards:** strokes are bounded and relayed to viewers only; deletes require stroke ownership (admins may delete any), clearing requires admin; boards persist per office in SQLite.

## What is stored

| Data | Where | Retention |
| --- | --- | --- |
| Names, avatars, roles, last position | SQLite | until the database is deleted |
| Sessions and invites | SQLite, **hashed** | until expiry (an admin can revoke an invite or remove a member, which deletes their sessions) |
| Sign-in identity: provider, provider subject, email address (only with `HQ_AUTH_PROVIDERS`) | SQLite; the address is shown to administrators in the member list | until the member is removed |
| Admin audit log (actor, action, target name, short detail; no message content) | SQLite | last 2,000 entries per office |
| **Office chat** | SQLite | last 500 messages per office; 100 replayed on connect |
| Direct and conversation chat | memory only, never stored | gone when delivered |
| Audio, video, screen share | not recorded; only flows through the SFU | none |

## Not implemented or not verified

- **TURN and ICE** behaviour behind restrictive firewalls and NATs. TURN over TLS on port 443 is not configured. Documented in [deploy/README.md](../deploy/README.md), not tested.
- **Up to one reconcile interval (10 s) of exposure** remains for a replayed, unexpired token.
- **Abuse handling is minimal:** administrators can remove a member (their sessions die and their socket closes at once) and revoke invites, but there is no ban list (a removed person can rejoin with any valid invite), no temporary mute or kick, no reporting flow and no content moderation. Office chat lines of a removed member stay in the last 500 messages until pruned.
- **The audit log is administrative only** (joins by invite, role changes, removals, invite creation and revocation, map edits). It stores who did what and when, never message content, and keeps the last 2,000 entries per office. It is not tamper-proof: anyone with database access can edit it.
- **`/metrics`** requires a bearer token (`HQ_METRICS_TOKEN`, at least 16 characters) when one is set, is open in dev without one, and is **disabled (404) in production without one**. The Caddyfile also hides it from the public hostname; keep both.
- **No independent security review.** Do not run this as a multi-tenant or public service.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository instead of a public issue.
