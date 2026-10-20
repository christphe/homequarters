# 0027: A desktop app on the system web view, for Windows and macOS

Date: 2026-10-20. Status: accepted.

## Context

People asked for Home Quarters as a desktop app: its own window, a way to switch between offices, and a presence that stays with the window closed, as Discord or Slack have. The installable web app ([decision 0026](0026-installable-client.md)) covers the window and the icon, but not the tray, a list of offices, or signing in with a browser extension's password manager inside the window.

The client needs WebRTC (LiveKit), `getUserMedia`, `getDisplayMedia`, `setSinkId` and WebGL. What each engine offers was measured with `e2e/desktop/probe.mjs`, which runs the app on a page that reads the APIs and makes a WebRTC call inside itself:

- **Windows, WebView2 (Chromium)**: every API, and audio and video flowed.
- **macOS, WKWebView (Safari's WebKit)**: every API. The in-page call timed out on the hosted runner, which does not resolve WebKit's mDNS host names. Camera and microphone worked on a real Mac once the app was signed ad hoc.
- **Ubuntu 24.04 and Debian 13, WebKitGTK 2.48 to 2.54**: no `RTCPeerConnection`, even with `enable-webrtc` set, because the distributions build it without WebRTC. There is also no `setSinkId` and no `IdleDetector`. GNOME Web on Debian uses the same library.

## Decision

- **Tauri 2**, a Rust shell around the system's web view (`desktop/`), for **Windows and macOS**. The office is a remote page with no access to the shell: Tauri refuses IPC from remote origins. Camera, microphone and screen go to office pages only, and links for a new tab open in the default browser.
- **Linux uses the browser**, installed as an app if wanted. The Linux build still exists, and its probe result is published, but it is not offered for calls.
- **Signing in happens in the person's browser**: the app hands the provider's page to it, then gets the session back through `/auth/{provider}/handoff/{secret}`. Google refuses embedded web views, and a password typed in the app's window would escape the browser's password manager.
- **Closing the window hides it** in the tray (the Dock on a Mac). It stops every capture and sets the person busy, because a window you cannot see must not keep a microphone open.

## Alternatives

- **Electron.** The same Chromium everywhere, Linux included, so calls would work there too. But it ships a browser engine in every install (about 150 MB on disk, and more memory), and every Chromium security fix becomes our release to build, sign and ship. With the system web view, Microsoft and Apple patch the engine.
- **WebKitGTK built with WebRTC and bundled** (in an AppImage, say). The same burden as Electron, on a less mature WebRTC backend, and reported to work only under X11.
- **A WebRTC shim for WebKitGTK** (`tauri-plugin-webrtc`, a Rust WebRTC stack behind a JavaScript `RTCPeerConnection`). Worth trying for Linux later. Its coverage of what LiveKit needs (simulcast, video, screen sharing) is not known, and it would be a WebRTC stack to keep up to date.
- **Only the installable web app.** It works now. It has no tray or office list, and on the PWA window a password manager's toolbar button is out of reach.

## Impact

- Performance: the release executable is about 3.4 MB on Windows. The window costs what an Edge or Safari tab costs, plus a small process for the shell.
- Maintenance:
  - Rust dependencies to keep current (Tauri and its plugins), and a CI workflow on three systems. macOS runners can wait a while for a machine.
  - The page and the shell share one contract, the `hq-desktop` window event (`web/src/desktopWindow.ts`).
  - The office's sign-in start address is recognised by the shell (`/auth/{provider}/start`).
- Installation:
  - Unsigned builds for now: SmartScreen warns on Windows, and macOS needs the quarantine attribute removed.
  - Signing needs a code-signing certificate for Windows and an Apple Developer ID with notarisation for macOS.
  - Servers need the sign-in handoff route to sign in from the app.
- Known limits:
  - The app does not check that an address really is a Home Quarters office.
  - A member from before sign-in providers links their account from a browser first.
