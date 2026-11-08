package world

import (
	"strings"
	"testing"
	"time"

	"homequarters/internal/gamemap"
)

// An administrator's edit applies at once to the people online: a wall painted in the editor blocks
// them, a new admins-only room keeps members out, and alone in that room an administrator starts no
// call. (The browser suite's editor scenario drives the editor itself, with the same tiles.)
func TestAnEditedMapAppliesItsNewWallsAndRoomsAtOnce(t *testing.T) {
	h := newHarness(t)
	m := *gamemap.Default()
	m.Walls = append([]string(nil), m.Walls...)
	for y := 20; y <= 24; y++ { // the wall the editor scenario paints: x 35, rows 20..24
		row := []byte(m.Walls[y])
		row[35] = '#'
		m.Walls[y] = string(row)
	}
	m.Areas = append(append([]gamemap.Area(nil), m.Areas...), gamemap.Area{ID: "test-room", Name: "Test room", Kind: gamemap.KindRoom,
		X: 14, Y: 28, W: 6, H: 5, Floor: "carpet_teal", Access: gamemap.Access{Mode: gamemap.AccessAdmins}, Capacity: 20})
	mem := h.add(1, "member", 34*16+8, 22*16+8)
	in := h.add(2, "member", 16*16+8, 27*16+8)
	admin := h.add(3, "admin", 16*16+8, 30*16+8)
	h.consent(admin, true)
	cm, err := gamemap.Compile(&m)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.w.doReloadMap(cm, h.now); err != nil {
		t.Fatal(err)
	}
	drain(admin)
	h.send(mem, ev{kind: evInput, seq: 1, dx: 1})
	h.send(in, ev{kind: evInput, seq: 1, dy: 1})
	h.run(2 * time.Second)
	if mem.X >= 35*16 {
		t.Fatalf("the new wall blocks movement on the server: x=%.1f", mem.X)
	}
	if in.Y >= 28*16 {
		t.Fatalf("a member is kept out of the newly created admins-only room: y=%.1f", in.Y)
	}
	room := officeIndex(t, h.w, "test-room")
	h.run(3 * time.Second)
	if admin.area != room || admin.group == nil || !admin.group.isRoom {
		t.Fatalf("the new room is a real meeting room: area %d (want %d), group %+v", admin.area, room, admin.group)
	}
	for _, f := range drain(admin) {
		if strings.Contains(f, `"op":"join"`) {
			t.Fatalf("alone inside the new room, no call is started: %s", f)
		}
	}
}
