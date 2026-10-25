package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"homequarters/internal/gamemap"
)

func TestAdminAppliesATemplateAndDesksCarryOver(t *testing.T) {
	r := newRig(t, nil)
	admin, _ := r.join("Ana", "")
	member, _ := r.join("Bia", "")
	var bia int64
	_, ms := admin.do("GET", "/api/admin/members", nil)
	for _, m := range ms["members"].([]any) {
		if m := m.(map[string]any); m["name"] == "Bia" {
			bia = int64(m["id"].(float64))
		}
	}

	// Bia owns the Loft's Desk 2
	_, full := admin.do("GET", "/api/admin/map", nil)
	for _, p := range full["props"].([]any) {
		if p := p.(map[string]any); p["label"] == "Desk 2" {
			p["assign"] = bia
		}
	}
	if code, out := admin.do("PUT", "/api/map", full); code != http.StatusOK {
		t.Fatalf("assign: %d %v", code, out)
	}

	if code, _ := member.do("GET", "/api/admin/templates", nil); code != http.StatusForbidden {
		t.Fatalf("member list: %d", code)
	}
	if code, _ := member.do("POST", "/api/admin/map/template", map[string]string{"template": "manor"}); code != http.StatusForbidden {
		t.Fatalf("member apply: %d", code)
	}
	if code, _ := admin.do("POST", "/api/admin/map/template", map[string]string{"template": "castle"}); code != http.StatusBadRequest {
		t.Fatalf("unknown template: %d", code)
	}
	type row struct {
		ID      string
		W, H    int
		Summary gamemap.Summary
		Carry   gamemap.Carry
		Current bool
	}
	list := func() map[string]row {
		_, out := admin.do("GET", "/api/admin/templates", nil)
		b, _ := json.Marshal(out["templates"])
		var rows []row
		json.Unmarshal(b, &rows)
		byID := map[string]row{}
		for _, x := range rows {
			byID[x.ID] = x
		}
		return byID
	}
	rows := list()
	if len(rows) != 3 || !rows["loft"].Current || rows["manor"].Current || rows["manor"].Summary.Desks != 48 ||
		rows["lodge"].Summary.Desks != 36 || rows["manor"].Carry != (gamemap.Carry{Kept: 1}) {
		t.Fatalf("template list: %+v", rows)
	}

	// Bia is online: she is disconnected to reconnect into the new map
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.ts.URL, "http")+"/ws", &websocket.DialOptions{HTTPClient: member.c})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	closed := make(chan websocket.StatusCode, 1)
	go func() {
		for {
			if _, _, err := c.Read(context.Background()); err != nil {
				closed <- websocket.CloseStatus(err)
				return
			}
		}
	}()
	time.Sleep(200 * time.Millisecond) // admitted
	r.st.SaveBoard(context.Background(), 1, "49,15", []byte(`[{"o":1,"i":1,"k":1,"c":0,"w":0,"p":[1,1],"tx":"x"}]`))
	r.st.SaveLastPos(context.Background(), 1, bia, 900, 500) // where she stood on the Loft, offline or not

	if code, out := admin.do("POST", "/api/admin/map/template", map[string]string{"template": "manor"}); code != http.StatusOK {
		t.Fatalf("apply: %d %v", code, out)
	}
	select {
	case code := <-closed:
		if code != 4003 {
			t.Fatalf("closed with %d, want 4003 (reconnect)", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the online member was not moved into the new map")
	}

	o, err := r.st.OfficeByID(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	var lastX *float64
	if err := r.st.DB.QueryRow(`SELECT last_x FROM memberships WHERE office_id=1 AND user_id=?`, bia).Scan(&lastX); err != nil || lastX != nil {
		t.Fatalf("a position on the old map is forgotten, so she comes back at the new entrance: %v %v", lastX, err)
	}
	if boards, _ := r.st.LoadBoards(context.Background(), 1); len(boards) != 0 {
		t.Fatalf("stored whiteboards belong to the old map: %v", boards)
	}
	var m gamemap.Map
	json.Unmarshal([]byte(o.MapJSON), &m)
	if m.W != 85 || m.H != 51 {
		t.Fatalf("stored map is %dx%d", m.W, m.H)
	}
	for _, p := range m.Props {
		if p.T == "desk" && (p.Label == "Desk 2") != (p.Assign == bia) {
			t.Fatalf("Desk 2 of the Manor goes to Bia, nothing else: %+v", p)
		}
	}
	if rows := list(); !rows["manor"].Current || rows["loft"].Current {
		t.Fatalf("Manor is now current: %+v", rows)
	}
	_, out := admin.do("GET", "/api/admin/audit", nil)
	b, _ := json.Marshal(out)
	if !strings.Contains(string(b), `"action":"map.template"`) || !strings.Contains(string(b), "template=manor") || !strings.Contains(string(b), "kept=1 lost=0") {
		t.Fatalf("audit: %s", b)
	}
	// back to a smaller one: the world takes any size, Bia keeps Desk 2
	if code, out := admin.do("POST", "/api/admin/map/template", map[string]string{"template": "lodge"}); code != http.StatusOK {
		t.Fatalf("apply lodge: %d %v", code, out)
	}
}
