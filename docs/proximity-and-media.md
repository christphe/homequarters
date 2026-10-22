# Proximity and media

## Consent first

Nobody's camera or microphone is touched before they opt in. The **Enable audio and video** dialog previews camera and microphone, lets you choose devices (and the audio output where the browser supports it), and explains that media is only sent to people nearby or in the same room, and only while your status is *Available*.

A chosen microphone, camera or speaker that is not there now (unplugged, switched off, another computer, a remote desktop session with its own devices) gives way to the default one, with a message: in a call the choice is kept for when the device is back; in that dialog the preview shows the default and **Enable** or **Save** keeps it.

## Microphone and camera between conversations

The microphone and camera buttons of the media bar are remembered: the next conversation starts with them as you last set them, whether you set them in a call or between calls. Two settings in the same dialog (also under **Settings > Microphone, camera and speaker**) turn them off once a conversation ends, so a call started for one visitor does not open the next one with the camera on:

- **Turn the camera off when a conversation ends**, on by default;
- **Mute the microphone when a conversation ends**, off by default.

They apply to proximity conversations, meeting rooms and your own spotlight. They wait 15 seconds after the end: a new conversation within that time (somebody stepped away and back, a call that dropped and formed again) starts as the last one was. A reconnection of the same call is not an end. After 15 seconds the buttons show off and the next conversation starts without them; you turn them back on from the bar. Turning a button on or off yourself during those 15 seconds keeps your choice for that device. The pending turn-off is kept in the browser, so it still applies if the page is closed or reloaded meanwhile.

## Who can be in a conversation

A person is eligible only if **all** of these are true:

1. they gave consent;
2. their status is **Available** (busy, away and invisible never join automatically, and leave immediately if already in one);
3. their connection is live.

## How groups form

There are two kinds of group, each mapped to one small SFU room (see [decision 0003](0003-media-rooms.md)):

- **Proximity groups** form between free people outside meeting rooms, up to 8 people.
- **Meeting rooms** correspond to map areas with an explicit access rule: open, members only, admins only, a list, or a private office (open while unassigned; then its owners, admins and visitors an owner lets in). A room's call starts with two people: alone in a room you get no call and nothing is captured.
- **Assigned desks** are small rooms the server derives from the map: the desk and the two rows in front of it. Whoever comes over to a desk shares its call; the neighbouring desks do not hear it ([decision 0019](decisions/0019-room-calls-from-two-and-desk-rooms.md)). A member without a desk can take a free one with the button that appears next to it (and release it from inside its room); a map change (a desk taken, an editor save) keeps the calls of rooms that did not change ([decision 0020](decisions/0020-members-take-free-desks.md)).

| Rule | Default |
| --- | --- |
| Join a group: within 64 px of a member and 80 px of the centroid | held for 0.5 s |
| Leave a group: beyond 96 px of the nearest member or 112 px of the centroid | held for 1.5 s |
| Group size limit | 8 |
| Enter/leave a meeting room area | 0.4 s / 0.8 s |

Behaviours these rules produce, all covered by unit tests:

- **No flapping at the edge**: the leave threshold is farther than the join threshold, and both require a dwell time.
- **Standing between two conversations**: you stay in the one you are in; there is no direct hop, you must leave first.
- **Chains of avatars**: a long line of people cannot merge into one call, because of the centroid limit and the size cap.
- **Meeting rooms are isolated from the corridor**: someone standing outside the door is not pulled into the room's call.

## What the browser does

- Connects to the room named by the server with a scoped token.
- Publishes the microphone (and camera if enabled) with simulcast and DTX. Screen sharing is available inside a live conversation.
- **Audio is always subscribed; video is limited** to a configurable number of tiles, ranked so active speakers come first. Audio-only mode never subscribes to camera video.
- **Anybody in the call can turn off another person's microphone, camera or screen share** from the menu of that person's video tile (the "⋯" button or a right click). The server checks that both share the call, mutes the tracks on the SFU and tells the person who did it; their browser then stops that capture. Only off: each person turns their own devices back on. In a spotlight, the audience can do it to the speaker ([decision 0028](decisions/0028-remote-mute.md)).
- On leaving a conversation it disconnects and **stops all capture** (the microphone and camera are released).
- If the SFU connection drops unexpectedly, it asks the world server for a fresh token and rejoins.

## Setting up LiveKit for real use

For production, LiveKit needs:

- **HTTPS/WSS** in front of the signalling port (browsers require a secure context for camera and microphone);
- **ICE**: a UDP port range or a single UDP mux port, plus TCP fallback;
- **STUN/TURN**: TURN (ideally over TLS on 443) for users behind restrictive networks;
- **Credentials**: a non-default API key and a secret of at least 32 characters, shared only between LiveKit and the app server.

A complete, tested production configuration is **not written yet** (see [Status](status.md)). Follow the official LiveKit deployment documentation and re-verify against the version you deploy.
