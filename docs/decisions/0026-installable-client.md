# 0026: The client is an installable web app, without a service worker

Date: 2026-10-19. Status: accepted.

## Context

People want Home Quarters in its own window, with its own icon, rather than as one tab among many. A desktop shell (Electron, Tauri, Wails) does that, but it ships a browser or depends on the system's, has to be signed to install without warnings, and needs its own updates. Chrome and Edge can already install a web page as an app when it has a manifest, served over HTTPS or from localhost.

## Decision

- **A web app manifest** (`web/public/manifest.webmanifest`): Home Quarters, standalone, start and scope `/`, 192 and 512 px icons, a maskable one, and an Apple touch icon. The icons are drawn from the HQ favicon by `e2e/export-icons.mjs` and committed.
- **No service worker.** Chrome no longer needs one to offer installation, and the client is useless offline (everything goes through the server). A worker that cached the client would also undo what the server does for deploys: the page and every unhashed file are revalidated on each load, so the next load runs the new client.
- The server serves `.webmanifest` files as `application/manifest+json` (Go's mime table does not know them), revalidated like the page; a missing file under `/icons/` is a 404, as under `/assets/`, instead of the page.

## Alternatives

- **A service worker with an offline page.** Shows "you are offline" instead of the browser's error; not worth a second cache with its own update rules today.
- **Only a desktop shell.** Covers what a page cannot (tray, global push-to-talk, start at login), at the cost above; it can still come later and reuse the icons.

## Impact

- Performance: none on the running client; the manifest and icons (about 20 KB) are fetched by the browser when it checks installability, revalidated with a 304 afterwards.
- Maintenance: rerun `e2e/export-icons.mjs` after changing the favicon. The `update` scenario reads Chrome's own installability verdict, so a broken manifest or icon fails the suite.
- Installation: nothing for operators beyond HTTPS, which production already requires.
