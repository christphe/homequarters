package world

import (
	"strings"
	"testing"
	"time"
)

// A member pushing at the admins-only Boardroom's door with audio allowed: stopped outside by the server,
// in no conversation, and a media token asked for outside any group gets nothing.
func TestAMemberAtTheAdminRoomDoorHasNoCallAndGetsNoToken(t *testing.T) {
	h := newHarness(t)
	m := h.add(1, "member", 43*16+8, 10*16+8)
	h.consent(m, true)
	for i := 0; i < 40; i++ { // a client that keeps sending "right", past any prediction
		h.w.handle(ev{kind: evInput, p: m, gen: m.gen, seq: uint32(1000 + i), dx: 1}, h.now)
		h.run(60 * time.Millisecond)
	}
	h.run(400 * time.Millisecond)
	h.w.handle(ev{kind: evInput, p: m, gen: m.gen, seq: 2000}, h.now)
	if m.X >= 45*16 {
		t.Fatalf("the server let a member into the admins-only room: x=%v", m.X)
	}
	joined := func() bool {
		for _, f := range drain(m) {
			if strings.Contains(f, `"op":"join"`) {
				return true
			}
		}
		return false
	}
	if m.group != nil || joined() {
		t.Fatal("a member outside the room has no conversation for it")
	}
	h.w.handle(ev{kind: evToken, p: m, gen: m.gen}, h.now)
	if joined() {
		t.Fatal("a media token asked for outside any group yields nothing")
	}
}
