# Desktop app

Home Quarters runs in any recent browser, and Chrome or Edge can install it as an app ([FAQ](faq.md)). The desktop app goes a little further on Windows and macOS: the office in its own window, a list of offices to switch between, and a tray icon (the Dock on a Mac) that keeps you reachable with the window closed.

It is a small shell around the system's own web view: WebView2 on Windows, WKWebView (Safari's engine) on macOS. It contains no browser engine of its own, so the engine gets its security updates with the system, and the app is a few megabytes. Why this and not Electron: [decision 0027](decisions/0027-desktop-app.md).

## What it does

- **Offices.** The first start asks for the address of your office, the one you open in your browser. It must use HTTPS, except a server on the same computer. The Office menu lists the offices you have opened, with the open one checked, and lets you add one or manage the list. The window title names the open office.
- **Closing the window** hides it in the tray (the Dock on a Mac). Hiding stops your microphone, camera and screen sharing and sets you busy, so a forgotten window never keeps a conversation open. Showing it again makes you available, if the app was what set you busy, and turns nothing back on. Quit from the menu or with Ctrl+Q / Cmd+Q.
- **Signing in** with a provider (Google) happens in your own browser, with its password manager and security checks, never in the app's window. The app then receives the session. The server must be recent enough to offer this (`/auth/{provider}/handoff/...`, [WebSocket protocol](protocol.md)).
- **Notifications, away when idle and the keyboard layout on a Mac.** WKWebView has no `IdleDetector` and no Keyboard API, and refuses web notifications, so the app provides them to office pages: it reads how long the Mac has had no input and which keyboard layout is active, and it shows the office's notifications in the Notification Centre. The office's settings work as in Chrome, and help texts name the keys printed on your keyboard ("Z Q S D" on AZERTY). On Windows, WebView2 has all three.
- **The office knows it runs in the app.** The app sets `window.__HQ_DESKTOP__` (`{ os }`) before the page loads, and the web client then speaks of the window and the app where it would speak of a browser tab (`@app` texts in `web/src/i18n.ts`).
- **What the office page may do.** The office page can only ask the app to show a notification; anything else in the app is refused to it. Only office pages get the camera, microphone, screen, notifications and idle detection, and the office still asks for your consent first. Links meant for a new tab open in your default browser.

## Linux

Use the browser on Linux, installed as an app from Chrome or Edge if you want a window and an icon. The system web view there, WebKitGTK, is built without WebRTC by Debian 13 and Ubuntu 24.04, and by every distribution we found reports about. In it the office would show, but no call could connect. The desktop workflow measures this on Ubuntu at every change ([decision 0027](decisions/0027-desktop-app.md)).

## Installing a build

Each [release](https://github.com/christphe/homequarters/releases) carries the Windows installer (`Home Quarters_<version>_x64-setup.exe`) and the macOS disk image (`Home Quarters_<version>_aarch64.dmg`, Apple silicon). A pull request that touches `desktop/` builds them too, as artifacts of its Desktop workflow run. They are not signed yet:

- **Windows**: SmartScreen says it protected your PC. Choose "More info", then "Run anyway".
- **macOS**: the app is signed ad hoc only. After copying it to Applications, remove the quarantine attribute once:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/Home Quarters.app"
  ```

  macOS asks for the camera and the microphone the first time the office uses them. If it never asks, reset its earlier answer: `tccutil reset Camera app.homequarters.desktop` (and `Microphone`).

## Building it

Needs Rust and Node.js with pnpm, plus the system web view's development files on Linux.

```bash
cd desktop
pnpm install
pnpm tauri build                 # installer or .dmg in src-tauri/target/release/bundle
pnpm tauri build --no-bundle     # the executable alone
```

On Windows without Visual Studio's C++ build tools, the GNU toolchain works too (`rustup toolchain install stable-x86_64-pc-windows-gnu` with MinGW-w64, then `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu`).

Options: `--office=<url>` opens that office without saving it, and `--data-dir=<path>` keeps the offices, cookies and storage in another folder (another profile, or a test that runs beside your own app).

`node e2e/desktop/probe.mjs <app executable>` runs the app on a probe page. The page reports which web APIs the web view has and makes a WebRTC call inside itself. CI runs the probe on Windows, macOS and Ubuntu.
