package world

import (
	"strings"
	"testing"
	"time"
)

func (h *harness) mutes() []string {
	h.fm.mu.Lock()
	defer h.fm.mu.Unlock()
	out := h.fm.muted
	h.fm.muted = nil
	return out
}

func mutedFrames(p *Player) []string {
	var out []string
	for _, f := range drain(p) {
		if strings.Contains(f, `"t":"muted"`) {
			out = append(out, f)
		}
	}
	return out
}

func TestMuteInSameConversation(t *testing.T) {
	cases := []struct {
		name   string
		ax, ay float64
		bx, by float64
		room   bool
	}{
		{"proximity", sx, sy, sx + 30, sy, false},
		{"meeting room", 50 * 16, 3 * 16, 54 * 16, 5 * 16, true}, // Aurora (open)
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			a := h.add(1, "member", c.ax, c.ay)
			b := h.add(2, "member", c.bx, c.by)
			a.Name, b.Name = "Alice", "Bruno"
			h.consent(a, true)
			h.consent(b, true)
			h.run(3 * time.Second)
			if a.group == nil || a.group != b.group || a.group.isRoom != c.room || !a.group.live() {
				t.Fatal("setup: both must share a live call")
			}
			drain(a)
			drain(b)
			for _, k := range []string{"mic", "cam", "scr"} {
				h.send(a, ev{kind: evMute, id: b.ID, s: k})
				got := h.mutes()
				if len(got) != 1 || got[0] != a.group.room+"/2/"+k {
					t.Fatalf("%s: the SFU must mute that kind of the target's tracks in the shared room: %v", k, got)
				}
				fs := mutedFrames(b)
				if len(fs) != 1 || fs[0] != `{"by":1,"k":"`+k+`","n":"Alice","t":"muted"}` {
					t.Fatalf("%s: the target is told who turned it off: %v", k, fs)
				}
				if len(mutedFrames(a)) != 0 {
					t.Fatal("the author gets no frame")
				}
			}
		})
	}
}

func TestMuteOthersAreNotTold(t *testing.T) {
	h := newHarness(t)
	a := h.add(1, "member", sx, sy)
	b := h.add(2, "member", sx+30, sy)
	c := h.add(3, "member", sx+15, sy+20)
	for _, p := range []*Player{a, b, c} {
		h.consent(p, true)
	}
	h.run(3 * time.Second)
	if a.group == nil || a.group != b.group || a.group != c.group {
		t.Fatal("setup: a group of three")
	}
	drain(c)
	h.send(a, ev{kind: evMute, id: b.ID, s: "cam"})
	if len(mutedFrames(c)) != 0 {
		t.Fatal("other participants are not told")
	}
}

func TestMuteSpotlightSpeakerFromAudience(t *testing.T) {
	h := newHarness(t)
	speaker := h.add(1, "member", 34*16+8, 19*16+8) // on the pad
	listener := h.add(2, "member", sx, sy)
	quiet := h.add(3, "member", sx+200, sy) // no audio and video: no token, sees nothing
	h.consent(listener, true)
	h.consent(speaker, true)
	h.run(time.Second)
	if h.w.spot.speaker != speaker {
		t.Fatal("setup: the speaker should be on air")
	}
	drain(speaker)
	h.send(listener, ev{kind: evMute, id: speaker.ID, s: "mic"})
	if got := h.mutes(); len(got) != 1 || got[0] != h.w.spotRoom()+"/1/mic" {
		t.Fatalf("an audience member can turn off the speaker's microphone in the broadcast room: %v", got)
	}
	if fs := mutedFrames(speaker); len(fs) != 1 || !strings.Contains(fs[0], `"by":2`) {
		t.Fatalf("the speaker is told: %v", fs)
	}
	h.send(quiet, ev{kind: evMute, id: speaker.ID, s: "cam"})
	if got := h.mutes(); len(got) != 0 {
		t.Fatalf("somebody without a broadcast token is not in the audience: %v", got)
	}
	h.send(speaker, ev{kind: evMute, id: listener.ID, s: "mic"})
	if got := h.mutes(); len(got) != 0 || len(mutedFrames(listener)) != 0 {
		t.Fatalf("the audience publishes nothing in the broadcast: %v", got)
	}
}

func TestMuteRefusedOutsideTheConversation(t *testing.T) {
	h := newHarness(t)
	a := h.add(1, "member", sx, sy)
	b := h.add(2, "member", sx+30, sy)
	far := h.add(3, "member", 3*16, 3*16)
	lone := h.add(4, "member", 50*16, 3*16) // alone in Aurora: no call
	other1 := h.add(5, "member", sx+400, sy)
	other2 := h.add(6, "member", sx+430, sy)
	for _, p := range []*Player{a, b, far, lone, other1, other2} {
		h.consent(p, true)
	}
	h.run(3 * time.Second)
	if a.group == nil || a.group != b.group || other1.group == nil || other1.group == a.group || far.group != nil || lone.group == nil || lone.group.live() {
		t.Fatal("setup")
	}
	for _, p := range []*Player{a, b, far, lone, other1, other2} {
		drain(p)
	}
	tries := []struct {
		name string
		from *Player
		id   uint32
		k    string
	}{
		{"another group", a, other1.ID, "mic"},
		{"from another group", other1, b.ID, "mic"},
		{"nobody near", far, a.ID, "mic"},
		{"to somebody in no call", a, far.ID, "cam"},
		{"alone in a room", lone, a.ID, "mic"},
		{"self", a, a.ID, "mic"},
		{"unknown id", a, 999, "mic"},
		{"unknown kind", a, b.ID, "all"},
		{"empty kind", a, b.ID, ""},
		{"no unmute", a, b.ID, "unmute"},
	}
	for _, tr := range tries {
		h.send(tr.from, ev{kind: evMute, id: tr.id, s: tr.k})
		if got := h.mutes(); len(got) != 0 {
			t.Fatalf("%s: no SFU call expected, got %v", tr.name, got)
		}
		for _, p := range []*Player{a, b, far, lone, other1, other2} {
			if fs := mutedFrames(p); len(fs) != 0 {
				t.Fatalf("%s: nobody is told, got %v", tr.name, fs)
			}
		}
	}
}
