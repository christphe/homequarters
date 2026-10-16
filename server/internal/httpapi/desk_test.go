package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"tilework/internal/gamemap"
)

// online connects u's game socket; incoming frames are read and dropped.
func (u *user) online(t *testing.T) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(u.r.ts.URL, "http")+"/ws", &websocket.DialOptions{HTTPClient: u.c})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	go func() { // CloseRead would close the socket on the first message
		for {
			if _, _, err := c.Read(context.Background()); err != nil {
				return
			}
		}
	}()
	return c
}

func TestClaimDeskThroughTheAPI(t *testing.T) {
	r := newRig(t, nil)
	r.srv.mapLim = newLimiter(100, 100) // the test polls faster than a person clicks
	r.join("Ana", "")                   // the first member is the admin
	bia, _ := r.join("Bia", "")
	desk := map[string]int{"x": 20, "y": 3}

	if code, out := bia.do("POST", "/api/desk", desk); code != http.StatusConflict || out["error"] != "offline" {
		t.Fatalf("not connected: %d %v", code, out)
	}
	c := bia.online(t)
	code, out := bia.do("POST", "/api/desk", desk)
	for i := 0; i < 20 && out["error"] == "offline"; i++ { // the world admits the socket right after the handshake
		time.Sleep(50 * time.Millisecond)
		code, out = bia.do("POST", "/api/desk", desk)
	}
	if code != http.StatusConflict || out["error"] != "far" {
		t.Fatalf("at the spawn, far from the desk: %d %v", code, out)
	}
	if err := c.Write(context.Background(), websocket.MessageText, []byte(`{"t":"go","x":20,"y":4}`)); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); time.Sleep(300 * time.Millisecond) {
		if code, out = bia.do("POST", "/api/desk", desk); out["error"] != "far" {
			break
		}
	}
	if code != http.StatusOK {
		t.Fatalf("next to the desk: %d %v", code, out)
	}
	office, err := r.st.OfficeBySlug(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	var m gamemap.Map
	if err := json.Unmarshal([]byte(office.MapJSON), &m); err != nil {
		t.Fatal(err)
	}
	saved := false
	for _, p := range m.Props {
		saved = saved || (p.T == "desk" && p.X == 20 && p.Y == 3 && p.Assign == bia.ID)
	}
	if !saved {
		t.Fatal("the claim is saved, so it survives a restart")
	}
	entries, _ := r.st.ListAudit(context.Background(), office.ID, 5)
	if len(entries) == 0 || entries[0].Action != "desk.claim" || entries[0].Actor != "Bia" {
		t.Fatalf("the claim is audited: %+v", entries)
	}
	if code, out := bia.do("POST", "/api/desk", desk); code != http.StatusConflict || out["error"] != "has_place" {
		t.Fatalf("my own desk again: %d %v", code, out)
	}
	if code, out := bia.do("POST", "/api/desk", map[string]int{"x": 3, "y": 3}); code != http.StatusNotFound || out["error"] != "no_desk" {
		t.Fatalf("no desk there: %d %v", code, out)
	}
	anon := &user{r: r, c: &http.Client{}}
	if code, _ := anon.do("POST", "/api/desk", desk); code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", code)
	}
	if code, _ := anon.do("POST", "/api/desk/release", desk); code != http.StatusUnauthorized {
		t.Fatalf("anonymous release: %d", code)
	}

	// Bia stands on the chair, inside her desk room: she frees the desk
	if code, out := bia.do("POST", "/api/desk/release", desk); code != http.StatusOK {
		t.Fatalf("release my desk: %d %v", code, out)
	}
	office, _ = r.st.OfficeBySlug(context.Background(), "default")
	m = gamemap.Map{}
	json.Unmarshal([]byte(office.MapJSON), &m)
	for _, p := range m.Props {
		if p.T == "desk" && p.X == 20 && p.Y == 3 && p.Assign != 0 {
			t.Fatal("the release is saved")
		}
	}
	entries, _ = r.st.ListAudit(context.Background(), office.ID, 5)
	if len(entries) == 0 || entries[0].Action != "desk.release" {
		t.Fatalf("the release is audited: %+v", entries)
	}
	if code, out := bia.do("POST", "/api/desk/release", desk); code != http.StatusConflict || out["error"] != "not_mine" {
		t.Fatalf("release a free desk: %d %v", code, out)
	}
}

func TestClaimDeskIsRateLimited(t *testing.T) {
	r := newRig(t, nil)
	r.join("Ana", "")
	bia, _ := r.join("Bia", "")
	limited := false
	for i := 0; i < 20 && !limited; i++ {
		code, _ := bia.do("POST", "/api/desk", map[string]int{"x": 20, "y": 3})
		limited = code == http.StatusTooManyRequests
	}
	if !limited {
		t.Fatal("claims are rate limited")
	}
}
