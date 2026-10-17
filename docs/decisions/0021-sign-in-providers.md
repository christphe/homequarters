# 0021: Sign in with a provider (Google), admission by domain or invite

Date: 2026-10-17. Status: accepted.

## Context

The session cookie was the account. A member who lost the cookie (another browser, cleared data, 30 days without coming back) lost their account; moving to a second machine meant a personal link, a bearer URL that is a password in plain sight; and nothing recovered an account. Good enough for a demo, not for an office people use every day.

An organisation that already has Google Workspace wants its people to come in with that account, and only them, while still letting an outside guest in now and then.

## Decision

- **`TILEWORK_AUTH_PROVIDERS` says how people sign in.** `none` (the default) keeps everything as it was: an invite in production, an open join in dev, the cookie is the account. Otherwise it lists providers in the order the join screen shows them: `google` and `fake-oidc` for now (`email` is reserved and refused until it exists). `none` combined with a provider, an unknown name, a duplicate, the public demo with a provider, domains without a provider, Google without its client id, secret or public URL, `fake-oidc` in production and Google over plain http in production all stop the server at start.
- **With a provider, signing in is mandatory, even in dev.** `POST /api/join` only completes a sign-in. Only `openid email` is asked for: the name and avatar are still chosen in Tilework, and nothing else is read from the account.
- **OpenID Connect, authorization code with PKCE, on the server.** `GET /auth/{p}/start` puts the flow (state, verifier, nonce, invite) in a cookie of its own (one per sign-in, so two tabs do not collide), signed with an HMAC key drawn when the server starts, valid 10 minutes; `GET /auth/{p}/callback` checks that cookie against the returned state, clears it, exchanges the code and checks the id_token's issuer, audience, expiry and nonce. The id_token comes straight from the provider's token endpoint over TLS, so its signature is not verified (OpenID Connect Core 3.1.3.7); that keeps a JWT and key-rotation library out of the build. A person is their provider's `sub`, never their email, which can change hands (`identities` table, one identity per provider and user).
- **Admission is a verified address in an authorised domain, or an invite.** `TILEWORK_AUTH_DOMAINS` admits Workspace accounts of those domains (Google's `hd` claim, so a personal Google account with an @acme.com address is not a member of Acme). An invite admits anybody else and is only spent when the member is created. The domain is checked at admission only; afterwards the identity is the account. Without an invite, a production sign-up is a member: the first administrator still comes from `tilework -invite admin` (in dev, as before, the first member is admin).
- **Removing a member is not a ban.** The identity is dropped with the membership: signing in again is a fresh admission, which the domain grants (a new member, not the old account) and which an outsider needs a new invite for.
- **Members from before sign-in keep their account.** While a provider is on, a session without an identity reaches no office API; `/api/me` reports it and the join screen asks the person, by name, to connect an account. That sign-in attaches the identity to the same user, whatever its domain (they are already a member). An identity that belongs to another member is refused.
- **Personal links are retired step by step.** While a provider is on, none is minted from the settings, and a linked member's link (and `tilework -account-link` for them) is refused; an unlinked member's link still opens their session, which then has to link. Without a provider nothing changes.
- **`fake-oidc` for development and tests.** The server itself plays the provider: a consent page with one Authorize button, a code, a back-channel exchange with PKCE and an (unsigned) id_token, through the same client code as Google. It remembers the browser in its own cookie, so the same browser is the same person and a private window is a new one; `login_hint` forces an address. `scripts/dev.sh --auth=fake-oidc` turns it on (domain `dev.local`), `--auth=google` uses a real Google client from the environment.

## Alternatives

- **Verify the id_token signature against Google's keys:** needed when a token arrives through the browser; here it never does. It would add key fetching and rotation for no gain.
- **Keep flows in a server table:** the first version did, bounded to 10,000; review showed one client could keep it full and lock everybody out of signing in. Signed cookies keep nothing on the server. The key is per process, so a restart during a sign-in costs one more click.
- **Merge accounts by email across providers:** convenient, and the one mistake that hands somebody else's account over. Linking is explicit.
- **A ban list on removal:** not wanted; removal stays a reset.

## Impact

- Performance: none on the world. A sign-in is two HTTP round trips and one call to the provider. Flows and new identities waiting for their name live in signed cookies, not in server memory; only the development provider keeps codes (1,000, 1 min).
- Known limit: the sign-in routes share the per-address join rate limit (`TILEWORK_JOIN_RATE`). Behind the bundled Caddy every request comes from the proxy's address, so that limit is shared by everybody, as it already was for joins.
- The flow cookie is signed, not encrypted: the browser that started a sign-in can read its own PKCE verifier and nonce, which gives it nothing it could not do anyway. Each abandoned sign-in leaves one such cookie (about 400 bytes, on `/auth/` only) for 10 minutes.
- "Not <name>?" only makes the browser forget the session; the session stays valid, since for a member from before sign-in it may be the only way back in. Without a provider there is no sign-out: the cookie is the account.
- Language: the policy page (`/privacy`) and the development consent page are rendered by the server in English, outside the client's dictionary (English is the only shipped locale).
- A member from before sign-in links whatever account they sign in with; on a shared browser the link screen offers "Not <name>?", which signs that browser out first. Linking ends on a confirmation in the office.
- Maintenance: `internal/auth` is the only package that speaks to a provider; `httpapi` decides admission. Go tests drive the whole flow through `fake-oidc` (domain, invite, refusal, return, linking, removal, forged and replayed states, logs), and the `auth` browser scenario does it through the real screens.
- Installation: optional. Google needs an OAuth client (type Web, user type External so invited guests can sign in), its callback `https://<office>/auth/google/callback` registered, and `TILEWORK_GOOGLE_CLIENT_ID`, `TILEWORK_GOOGLE_CLIENT_SECRET`, `TILEWORK_PUBLIC_URL` set. No Workspace administrator rights are needed: the domain is checked by this server.
- Not verified: signing in with the real Google service; it cannot run in the automated suite.
