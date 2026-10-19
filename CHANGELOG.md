# Changelog

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
