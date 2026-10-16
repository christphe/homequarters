package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestAdminRenamesTheOfficeForEverybodyOnline(t *testing.T) {
	r := newRig(t, nil)
	admin, _ := r.join("Ana", "")
	member, _ := r.join("Bia", "")
	anon := &user{r: r, c: &http.Client{}}
	name := map[string]string{"name": "  Harbour HQ  "}
	if code, _ := anon.do("PATCH", "/api/admin/office", name); code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", code)
	}
	if code, _ := member.do("PATCH", "/api/admin/office", name); code != http.StatusForbidden {
		t.Fatalf("member: %d", code)
	}
	// invisible characters only (zero-width space, bidi override) would show an empty name
	for _, bad := range []string{"", "   ", "\x01\x02", "\u200b", "\u202e\u200b ", "\u2028", strings.Repeat("é", 41)} {
		if code, _ := admin.do("PATCH", "/api/admin/office", map[string]string{"name": bad}); code != http.StatusBadRequest {
			t.Fatalf("%q: %d", bad, code)
		}
	}

	// Bia is online: the new name reaches her socket without a reload
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.ts.URL, "http")+"/ws", &websocket.DialOptions{HTTPClient: member.c})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	frames := make(chan string, 64)
	go func() {
		for {
			_, b, err := c.Read(context.Background())
			if err != nil {
				close(frames)
				return
			}
			frames <- string(b)
		}
	}()
	for f := range frames { // admitted once the hello arrives
		if strings.HasPrefix(f, `{"t":"hello"`) {
			break
		}
	}

	if code, out := admin.do("PATCH", "/api/admin/office", name); code != http.StatusOK || out["name"] != "Harbour HQ" {
		t.Fatalf("admin: %d %v", code, out)
	}
	got := false
	for timeout := time.After(3 * time.Second); !got; {
		select {
		case f := <-frames:
			got = f == `{"t":"office","n":"Harbour HQ"}`
		case <-timeout:
			t.Fatal("the online member never heard of the new name")
		}
	}
	o, err := r.st.OfficeByID(context.Background(), 1)
	if err != nil || o.Name != "Harbour HQ" {
		t.Fatalf("the name is stored: %+v %v", o, err)
	}
	_, out := admin.do("GET", "/api/admin/audit", nil)
	b, _ := json.Marshal(out)
	var audit struct {
		Entries []struct{ Action, Detail string }
	}
	json.Unmarshal(b, &audit)
	if len(audit.Entries) == 0 || audit.Entries[0].Action != "office.rename" || audit.Entries[0].Detail != "T -> Harbour HQ" {
		t.Fatalf("the rename is audited with the old and new name: %s", b)
	}
}

func TestOfficeRenamesAreRateLimited(t *testing.T) {
	r := newRig(t, nil)
	admin, _ := r.join("Ana", "")
	limited := false
	for i := 0; i < 6 && !limited; i++ {
		code, _ := admin.do("PATCH", "/api/admin/office", map[string]string{"name": "Name " + strings.Repeat("x", i)})
		limited = code == http.StatusTooManyRequests
	}
	if !limited {
		t.Fatal("a loop of renames must be slowed down: each one is a broadcast to everybody")
	}
}

func TestAWorldStartedDuringARenameTakesTheNewName(t *testing.T) {
	r := newRig(t, nil)
	r.join("Ana", "")
	bia, _ := r.join("Bia", "")
	stale, err := r.st.OfficeBySlug(context.Background(), "default") // read by a socket before the rename...
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.st.RenameOffice(context.Background(), stale.ID, "Harbour HQ"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.srv.worldFor(stale); err != nil { // ...which then starts the world
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.ts.URL, "http")+"/ws", &websocket.DialOptions{HTTPClient: bia.c})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	for {
		_, b, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if f := string(b); strings.HasPrefix(f, `{"t":"hello"`) {
			if !strings.Contains(f, `"office":"Harbour HQ"`) {
				t.Fatalf("the world must start with the stored name: %.120s", f)
			}
			return
		}
	}
}
