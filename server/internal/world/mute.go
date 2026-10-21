package world

// Remote mute. Anybody in a call can turn off another participant's microphone, camera or screen share
// (somebody forgot their camera, or their noise covers the person presenting). Never on: the person turns
// it back on themselves. The server checks that both share the call, asks the SFU to mute the tracks (so
// it holds even against a client that ignores it) and tells the person who did it; nobody else is told.
// The spotlight counts as a call too: its audience may turn off the speaker's tracks.

// muteKind reports whether k names something that can be turned off.
func muteKind(k string) bool { return k == "mic" || k == "cam" || k == "scr" }

func (w *World) doMute(p *Player, id uint32, kind string) {
	if !muteKind(kind) {
		return
	}
	q := w.players[id]
	if q == nil || q == p || q.out == nil {
		return
	}
	room := w.sharedRoom(p, q)
	if room == "" {
		return
	}
	if w.media != nil {
		w.media.Mute(room, w.identity(q), kind)
	}
	w.sendJSON(q, map[string]any{"t": "muted", "by": p.ID, "n": p.Name, "k": kind})
}

// sharedRoom is the SFU room where p hears q publish, or "" when they share no call: the same live
// group, or p in the spotlight audience of q.
func (w *World) sharedRoom(p, q *Player) string {
	if g := p.group; g != nil && g == q.group && g.live() {
		return g.room
	}
	if sp := w.spot.speaker; sp != nil && q == sp {
		if _, listening := w.spot.aud[p.ID]; listening {
			return w.spotRoom()
		}
	}
	return ""
}
