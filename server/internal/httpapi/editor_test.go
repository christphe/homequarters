package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"homequarters/internal/gamemap"
	"homequarters/internal/media"
)

// The map editor's save (PUT /api/map): administrators only, validated, refused when it would change
// the office's size on the fly; a valid edit reaches the people online at once and is still there
// after a restart. (The browser suite's editor scenario drives the editor itself, with the same edit.)
func TestPutMapIsAdminOnlyValidatedLiveAndSurvivesARestart(t *testing.T) {
	r := newRig(t, nil)
	r.srv.mapLim = newLimiter(100, 100)
	admin, _ := r.join("Ana", "")
	member, _ := r.join("Ed", "")
	ch := member.listen(t)
	await(t, ch, "hello", nil)
	orig := r.savedMap(t)

	if code, _ := member.do("PUT", "/api/map", orig); code != http.StatusForbidden {
		t.Fatalf("a member cannot replace the map (admin-only endpoint): %d", code)
	}
	badSpawn := orig
	badSpawn.Spawn = gamemap.Point{X: 0, Y: 0} // (0,0) is a wall
	if code, _ := admin.do("PUT", "/api/map", badSpawn); code != http.StatusUnprocessableEntity {
		t.Fatalf("the server rejects a map whose spawn is inside a wall: %d", code)
	}
	badSize := orig
	badSize.Walls = orig.Walls[1:]
	badSize.H = orig.H - 1
	if code, _ := admin.do("PUT", "/api/map", badSize); code != http.StatusConflict {
		t.Fatalf("the server refuses to change the map size on the fly: %d", code)
	}
	if got := r.savedMap(t); got.H != orig.H || got.Spawn != orig.Spawn {
		t.Fatalf("a refused map is not saved: h=%d spawn=%+v", got.H, got.Spawn)
	}

	// the editor scenario's edit: a wall at x 35, rows 20..24, and an admins-only room
	edit := orig
	edit.Walls = append([]string(nil), orig.Walls...)
	for y := 20; y <= 24; y++ {
		row := []byte(edit.Walls[y])
		row[35] = '#'
		edit.Walls[y] = string(row)
	}
	edit.Areas = append(append([]gamemap.Area(nil), orig.Areas...), gamemap.Area{ID: "test-room", Name: "Test room", Kind: gamemap.KindRoom,
		X: 14, Y: 28, W: 6, H: 5, Floor: "carpet_teal", Access: gamemap.Access{Mode: gamemap.AccessAdmins}, Capacity: 20})
	edited := func(m gamemap.Map) bool {
		room := false
		for _, a := range m.Areas {
			room = room || (a.Name == "Test room" && a.Access.Mode == gamemap.AccessAdmins)
		}
		return m.Walls[22][35] == '#' && room
	}
	if code, out := admin.do("PUT", "/api/map", edit); code != http.StatusOK {
		t.Fatalf("a valid edit is saved: %d %v", code, out)
	}
	await(t, ch, "map", func(f map[string]any) bool { return edited(mapOf(t, f)) })

	// restart: a new server over the same database serves the edited map
	r.ts.Close()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	again := &rig{t: t, st: r.st, cfg: r.cfg, srv: New(ctx, r.cfg, log, r.st, media.New(media.Config{}, log))}
	again.ts = httptest.NewServer(again.srv.Handler())
	t.Cleanup(again.ts.Close)
	back, _ := again.join("Ed2", "")
	if m := mapOf(t, await(t, back.listen(t), "hello", nil)); !edited(m) {
		t.Fatalf("edited walls and rooms persist across a server restart: wall %q, %d areas", m.Walls[22][35], len(m.Areas))
	}
}
