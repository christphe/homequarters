package world

import (
	"strings"
	"testing"
	"time"

	"homequarters/internal/gamemap"
)

func TestRunningDoublesSpeedAndIsCarriedInTheStateRecord(t *testing.T) {
	h := newHarness(t)
	walk := h.add(1, "member", sx, sy)
	run := h.add(2, "member", sx, sy+40)
	h.send(walk, ev{kind: evInput, seq: 1, dx: 1})
	h.send(run, ev{kind: evInput, seq: 1, dx: 1, b: true})
	h.run(time.Second)
	dw, dr := walk.X-sx, run.X-sx
	if dw < 60 || dw > 80 {
		t.Fatalf("walking covers ~72 px/s, got %.1f", dw)
	}
	if dr < 1.9*dw || dr > 2.1*dw {
		t.Fatalf("running is twice as fast: walk %.1f run %.1f", dw, dr)
	}
	if run.rec().d&(1<<6) == 0 || walk.rec().d&(1<<6) != 0 {
		t.Fatal("the run bit tells clients how fast to extrapolate")
	}
	// releasing the run key mid-walk publishes a new state at walking speed
	drain(walk)
	h.send(run, ev{kind: evInput, seq: 2, dx: 1})
	if run.running() || run.rec().d&(1<<6) != 0 {
		t.Fatal("releasing the run key walks again")
	}
	if run.last.d&(1<<6) != 0 {
		t.Fatal("the speed change is published at once, not at the next resync")
	}
	// a stopped player never carries the run bit
	h.send(run, ev{kind: evInput, seq: 3, b: true})
	if run.rec().d&(1<<6) != 0 {
		t.Fatal("standing still is not running")
	}
}

func TestShadowMatchesTheServerWhileRunning(t *testing.T) {
	h := newHarness(t)
	p := h.add(1, "member", sx, sy)
	h.send(p, ev{kind: evInput, seq: 1, dx: 1, b: true})
	h.run(800 * time.Millisecond)
	if d := dist(p.X, p.Y, p.ix, p.iy); d > divergeTol {
		t.Fatalf("clients extrapolate a runner correctly (diverged %.1f px)", d)
	}
}

// The client walks in small per-frame steps and stops touching a wall. The server must stop at
// the same spot, or every run into a wall ends with the avatar pulled back a few pixels.
func TestRunningIntoAWallStopsTouchingIt(t *testing.T) {
	for _, run := range []bool{false, true} {
		h := newHarness(t)
		p := h.add(1, "member", 5*16+8, 15*16+8) // below the y=14 wall (a 1-tile wall, open floor above)
		h.send(p, ev{kind: evInput, seq: 1, dy: -1, b: run})
		h.run(time.Second)
		if want := 15*16 + boxHalfH; p.Y != want {
			t.Fatalf("run=%v: stops touching the wall at y=%v, got %v", run, want, p.Y)
		}
		if p.iy != p.Y {
			t.Fatalf("run=%v: clients extrapolate to the same contact point (%v vs %v)", run, p.iy, p.Y)
		}
	}
}

// A starved VM can deliver a tick late. Movement is integrated over real time, so the late
// tick must cover the whole gap; clamping it made the client (which kept walking) snap back.
func TestALateTickDoesNotLoseDistance(t *testing.T) {
	h := newHarness(t)
	p := h.add(1, "member", 3*16+8, sy)
	h.send(p, ev{kind: evInput, seq: 1, dx: 1, b: true})
	h.now = h.now.Add(600 * time.Millisecond)
	h.w.tick(h.now)
	if got, want := p.X-(3*16+8), 144*0.6; got < want-0.5 || got > want+0.5 {
		t.Fatalf("a 600 ms tick moves a runner %.1f px, got %.1f", want, got)
	}
}

func TestALateTickDoesNotTunnelThroughAWall(t *testing.T) {
	h := newHarness(t)
	p := h.add(1, "member", 5*16+8, 15*16+8)
	h.send(p, ev{kind: evInput, seq: 1, dy: -1, b: true})
	h.now = h.now.Add(900 * time.Millisecond)
	h.w.tick(h.now)
	if p.Y != 15*16+boxHalfH {
		t.Fatalf("a long step stops at the wall, got y=%v", p.Y)
	}
}

func TestWalkToATileRunsAroundWallsAndArrives(t *testing.T) {
	h := newHarness(t)
	p := h.add(1, "member", 9*16+8, 20*16+8) // social area; reception is behind a wall
	drain(p)
	h.send(p, ev{kind: evGoto, x: 9, y: 6})
	if got := frames(p); !strings.Contains(got, `"ok":true`) {
		t.Fatalf("the walk is accepted: %q", got)
	}
	if !p.destOn || !p.running() {
		t.Fatal("a walk-to runs")
	}
	h.run(9 * time.Second)
	if got := tileOf(p.X, p.Y); got != (tile{9, 6}) {
		t.Fatalf("must arrive at (9,6), is at tile %v (%.0f,%.0f)", got, p.X, p.Y)
	}
	if p.destOn || p.Dx != 0 || p.Dy != 0 || len(h.w.followers) != 0 {
		t.Fatal("the walk ends and the avatar stops on arrival")
	}
}

// "Walk to" a person ends on their tile, so in a small office or desk room the walker gets in.
func TestWalkToAPersonEndsOnTheirTile(t *testing.T) {
	for _, c := range []struct {
		name   string
		tx, ty float64
	}{
		{"reception, behind a wall", 9*16 + 8, 6*16 + 8},
		{"a small private office", 6*16 + 8, 42*16 + 8}, // office 1, not assigned: open to everybody
		{"a meeting room", 50*16 + 8, 4*16 + 8},
	} {
		h := newHarness(t)
		target := h.add(1, "member", c.tx, c.ty)
		p := h.add(2, "member", 9*16+8, 20*16+8)
		drain(p)
		h.send(p, ev{kind: evGoto, id: 1})
		if got := frames(p); !strings.Contains(got, `"ok":true`) || strings.Contains(got, `"near"`) {
			t.Fatalf("%s: the walk is accepted, straight to them: %q", c.name, got)
		}
		h.run(15 * time.Second)
		if got, want := tileOf(p.X, p.Y), tileOf(target.X, target.Y); got != want {
			t.Fatalf("%s: must end on the person's tile %v, is on %v (%.0f,%.0f)", c.name, want, got, p.X, p.Y)
		}
		if p.area != target.area {
			t.Fatalf("%s: must end in the same room", c.name)
		}
		if p.destOn {
			t.Fatalf("%s: the walk ends on arrival", c.name)
		}
	}
}

// If the person is behind a door the walker may not open (locked, or somebody else's office), the
// walk stops on the closest tile it can reach, outside, and says so.
func TestWalkToAPersonInALockedRoomStopsAtTheDoor(t *testing.T) {
	h := newHarness(t)
	target := h.add(1, "member", 50*16+8, 4*16+8) // in Aurora (an open meeting room)
	p := h.add(2, "member", 9*16+8, 20*16+8)
	h.send(target, ev{kind: evLock, b: true})
	drain(p)
	h.send(p, ev{kind: evGoto, id: 1})
	if got := frames(p); !strings.Contains(got, `"ok":true`) || !strings.Contains(got, `"near":true`) {
		t.Fatalf("the walk is accepted as far as the door, and says so: %q", got)
	}
	h.run(15 * time.Second)
	if p.area == target.area {
		t.Fatal("a locked room keeps the walker out")
	}
	if d := dist(p.X, p.Y, target.X, target.Y); d > 8*16 {
		t.Fatalf("must stop at the room's door, %.0f px from the person at (%.0f,%.0f)", d, p.X, p.Y)
	}
	if p.destOn {
		t.Fatal("the walk ends at the door")
	}
}

func TestWalkToIsCancelledByInputAndRefusesForbiddenPlaces(t *testing.T) {
	h := newHarness(t)
	p := h.add(1, "member", sx, sy)
	h.send(p, ev{kind: evGoto, x: 3, y: 30})
	h.run(200 * time.Millisecond)
	h.send(p, ev{kind: evInput, seq: 1}) // a released key does not cancel
	if !p.destOn {
		t.Fatal("a zero input keeps the walk going")
	}
	h.send(p, ev{kind: evInput, seq: 2, dy: -1})
	if p.destOn || len(h.w.followers) != 0 {
		t.Fatal("moving on your own cancels the walk")
	}
	drain(p)
	h.send(p, ev{kind: evGoto, x: 50, y: 10}) // inside the admin-only boardroom
	if got := frames(p); !strings.Contains(got, `"ok":false`) || p.destOn {
		t.Fatalf("a member cannot be routed into an admin room: %q", got)
	}
	h.send(p, ev{kind: evGoto, x: 0, y: 0}) // outer wall
	if p.destOn {
		t.Fatal("cannot walk into a wall")
	}
	h.send(p, ev{kind: evGoto, x: -4, y: 9999})
	if p.destOn {
		t.Fatal("out-of-map targets are ignored")
	}
	h.send(p, ev{kind: evGoto, id: 77})
	if p.destOn {
		t.Fatal("cannot walk to somebody who is not there")
	}
}

// A leave and a fresh state for the same entity in one tick replace each other: the client gets
// whichever came last, never both.
func TestLeaveAndReturnInOneTickKeepOnlyTheLast(t *testing.T) {
	h := newHarness(t)
	a := h.add(1, "member", sx, sy)
	b := h.add(2, "member", sx+20, sy)
	h.run(200 * time.Millisecond)
	drain(a)
	h.w.queueLeave(a, b.ID)
	h.w.queuePos(a, b)
	h.w.flush(a)
	got := frames(a)
	if !strings.Contains(got, `"m":[[2,`) || strings.Contains(got, `"l":`) {
		t.Fatalf("leave then return must send only the state: %s", got)
	}
	h.w.queuePos(a, b)
	h.w.queueLeave(a, b.ID)
	h.w.flush(a)
	got = frames(a)
	if !strings.Contains(got, `"l":[2]`) || strings.Contains(got, `"m":`) {
		t.Fatalf("return then leave must send only the leave: %s", got)
	}
}

// An acknowledgement dropped for congestion is retried on later ticks, not lost: without it a
// lost ack leaves the owner's prediction diverged with no recovery (the ack is the only channel
// that keeps it on the truth).
func TestUnsentAckIsRetriedAfterCongestion(t *testing.T) {
	h := newHarness(t)
	p := h.add(1, "member", sx, sy)
	drain(p)
	for len(p.out) < cap(p.out) { // completely full: even a best-effort send is dropped
		p.out <- []byte("{}")
	}
	h.send(p, ev{kind: evInput, seq: 7, dx: 1})
	for _, f := range drain(p) {
		if strings.Contains(f, `"t":"a"`) {
			t.Fatal("a congested queue must skip the ack, retrying later")
		}
	}
	if p.ackSeq != 7 || p.ackSent == 7 {
		t.Fatalf("the input is recorded with its ack pending (seq %d sent %d)", p.ackSeq, p.ackSent)
	}
	h.run(time.Second / 15) // the queue is free again: the ack for the latest input goes out
	found := false
	for _, f := range drain(p) {
		if strings.Contains(f, `"t":"a","s":7`) {
			found = true
		}
	}
	if !found {
		t.Fatal("the ack is retried on a later tick, not lost")
	}
	h.run(time.Second) // and it is sent once, not every tick
	for _, f := range drain(p) {
		if strings.Contains(f, `"t":"a"`) {
			t.Fatal("the ack must not repeat once queued")
		}
	}
}

// roomShortcutHarness opens a door between the Horizon and Focus rooms, so from the social area the
// way into Focus through Horizon is shorter than Focus's own door. closeFocus walls Focus's door to the
// social area, leaving Horizon as the only way in. doors are more wall tiles to open.
func roomShortcutHarness(t testing.TB, closeFocus bool, doors ...tile) *harness {
	t.Helper()
	h := newHarness(t)
	m := gamemap.Default()
	carve := func(x, y int, c byte) {
		row := []byte(m.Walls[y])
		row[x] = c
		m.Walls[y] = string(row)
	}
	carve(50, 25, '.')
	carve(51, 25, '.')
	if closeFocus {
		carve(41, 29, '#')
		carve(41, 30, '#')
	}
	for _, d := range doors {
		carve(int(d.x), int(d.y), '.')
	}
	cm, err := gamemap.Compile(m)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.w.doReloadMap(cm, h.now); err != nil {
		t.Fatal(err)
	}
	return h
}

// walkAreas runs a guided walk to tile (x, y) and returns the areas the walker stood in.
func walkAreas(h *harness, p *Player, x, y int) map[string]bool {
	seen := map[string]bool{}
	h.send(p, ev{kind: evGoto, x: x, y: y})
	for i := 0; i < 15*h.w.cfg.TickHz; i++ {
		h.run(time.Second / time.Duration(h.w.cfg.TickHz))
		if p.area >= 0 {
			seen[h.w.m.Map.Areas[p.area].ID] = true
		}
	}
	return seen
}

// A guided walk goes around a room that is neither where it starts nor where it ends, even when the
// way through the room is shorter.
func TestGotoAvoidsForeignRooms(t *testing.T) {
	h := roomShortcutHarness(t, false)
	p := h.add(1, "member", 40*16+8, 20*16+8) // social area, next to Horizon's door
	if path := h.w.findPath(p, tileOf(p.X, p.Y), tile{50, 27}); path == nil {
		t.Fatal("setup: Focus is reachable")
	}
	seen := walkAreas(h, p, 50, 27)
	if seen["horizon"] {
		t.Fatalf("the walk crossed the Horizon room, areas %v", seen)
	}
	if got := tileOf(p.X, p.Y); got != (tile{50, 27}) {
		t.Fatalf("must arrive at (50,27) in Focus, is at %v", got)
	}
	// starting inside a room, the walk leaves it as usual
	seen = walkAreas(h, p, 30, 20)
	if got := tileOf(p.X, p.Y); got != (tile{30, 20}) || seen["horizon"] {
		t.Fatalf("from Focus to the social area: at %v, areas %v", got, seen)
	}
}

// When a room is the only way, the walk goes through it rather than giving up.
func TestGotoCrossesARoomWhenItIsTheOnlyWay(t *testing.T) {
	h := roomShortcutHarness(t, true)
	p := h.add(1, "member", 40*16+8, 20*16+8)
	seen := walkAreas(h, p, 50, 27)
	if got := tileOf(p.X, p.Y); got != (tile{50, 27}) {
		t.Fatalf("must arrive at (50,27) through Horizon, is at %v, areas %v", got, seen)
	}
	if !seen["horizon"] {
		t.Fatalf("the only way is through Horizon, areas %v", seen)
	}
}

// When a room must be crossed, the walk does not cross another one it could go around: with Focus
// reachable only through Horizon and a door opened from the Boardroom into Horizon, an admin in the
// desks area goes round by the social area rather than through the Boardroom, which is shorter.
func TestGotoCrossesAsFewRoomsAsItMust(t *testing.T) {
	h := roomShortcutHarness(t, true, tile{50, 14}, tile{51, 14})
	p := h.add(1, "admin", 40*16+8, 10*16+8)
	seen := walkAreas(h, p, 50, 27)
	if got := tileOf(p.X, p.Y); got != (tile{50, 27}) {
		t.Fatalf("must arrive at (50,27), is at %v, areas %v", got, seen)
	}
	if seen["boardroom"] || !seen["horizon"] {
		t.Fatalf("must cross Horizon only, areas %v", seen)
	}
}

// Following someone into a room takes the same way round as a walk-to.
func TestFollowAvoidsForeignRooms(t *testing.T) {
	h := roomShortcutHarness(t, false)
	h.add(1, "member", 50*16+8, 27*16+8) // in Focus
	f := h.add(2, "member", 40*16+8, 20*16+8)
	h.send(f, ev{kind: evFollow, id: 1})
	for i := 0; i < 15*h.w.cfg.TickHz; i++ {
		h.run(time.Second / time.Duration(h.w.cfg.TickHz))
		if f.area >= 0 && h.w.m.Map.Areas[f.area].ID == "horizon" {
			t.Fatalf("the follower crossed Horizon at (%.0f,%.0f)", f.X, f.Y)
		}
	}
	if f.area < 0 || h.w.m.Map.Areas[f.area].ID != "focus" {
		t.Fatalf("the follower must reach the leader in Focus, is at (%.0f,%.0f)", f.X, f.Y)
	}
}
