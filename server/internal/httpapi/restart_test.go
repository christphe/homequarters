package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A graceful restart keeps a whiteboard stroke drawn just before it (written on the way down, without
// waiting for the save debounce) and a note's content edited through the map API.
func TestBoardStrokesAndNoteEditsSurviveAGracefulRestart(t *testing.T) {
	r := newRig(t, nil)
	// the rig's server lives as long as the test: this one is stopped on purpose, on the same database
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx, stop := context.WithCancel(context.Background())
	t.Cleanup(stop)
	srv := New(ctx, r.cfg, log, r.st, r.srv.media)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	r1 := &rig{t: t, ts: ts, st: r.st, cfg: r.cfg, srv: srv}
	ana, _ := r1.join("Ana", "") // the first member: an administrator

	// the welcome note at (4, 5) gets new content through the map API (what the editor saves)
	var m map[string]any
	_, _, body := ana.raw("GET", "/api/admin/map", nil)
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range m["props"].([]any) {
		if p := p.(map[string]any); p["t"] == "note" && p["x"] == 4.0 && p["y"] == 5.0 {
			p["data"], found = "A saved team note", true
		}
	}
	if !found {
		t.Fatal("setup: the default office has a note at (4, 5)")
	}
	if code, out := ana.do("PUT", "/api/map", m); code != 200 {
		t.Fatalf("save the map: %d %v", code, out)
	}

	// Ana stands at the whiteboard (49, 15), opens it and writes on it
	office, err := r.st.OfficeBySlug(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.st.SaveLastPos(context.Background(), office.ID, ana.ID, 49*16+8, 16*16+8); err != nil {
		t.Fatal(err)
	}
	s := ana.socket(t)
	s.wait(t, `"t":"hello"`, 1)
	s.send(t, `{"t":"use","x":49,"y":15}`)
	s.wait(t, `"op":"state"`, 1)
	s.send(t, `{"t":"wb","op":"draw","bk":"49,15","i":1,"k":1,"p":[400,280],"tx":"Saved across restart"}`)
	s.wait(t, `"tx":"Saved across restart"`, 1) // accepted: the echo of the stroke

	stop() // a graceful stop, well within the save debounce
	var boards map[string][]byte
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if boards, _ = r.st.LoadBoards(context.Background(), office.ID); strings.Contains(string(boards["49,15"]), "Saved across restart") {
			break
		}
	}
	if !strings.Contains(string(boards["49,15"]), "Saved across restart") {
		t.Fatalf("the stroke is written when the server stops: %q", boards)
	}

	// a second server on the same database: the board and the note come back
	ctx2, cancel2 := context.WithCancel(context.Background())
	t.Cleanup(cancel2)
	srv2 := New(ctx2, r.cfg, log, r.st, r.srv.media)
	ts2 := httptest.NewServer(srv2.Handler())
	t.Cleanup(ts2.Close)
	ana2 := &user{r: &rig{t: t, ts: ts2, st: r.st, cfg: r.cfg, srv: srv2}, c: ana.c, ID: ana.ID}
	s2 := ana2.socket(t)
	s2.wait(t, `"t":"hello"`, 1)
	s2.send(t, `{"t":"use","x":49,"y":15}`)
	s2.wait(t, `"op":"state"`, 1)
	if s2.count(`"tx":"Saved across restart"`) != 1 {
		t.Fatal("the whiteboard restores after the restart")
	}
	_, _, body = ana2.raw("GET", "/api/admin/map", nil)
	if !strings.Contains(body, `"data":"A saved team note"`) {
		t.Fatal("the note's edit persists across the restart")
	}
}
