package world

import (
	"fmt"
	"strings"
	"testing"
)

type presenceLog []string

func (h *harness) watchPresence() *presenceLog {
	var l presenceLog
	h.w.OnPresence = func(office int64, id uint32, name, role string, online bool) {
		l = append(l, fmt.Sprintf("%d:%v", id, online))
	}
	return &l
}

func TestPresenceReportsVisibleMembersOnly(t *testing.T) {
	h := newHarness(t)
	log := h.watchPresence()
	a := h.add(1, "member", sx, sy)
	h.add(1, "member", sx, sy) // reattach (second tab): reported again (a new name or role), plugins call no onJoin
	b := h.add(2, "member", sx+40, sy)
	h.send(b, ev{kind: evStatus, s: StatusInvisible})
	h.send(b, ev{kind: evStatus, s: StatusBusy})
	h.send(b, ev{kind: evStatus, s: StatusAway}) // visible to visible: nothing
	h.send(a, ev{kind: evStatus, s: StatusInvisible})
	h.w.evictPlayer(a) // already reported offline when it went invisible
	h.w.evictPlayer(b)
	if got := strings.Join(*log, " "); got != "1:true 1:true 2:true 2:false 2:true 1:false 2:false" {
		t.Fatalf("presence: %s", got)
	}
}

func TestPluginFrameReachesVisibleOpenSockets(t *testing.T) {
	h := newHarness(t)
	a := h.add(1, "member", sx, sy)
	b := h.add(2, "member", sx+40, sy)
	c := h.add(3, "member", 3*16, 3*16)
	h.send(c, ev{kind: evStatus, s: StatusInvisible})
	drain(a)
	drain(b)
	drain(c)
	f := []byte(`{"t":"plg","pl":"p","d":1}`)
	h.w.handle(ev{kind: evPlugin, id: 0, data: f}, h.now)
	h.w.handle(ev{kind: evPlugin, id: 2, data: []byte(`{"t":"plg","pl":"p","d":2}`)}, h.now)
	if fa, fb, fc := frames(a), frames(b), frames(c); fa != string(f) || !strings.Contains(fb, `"d":1`) || !strings.Contains(fb, `"d":2`) || fc != "" {
		t.Fatalf("a=%q b=%q c=%q", fa, fb, fc)
	}
}

func TestPluginFrameNeverKicks(t *testing.T) {
	h := newHarness(t)
	kicked := false
	a := h.add(1, "member", sx, sy)
	a.kick = func(KickReason) { kicked = true }
	drain(a)
	for len(a.out) < cap(a.out)/2 {
		a.out <- []byte("x")
	}
	h.w.handle(ev{kind: evPlugin, id: 1, data: []byte(`{"t":"plg"}`)}, h.now)
	h.w.handle(ev{kind: evPlugin, id: 0, data: []byte(`{"t":"plg"}`)}, h.now)
	if kicked || a.out == nil || len(a.out) != cap(a.out)/2 {
		t.Fatalf("kicked=%v queued=%d", kicked, len(a.out))
	}
	if h.w.St.PluginDropped.Load() != 2 {
		t.Fatalf("dropped %d", h.w.St.PluginDropped.Load())
	}
}

func TestPluginFrameDoesNotBlockWhenInboxFull(t *testing.T) {
	h := newHarness(t)
	for h.w.PluginFrame(0, []byte(`{}`)) {
	}
	if len(h.w.inbox) != cap(h.w.inbox) {
		t.Fatal("PluginFrame refused before the inbox was full")
	}
}

func TestPresenceCarriesNewNames(t *testing.T) {
	h := newHarness(t)
	var names []string
	h.w.OnPresence = func(office int64, id uint32, name, role string, online bool) {
		names = append(names, fmt.Sprintf("%s:%v", name, online))
	}
	a := h.add(1, "member", sx, sy)
	h.w.handle(ev{kind: evProfile, id: 1, info: UserInfo{Name: "Renamed"}}, h.now)
	h.send(a, ev{kind: evStatus, s: StatusInvisible})
	h.w.handle(ev{kind: evProfile, id: 1, info: UserInfo{Name: "Hidden"}}, h.now) // invisible: not announced
	if got := strings.Join(names, " "); got != "u:true Renamed:true Renamed:false" {
		t.Fatalf("presence: %s", got)
	}
}
