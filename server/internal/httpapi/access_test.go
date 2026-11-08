package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"
)

// joinWith posts this body to /api/join as a new browser and returns that browser and the status.
func (r *rig) joinWith(body string) (*user, int) {
	r.t.Helper()
	jar, _ := cookiejar.New(nil)
	u := &user{r: r, c: &http.Client{Jar: jar}}
	resp, err := u.c.Post(r.ts.URL+"/api/join", "application/json", strings.NewReader(body))
	if err != nil {
		r.t.Fatal(err)
	}
	resp.Body.Close()
	return u, resp.StatusCode
}

// Invites as an office without sign-in uses them (dev mode, as the browser suite's server ran): who may
// mint one, how many joins it allows, the role it carries, and the bounds /api/join puts on what it is sent.
func TestInvitesAndJoinBoundsThroughTheAPI(t *testing.T) {
	r := newRig(t, nil)
	admin, _ := r.join("Ana", "") // the office's first member is its admin
	anon := &user{r: r, c: &http.Client{}}
	if code, _ := anon.do("POST", "/api/invites", map[string]any{}); code != http.StatusUnauthorized {
		t.Fatalf("anonymous callers cannot create invites: %d", code)
	}
	member, _ := r.join("Membro", "")
	if code, _ := member.do("POST", "/api/invites", map[string]any{"role": "member"}); code != http.StatusForbidden {
		t.Fatalf("a member cannot create invites: %d", code)
	}
	code, inv := admin.do("POST", "/api/invites", map[string]any{"role": "member", "maxUses": 2, "hours": 1})
	tok, _ := inv["token"].(string)
	if code != 200 || len(tok) < 30 {
		t.Fatalf("an admin creates an invite: %d %v", code, inv)
	}

	j1, c1 := r.join("Conv1", tok)
	_, c2 := r.join("Conv2", tok)
	_, c3 := r.join("Conv3", tok)
	if c1 != 200 || c2 != 200 || c3 != http.StatusForbidden {
		t.Fatalf("an invite works for its allowed number of uses only: %d/%d/%d", c1, c2, c3)
	}
	if _, code := r.join("X", "not-a-real-token"); code != http.StatusForbidden {
		t.Fatalf("an unknown invite is rejected: %d", code)
	}
	if _, me := j1.do("GET", "/api/me", nil); me["role"] != "member" || me["authenticated"] != true {
		t.Fatalf("the invited person gets the invite's role (member): %v", me)
	}
	_, admInv := admin.do("POST", "/api/invites", map[string]any{"role": "admin", "maxUses": 1, "hours": 1})
	ja, _ := r.join("SegundoAdmin", admInv["token"].(string))
	if _, me := ja.do("GET", "/api/me", nil); me["role"] != "admin" {
		t.Fatalf("an admin invite creates an administrator: %v", me)
	}

	body, _ := json.Marshal(map[string]any{"name": strings.Repeat("N", 500), "avatar": map[string]int{"sk": 999, "hs": -4}})
	long, code := r.joinWith(string(body))
	_, me := long.do("GET", "/api/me", nil)
	av, _ := me["avatar"].(map[string]any)
	if name, _ := me["name"].(string); code != 200 || len([]rune(name)) > 24 || av["sk"] != float64(0) || av["hs"] != float64(0) {
		t.Fatalf("names are bounded and avatar fields clamped by the server: %d %v", code, me)
	}
	if _, code := r.joinWith(string(bytes.Repeat([]byte("x"), 100000))); code != http.StatusBadRequest {
		t.Fatalf("an oversized request body is rejected: %d", code)
	}
}
