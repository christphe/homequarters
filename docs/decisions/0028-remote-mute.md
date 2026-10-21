# 0028: Participants can turn off each other's microphone, camera and screen share

Date: 2026-10-21. Status: accepted.

## Context

People forget a camera on (somebody changed clothes in front of it) or a noisy microphone open while somebody else presents. The others in the call could only lower that person's volume for themselves. Home Quarters is used by colleagues of one company, not anonymous visitors.

## Decision

- **Anybody who shares a call with a person can turn off that person's microphone, camera or screen share.** Sharing a call means the same live proximity or meeting-room call, or holding an audience token for the spotlight that person speaks in (the audience can turn off the speaker; the audience publishes nothing in the broadcast, so the reverse does not apply).
- **Only off.** The protocol has a `mute` request and no unmute; the SFU call always sends `muted: true`. The person turns it back on themselves.
- **The server decides and the SFU enforces it.** The client sends `mute {id, k}`; the world checks the shared call and asks `internal/media` to mute. That package looks the participant up on LiveKit (`GetParticipant`) and calls `MutePublishedTrack` for each unmuted track of that source (the screen and its audio for a share). The client never names a track. The calls run on their own bounded queue and goroutine (256 requests, dropped and counted beyond that), so a flood of mutes never delays a revocation, and never block the world. A failed mute is counted (`hq_media_remote_mute_errors_total`) and not retried: the person may have turned the track back on in between, and a late retry would turn it off again.
- **The person's own browser releases the device.** The server sends them `muted {by, n, k}`. The client unpublishes and stops the microphone (a LiveKit mute leaves the microphone open), and turns the camera (whose mute stops the device) or the share off. It shows "Alice turned off your camera" with the wave chime and a system notification while the window is hidden, if they turned notifications on. Nobody else is told, and the person is told only when something was on: a repeated request about something already off makes no noise. What was turned off stays off if their media connection rejoins the same call; a new call starts from their own "join with the microphone (camera) on" preference.
- **No rate limit, audit row or opt-out**, by the product owner's choice: these are colleagues, the action is visible to its target with the author's name, and it only ever stops a capture. The connection's control-message limit still applies. An invisible person in the spotlight audience may do it too; the notification then names them.
- **UI:** a "⋯" button on each remote video tile, shown on hover or keyboard focus (always on touch screens), and a right click on the tile, open a menu that lists only what is on. Arrows move, Enter chooses, Escape returns focus to the button.

## Alternatives

- **Client-only mute** (a message the target's browser obeys): a modified client could ignore it. Rejected by invariant 5: isolation is enforced by the server and SFU.
- **Revoking the person's publish permission** (`UpdateParticipant` with `canPublish: false`): stops everything at once and needs a later re-grant to turn anything back on; muting the chosen source is what was asked.
- **Admin-only or rate-limited:** rejected by the product owner for now; the target sees who did it.

## Impact

- **Performance:** one event in the world loop and two or three small HTTP requests to LiveKit per mute, off the world goroutine. No per-frame or per-tick work.
- **Maintenance:** one more Twirp method pair in `internal/media`, still without the LiveKit SDK. LiveKit's JSON may write enums as names or numbers; both are accepted.
- **Install:** none. Remote unmute stays disabled in LiveKit by default, which is what we want.
