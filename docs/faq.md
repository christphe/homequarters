# FAQ

Short answers to the questions people ask first. Most answers link to the page with the details and the evidence behind them.

## What is Home Quarters?

An open source, self-hosted 2D virtual office. Your team walks pixel-art avatars around a shared map and audio and video start when people get close, like bumping into someone in a hallway. It also has meeting rooms with access rules, private offices, screen sharing, chat, whiteboards, invites and a map editor. See the [overview](overview.md).

## Is Home Quarters an open source alternative to Gather?

It is an independent project inspired by the classic Gather (gather.town) experience: a 2D map with proximity video. It is not affiliated with or endorsed by Gather, and it uses none of its code, maps, sprites or branding. Sprites, tiles and the map are drawn by the project's own code, the code is AGPL-3.0, and every third-party dependency is listed in [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md). If you want a virtual office you can host and inspect yourself, that is exactly the use case.

## Is it free?

Yes. The code is AGPL-3.0 and running it needs no paid service: one Go binary, SQLite and a self-hosted [LiveKit](https://livekit.io) media server. You only pay for the machine you run it on. The public demo runs on an Oracle Cloud Always Free VM with 1 GB of RAM.

## How do I try it on my machine?

Run the local Docker stack: clone the repository, run `docker compose -f deploy/docker-compose.local.yml up --build` and open http://localhost:8080. The first person to join becomes the administrator. To try proximity video alone, open it in two browser profiles and walk the avatars toward each other.

## How do I self-host it?

Use the Docker image `ghcr.io/christphe/homequarters` (linux/amd64 and linux/arm64) with the production Docker Compose file, which adds Caddy for automatic HTTPS and LiveKit for media. You need two DNS names, a few open ports and an invite for the first administrator. The [self-hosting guide](../deploy/README.md) walks through it, including a trick for trying it without owning a domain.

## How many people can one server handle?

We do not claim a number yet. On the free Oracle micro VM that hosts the demo (1 GB of RAM), one run loaded over the internet from another machine kept 100 bots smooth, ran 200 with slower worst cases and saturated at 500 (all of them joined, nobody was kicked). For media, one 4-person video call and 20 people in audio-only groups were clean, while larger media runs lost packets, most likely because of the VM's capped CPU; the generator side was not measured. These are single runs on the smallest free machine, not capacity figures. Local benchmarks with the generator on the same laptop reached 1,000 bots without media and 40 people in calls. Details: [Benchmark results](benchmark-results.md) and [Status](status.md).

## What keeps it light?

The server compares each person only with people nearby (a spatial grid and areas of interest), sends small batched updates at 10-15 Hz and sends movement as state changes instead of a position stream. The browser bakes the map into one texture, draws only what the camera sees and stops rendering hidden tabs. Media goes through an SFU in small rooms. See [Architecture](architecture.md) and [Efficiency and benchmarks](efficiency-and-benchmarks.md).

## Is audio or video recorded?

No. Audio, video and screen shares only flow through the media server and are never recorded. Direct and conversation chat messages live in memory only; the office chat keeps its last 500 messages. Camera and microphone stay off until you opt in, and busy, away or invisible people are never pulled into a call. See [Privacy and security](privacy-and-security.md).

## Do I need a domain and HTTPS?

Browsers only allow the camera and microphone on HTTPS pages or on localhost, so a public install needs HTTPS. The production Compose file gets certificates automatically through Caddy. For a first try, a wildcard-IP DNS name such as sslip.io works; use your own domain for anything that matters.

## Which browsers and devices does it support?

The automated suite runs in Google Chrome, including an emulated phone with an on-screen movement pad. Other browsers and real phones are not covered by the tests yet, so reports are welcome.

## Can I install it as an app?

Yes, in Chrome and Edge, when the office is served over HTTPS (or from localhost), as for the camera: the install button in the address bar, or the install entry in the browser menu, puts it in its own window, with its own icon in the taskbar or the dock. It is the same web client, so it updates with the server and needs nothing else on the computer.

## Is there a desktop app?

For Windows and macOS, yes: the office in its own window, a list of offices to switch between, and a tray icon (the Dock on a Mac) that keeps you reachable with the window closed. It uses the system's own web view, so it stays small and its engine is patched with the system. On Linux, use the browser. See [Desktop app](desktop.md).

## Can I change the office map?

Yes. Administrators paint walls, place objects, draw meeting rooms with access rules (open, members, admins or a list) and assign desks and private offices from the built-in editor. Changes go live for everyone and persist. A member who has no desk yet can also take a free one: a "Take this desk" button appears next to it, and "Release desk" gives it back.

## Is it ready for production?

It is alpha software. The whole loop is tested in real browsers and runs on a public host, but TURN through UDP-blocked networks, long soaks and an independent security review have not been done. Read [Status](status.md) before relying on it.

## Will there be a hosted version?

It is planned: a dedicated instance per customer, kept updated and backed up, in Team, Business and Enterprise plans with a number of seats each. The code stays AGPL-3.0 with every feature, so self-hosting remains free. Nothing is on sale yet; see the [Business model](business-model.md).

## How can I help?

Try the demo and open an issue with what broke or felt wrong, star the repository on [GitHub](https://github.com/christphe/homequarters) so others can find it, or contribute tests, measurements and fixes following [Contributing](contributing.md).
