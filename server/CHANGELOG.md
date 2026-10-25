# Changelog

## [Unreleased] - minor

### Added
- Old Maid and Last Card, two card games for the Cards table, each a bundled plugin of its own; card games are plugins that register with Cards and can only narrow its actions or add a deck, piles and a count (#38)
- Cards: a bundled plugin with a card deck to place on a table; its card table opens full screen, and anybody can sit down to deal, shuffle, put cards anywhere on the felt (snapping to a grid and into cascades, for a solitaire) or on piles, move a stack or a pile by its handle, turn a pile over, give a card, offer their hand for a pick, look through a pile, or set cards aside one by one or a whole rank at a time (a 32- or 52-card game); every action is written in the table's log (#38)
- A PC object stands on desks (the map format's pc, with a small visual offset, dx and dy); the layouts put one on every desk, and maps saved before keep their desks' built-in screens (#37)
- Chess: a bundled plugin with a chessboard to place on a table; take the White or Black seat, anybody else with the window open watches, and each board keeps its game (#36)
- Plugins can put objects on the map that X opens (placed by administrators in the map editor, hidden while the plugin is off), draw them, react to them being added or removed, show a view of their own in their window and pin a sprite above a member's head (#36)
- Administrators can switch the office to a ready-made layout from Admin > Office: Loft (today's starter office), Lodge (36 desks) or Manor (48 desks in islands of back-to-back desks, meeting rooms, mini meeting rooms, a break room whose duo and couch corners each have their own call, an arena); the whole map is replaced, desk assignments carry over by desk number and everybody online reconnects into the new office at its entrance (#35)

### Changed
- A plugin's view can draw the images other running plugins put in their shared folder (#38)
- A plugin's window can take the whole screen, with a view that fills it (#38)
- People behind a desk are hidden by the desk and its screen instead of being drawn over them (#37)
- Couches no longer block the way: people sit on them as on chairs (#35)
- The office looks more lived in: desks have legs, a monitor, a keyboard and a mouse, chairs that face away are seen from behind, armchairs beside a table face it, tables have legs (low ones among couches), and a doorway carries each room's floor up to a thin sill instead of a doormat (#35)
- Maps hold up to 128 areas instead of 64, and the map format has new furniture (armchair, stands, stairs, an arena field, a banner, a scoreboard) and desks turned around (`up`) for back-to-back islands (#35)

## [0.4.0] - 2026-10-22

### Added
- Anybody in a call can turn off another person's microphone, camera or screen share from their video tile's menu, never turn them on, and the person is told who did it (#32)

### Changed
- The camera turns itself off 15 seconds after a conversation ends, and the microphone too if you choose so in the audio and video settings; the next conversation starts as you left the media bar's buttons, replacing the "join with the microphone/camera on" choices (#31)

### Fixed
- The server image no longer trusts the root certificates that Debian distrusted after the eMudhra intermediate CA key compromise: it is now built on distroless Debian 13, whose CA bundle has the fix (#34)
- A chosen microphone, camera or speaker that is not there any more (unplugged, switched off, a remote desktop session) gives way to the default one with a message, instead of a call playing on a speaker that fails or the device dialog saying "No device found"; the choice is kept for when the device is back (#33)

## [0.3.2] - 2026-10-20

### Fixed
- In the desktop app, texts speak of the app and its window rather than of a browser tab, and screen-sharing advice names the app (#27)
- A follower keeps the pace of the person it follows: it runs when they run (a double-click on the map, Shift) instead of falling behind (#28)

## [0.3.1] - 2026-10-20

### Security
- A second browser or the desktop app signed in to the same account no longer joins the other one's call without its own consent (#26)

## [0.3.0] - 2026-10-20

### Added
- Plugins hear when another plugin starts or stops (the onPlugins export) and can ask whether one runs (hq.plugins.running) (#24)
- Desktop apps sign in through the person's own browser, never in their window, and receive the session from it (#23)
- Install Home Quarters as an app from Chrome or Edge: it opens in its own window, with its own icon, and still updates with the server (#21)

### Fixed
- A wandering pet that picks a spot it cannot reach (off the map, in a wall) walks as close as it can instead of standing still for up to a minute; plugins' hq.walkTo does the same (#24)
- Turning off (or a crash of) a plugin that put guest pets with members takes those pets away and gives their places back; once it runs again it puts them again, without anybody reloading (#24)
- Removing a member no longer fails with a server error when a map save from the editor lands at the same moment (#24)
- Guided walks (double-click, Walk to, Follow, the minimap) go around meeting rooms, offices and desks instead of cutting through someone else's call; they cross a room only when it is the only way (#20)

## [0.2.0] - 2026-10-19

### Changed
- A desk or office still held by a member removed earlier becomes free on the next start, and a map saved from the editor no longer gives a place to somebody who is not a member (#18)

### Fixed
- Removing a member frees their desk and their place in a private office, and a member's new name shows on their desk and office for everybody at once; maps saved by earlier versions are cleaned on the next start (#18)
- Walk-to (double-click on the map, Walk to, Ctrl/Cmd+D, the minimap): your avatar runs smoothly instead of hopping at the server's 15 Hz, and its pets run after it with their walk animation (#19)

## [0.1.0] - 2026-10-19

### Added
- Sign in with Google (optional, `HQ_AUTH_PROVIDERS=google`): Workspace accounts of `HQ_AUTH_DOMAINS` enter on their own, anybody else needs an invite; only the email is asked for, name and avatar are still chosen in the office (#4)
- A privacy page (`/privacy`) generated from the configuration (`HQ_OPERATOR`, `HQ_CONTACT`) and a public about page (`/about`) saying what the office is, who runs it, the AGPL source offer (`HQ_SOURCE_URL`) and the running version (#4, #5, #8)
- Sign out from the settings when the office signs in with a provider (#4)
- Personal links: a member can open their own account on a second machine, which ends their other sessions; operators mint one with `-account-link "<name>"` (#1)
- Plugins: operator-installed TypeScript plugins in `HQ_PLUGINS_DIR` (`bundled/` and `installed/`), turned on per office by administrators, with settings, hooks between plugins, sprites, buttons and modals drawn from a sandboxed iframe, app tokens for desktop apps, and declared external hosts enforced by a Content Security Policy (#9, #11, #14)
- Members with no place can take a free desk next to them, and give it back
- Desk owners can lock their desk; a locked desk shows a lock to others and only its owner (or an admin) answers knocks
- Administrators can rename the office from Administration > Office; the name is stored, so `HQ_OFFICE_NAME` only names a new office
- Administrators can knock on a closed door, or "Enter anyway (admin)", which tells the people inside and is recorded in the activity log
- Zoom the map with Ctrl+wheel (Cmd+wheel on a Mac, or a trackpad pinch), one level per notch, further out than before (`HQ_AOI_MAX_CELLS`, 8 by default)
- Drag the map with the mouse to look around
- Ctrl+D (Cmd+D) runs back to your desk or office; Ctrl+U (Cmd+U) toggles busy; the shortcuts help is grouped and written the macOS way on a Mac
- Avatars: beards, headwear (caps, hats, headphones, a hijab and more), six more hair styles, larger palettes and any custom colour
- Away when the whole computer is idle or locked (Idle Detection, Chrome and Edge), as an opt-in setting
- A short chime when a conversation opens, someone joins or leaves, so an open microphone is never a surprise
- Enhanced noise suppression for the microphone (GTCRN, RNNoise or Speex), off by default, with a recording test
- Change the microphone, camera and speaker from the settings at any time
- A page from an older deploy asks to reload; `HQ_VERSION` names the deploy (the published image sets it to the commit)
- Abnormal disconnects (network loss, timeouts, rate limits, media drops) are logged at WARN, without names or content

### Changed
- Pets are calmer: a step about every 20 seconds near their owner or at home, a long walk about once a minute when exploring (#17)
- **Upgrade:** the project is now Home Quarters. Configuration is read from `HQ_*` variables only (every `TILEWORK_*` name is ignored and falls back to its default), the image is `ghcr.io/christphe/homequarters` and Prometheus metrics are named `hq_*`. Follow "Upgrading to Home Quarters" in the self-hosting guide to keep your volumes and database; session cookies and browser preferences carry over on their own (#8)
- **Upgrade:** an installation that does not use the provided Compose file (binary, systemd, `docker run`) must set `HQ_ENV=production` itself, or it starts in development mode (#8)
- Pets now come from the bundled `hq-pets` plugin: several named, coloured pets per member with moods and a per-office limit, plus guest pets drawn by other plugins; the built-in pet is gone (#9, #14)
- Keyboard shortcuts follow key positions, so W A S D is Z Q S D on AZERTY and the digit row sends reactions without Shift
- A room call starts only when a second person comes in; each assigned desk becomes a small room with its own call
- Locked rooms, assigned offices and locked desks now stop administrators like anybody else
- A person has at most one desk or private office: assigning another frees the previous one, and the server refuses a map that gives someone two places
- "Walk to" a person ends on their tile, inside their room, or at the door when it is closed to you
- Busy and away grey out the map under a card with a button to become available again
- Busy and away people can be waved at, at most once every 30 seconds per sender
- The appearance is edited in its own dialog; the people panel keeps Walk to, Wave and Message on the row and the rest in a menu
- New pixel font (Jersey 10), a simpler top bar, and the reaction bar in the top bar on wide screens

### Fixed
- Wandering pets stand in the same place on every page, including pages opened later (#17)
- Everybody's position is kept across a server restart instead of going back to the spawn
- People no longer go away, and drop out, while in a call or a presentation (#2)
- Browsers pick up a new deploy: the page is no longer cached
- A stereo microphone is mixed to mono instead of sending only its left channel
- A map change no longer ends room calls that it did not touch
- Pets keep their distance when their owner stops, and follow walkers on 120 Hz displays (#13)
- Knock and Enter anyway are shown only when the server really keeps you out
- Toasts show above dialogs and no longer block the controls under them
