package world

import (
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"tilework/internal/gamemap"
)

func deskAt(w *World, x, y int) *gamemap.Prop {
	for i := range w.m.Map.Props {
		if p := &w.m.Map.Props[i]; p.T == "desk" && p.X == x && p.Y == y {
			return p
		}
	}
	return nil
}

func assignDesk(t *testing.T, h *harness, x, y int, uid int64) {
	t.Helper()
	m := *h.w.m.Map
	m.Props = append([]gamemap.Prop(nil), m.Props...)
	for i := range m.Props {
		if p := &m.Props[i]; p.T == "desk" && p.X == x && p.Y == y {
			p.Assign = uid
		}
	}
	cm, err := gamemap.Compile(&m)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.w.doReloadMap(cm, h.now); err != nil {
		t.Fatal(err)
	}
}

func TestClaimAFreeDeskNextToIt(t *testing.T) {
	h := newHarness(t)
	p := h.add(1, "member", 20*16+8, 4*16+8) // on the chair of desk (20,3)
	other := h.add(2, "member", 2*16, 2*16)
	h.run(time.Second)
	drain(other)
	m, err := h.w.doClaimDesk(1, 20, 3, h.now)
	if err != nil {
		t.Fatal(err)
	}
	if d := deskAt(h.w, 20, 3); d == nil || d.Assign != 1 || d.Label != "u's desk" {
		t.Fatalf("the running world assigns the desk and names it after its owner, as the editor does: %+v", d)
	}
	if officeIndex(t, h.w, "desk-20-3") < 0 || p.area != officeIndex(t, h.w, "desk-20-3") {
		t.Fatalf("the claimer stands in their new desk room (area %d)", p.area)
	}
	var saved *gamemap.Prop
	for i := range m.Props {
		if m.Props[i].T == "desk" && m.Props[i].X == 20 && m.Props[i].Y == 3 {
			saved = &m.Props[i]
		}
	}
	if saved == nil || saved.Assign != 1 {
		t.Fatal("the returned map, which is persisted, carries the assignment")
	}
	if !strings.Contains(frames(other), `"t":"map"`) {
		t.Fatal("everybody receives the new map")
	}
}

func TestClaimDeskIsRefused(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, h *harness)
		uid   uint32
		x, y  int
		want  error
	}{
		{"not online", nil, 9, 20, 3, ErrClaimOffline},
		{"too far", nil, 2, 20, 3, ErrClaimFar},
		{"no desk there", nil, 1, 21, 3, ErrClaimNoDesk},
		{"taken", func(t *testing.T, h *harness) { assignDesk(t, h, 20, 3, 5) }, 1, 20, 3, ErrClaimTaken},
		{"already mine", func(t *testing.T, h *harness) { assignDesk(t, h, 20, 3, 1) }, 1, 20, 3, ErrClaimHasPlace},
		{"already has a desk", func(t *testing.T, h *harness) { assignDesk(t, h, 24, 3, 1) }, 1, 20, 3, ErrClaimHasPlace},
		{"owns an office", func(t *testing.T, h *harness) { assignOffice(t, h, "office-1", 1) }, 1, 20, 3, ErrClaimHasPlace},
		{"desk inside a room", nil, 3, 6, 41, ErrClaimRoom},
		// an assigned desk in the hall whose desk room reaches over a desk on the office's top row
		{"desk inside a room under a desk room", func(t *testing.T, h *harness) {
			m := *h.w.m.Map
			m.Props = append(append([]gamemap.Prop(nil), m.Props...),
				gamemap.Prop{T: "desk", X: 2, Y: 37, Assign: 5}, gamemap.Prop{T: "desk", X: 2, Y: 39})
			cm, err := gamemap.Compile(&m)
			if err != nil {
				t.Fatal(err)
			}
			if err := h.w.doReloadMap(cm, h.now); err != nil {
				t.Fatal(err)
			}
			if a := h.w.m.Map.Areas[h.w.m.AreaIndexAt(2, 39)]; !a.Auto {
				t.Fatalf("setup: the desk room must cover (2,39), got %q", a.ID)
			}
		}, 4, 2, 39, ErrClaimRoom},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			if c.setup != nil {
				c.setup(t, h)
			}
			h.add(1, "member", 20*16+8, 4*16+8)
			h.add(2, "member", 20*16+8, 7*16+8) // three rows away
			h.add(3, "member", 6*16+8, 42*16+8) // on the chair of office-1's desk
			h.add(4, "member", 3*16, 40*16+8)   // in office-1, under the desk at (2,39)
			before := deskAt(h.w, c.x, c.y)
			var was int64
			if before != nil {
				was = before.Assign
			}
			_, err := h.w.doClaimDesk(c.uid, c.x, c.y, h.now)
			if !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
			if d := deskAt(h.w, c.x, c.y); d != nil && d.Assign != was {
				t.Fatal("a refused claim changes nothing")
			}
		})
	}
}

// A map reload (a desk claimed, an admin edit) keeps the calls of rooms that did not change, even
// when their index moves.
func TestClaimingADeskKeepsRunningRoomCalls(t *testing.T) {
	h := newHarness(t)
	assignDesk(t, h, 24, 3, 5)
	a := h.add(1, "member", 50*16, 3*16) // Aurora
	b := h.add(2, "member", 54*16, 5*16)
	c := h.add(5, "member", 24*16+8, 4*16+8) // desk-24-3, owner and a visitor
	d := h.add(6, "member", 25*16+8, 5*16+8)
	claimer := h.add(7, "member", 20*16+8, 4*16+8)
	for _, p := range []*Player{a, b, c, d, claimer} {
		h.consent(p, true)
	}
	h.run(3 * time.Second)
	aurora, desk := a.group, c.group
	if aurora == nil || aurora != b.group || desk == nil || desk != d.group || !desk.isRoom {
		t.Fatal("setup: two live room calls")
	}
	before := officeIndex(t, h.w, "desk-24-3")
	h.send(c, ev{kind: evLock, b: true})
	if h.w.locks["desk-24-3"] == nil {
		t.Fatal("setup: the owner locks their desk")
	}
	for _, p := range []*Player{a, b, c, d} {
		drain(p)
	}
	if _, err := h.w.doClaimDesk(7, 20, 3, h.now); err != nil {
		t.Fatal(err)
	}
	after := officeIndex(t, h.w, "desk-24-3")
	if after == before {
		t.Fatal("setup: the new desk room must shift the index of desk-24-3")
	}
	if h.w.locks["desk-24-3"] == nil {
		t.Fatal("an occupied, locked desk stays locked when another desk is taken")
	}
	h.run(time.Second)
	for _, p := range []*Player{a, b, c, d} {
		if strings.Contains(frames(p), `"op":"leave"`) {
			t.Fatalf("player %d was dropped from their call", p.ID)
		}
	}
	if a.group != aurora || b.group != aurora || c.group != desk || d.group != desk || desk.area != after || h.w.roomGrp[after] != desk {
		t.Fatal("unchanged rooms keep their call, under their new index")
	}
}

func TestReleaseMyDesk(t *testing.T) {
	h := newHarness(t)
	assignDesk(t, h, 20, 3, 1)
	p := h.add(1, "member", 20*16+8, 4*16+8)
	other := h.add(2, "member", 2*16, 2*16)
	h.run(time.Second)
	h.send(p, ev{kind: evLock, b: true})
	drain(other)
	m, err := h.w.doReleaseDesk(1, 20, 3, h.now)
	if err != nil {
		t.Fatal(err)
	}
	if d := deskAt(h.w, 20, 3); d == nil || d.Assign != 0 || d.Label != "" {
		t.Fatalf("the running world frees the desk and drops its owner's name, as the editor does: %+v", d)
	}
	for _, a := range h.w.m.Map.Areas {
		if a.ID == "desk-20-3" {
			t.Fatal("a free desk has no room")
		}
	}
	if h.w.locks["desk-20-3"] != nil {
		t.Fatal("the lock goes with the room")
	}
	for _, pr := range m.Props {
		if pr.T == "desk" && pr.X == 20 && pr.Y == 3 && pr.Assign != 0 {
			t.Fatal("the returned map, which is persisted, is freed too")
		}
	}
	if !strings.Contains(frames(other), `"t":"map"`) {
		t.Fatal("everybody receives the new map")
	}
	if _, err := h.w.doClaimDesk(1, 20, 3, h.now); err != nil {
		t.Fatalf("a released desk can be taken again: %v", err)
	}
}

func TestReleaseDeskIsRefused(t *testing.T) {
	cases := []struct {
		name string
		uid  uint32
		x, y int
		want error
	}{
		{"not online", 9, 20, 3, ErrClaimOffline},
		{"no desk there", 1, 21, 3, ErrClaimNoDesk},
		{"somebody else's desk", 2, 24, 3, ErrReleaseNotMine},
		{"a free desk", 1, 28, 3, ErrReleaseNotMine},
		{"too far from my desk", 3, 32, 3, ErrClaimFar},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			assignDesk(t, h, 20, 3, 1)
			assignDesk(t, h, 24, 3, 5)
			assignDesk(t, h, 32, 3, 3)
			h.add(1, "member", 20*16+8, 4*16+8)
			h.add(2, "member", 24*16+8, 4*16+8)
			h.add(3, "member", 32*16+8, 7*16+8) // three rows away from their desk
			_, err := h.w.doReleaseDesk(c.uid, c.x, c.y, h.now)
			if !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
			if d := deskAt(h.w, 24, 3); d.Assign != 5 {
				t.Fatal("a refused release changes nothing")
			}
		})
	}
}

func TestDeskLabelFitsTheMap(t *testing.T) {
	for _, name := range []string{"Ana", "Éléonore-Hélène Dupré-Lefèvre Ångström"} {
		l := deskLabel(name)
		if len(l) > 40 || !utf8.ValidString(l) || !strings.HasPrefix(name+"'s desk", l) {
			t.Fatalf("%q -> %q (%d bytes)", name, l, len(l))
		}
	}
	if deskLabel("Ana") != "Ana's desk" {
		t.Fatal(deskLabel("Ana"))
	}
}
