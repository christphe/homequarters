package httpapi

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"homequarters/internal/config"
)

func withPlugins(c *config.Config) { c.PluginsDir = filepath.Join("testdata", "plugins") }

// socket is a game connection that keeps every text frame it receives.
type socket struct {
	c      *websocket.Conn
	mu     sync.Mutex
	frames []string
}

func (u *user) socket(t *testing.T) *socket {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(u.r.ts.URL, "http")+"/ws", &websocket.DialOptions{HTTPClient: u.c})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	s := &socket{c: c}
	go func() {
		for {
			_, b, err := c.Read(context.Background())
			if err != nil {
				return
			}
			s.mu.Lock()
			s.frames = append(s.frames, string(b))
			s.mu.Unlock()
		}
	}()
	return s
}

func (s *socket) send(t *testing.T, msg string) {
	t.Helper()
	if err := s.c.Write(context.Background(), websocket.MessageText, []byte(msg)); err != nil {
		t.Fatal(err)
	}
}

func (s *socket) count(sub string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, f := range s.frames {
		if strings.Contains(f, sub) {
			n++
		}
	}
	return n
}

func (s *socket) wait(t *testing.T, sub string, n int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for s.count(sub) < n {
		if time.Now().After(deadline) {
			t.Fatalf("no %d frame(s) containing %s", n, sub)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (u *user) raw(method, path string, body []byte) (int, http.Header, string) {
	u.r.t.Helper()
	req, _ := http.NewRequest(method, u.r.ts.URL+path, bytes.NewReader(body))
	resp, err := u.c.Do(req)
	if err != nil {
		u.r.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, string(b)
}

func TestPluginsOffByDefault(t *testing.T) {
	r := newRig(t, nil)
	ana, _ := r.join("Ana", "")
	if code, _, body := ana.raw("GET", "/api/plugins", nil); code != 200 || strings.TrimSpace(body) != "[]" {
		t.Fatalf("/api/plugins: %d %s", code, body)
	}
	if code, _, body := ana.raw("GET", "/api/admin/plugins", nil); code != 200 || strings.TrimSpace(body) != "[]" {
		t.Fatalf("/api/admin/plugins: %d %s", code, body)
	}
	if code, _, _ := ana.raw("GET", "/plugins/echo/assets/client.js", nil); code != 404 {
		t.Fatalf("asset with plugins off: %d", code)
	}
}

func TestEnablePluginEndToEnd(t *testing.T) {
	r := newRig(t, withPlugins)
	ana, _ := r.join("Ana", "") // admin
	bia, _ := r.join("Bia", "")
	sa, sb := ana.socket(t), bia.socket(t)
	sa.wait(t, `"t":"hello"`, 1)
	sb.wait(t, `"t":"hello"`, 1)

	_, _, list := ana.raw("GET", "/api/admin/plugins", nil)
	if !strings.Contains(list, `"name":"echo"`) || !strings.Contains(list, `"state":"disabled"`) || !strings.Contains(list, `"state":"broken"`) {
		t.Fatalf("admin list: %s", list)
	}
	if code, _ := bia.do("PUT", "/api/admin/plugins/echo", map[string]any{"enabled": true}); code != 403 {
		t.Fatalf("member enabling: %d", code)
	}
	if code, _ := ana.do("PUT", "/api/admin/plugins/broken", map[string]any{"enabled": true}); code != 409 {
		t.Fatalf("enabling a broken plugin: %d", code)
	}
	if code, _ := ana.do("PUT", "/api/admin/plugins/nope", map[string]any{"enabled": true}); code != 404 {
		t.Fatalf("enabling an unknown plugin: %d", code)
	}
	if code, out := ana.do("PUT", "/api/admin/plugins/echo", map[string]any{"enabled": true}); code != 200 || out["state"] != "running" {
		t.Fatalf("enable: %d %v", code, out)
	}
	sb.wait(t, `{"t":"plgs"}`, 1)
	if _, _, body := bia.raw("GET", "/api/plugins", nil); !strings.Contains(body, `"client":"/plugins/echo/client.js"`) {
		t.Fatalf("/api/plugins: %s", body)
	}
	if _, _, audit := ana.raw("GET", "/api/admin/audit", nil); !strings.Contains(audit, "plugin.enable") {
		t.Fatalf("audit: %s", audit)
	}

	// socket messages reach the plugin, its answer goes to the sender only
	sb.send(t, `{"t":"plg","pl":"echo","d":{"v":"hi"}}`)
	sb.wait(t, `"pl":"echo","d":{"echo":"hi"}`, 1)
	sb.send(t, `{"t":"plg","pl":"echo","d":{"v":"`+strings.Repeat("x", 1600)+`"}}`) // over 1500 bytes: ignored
	sb.send(t, `{"t":"plg","pl":"echo","d":{"v":"bye"}}`)
	sb.wait(t, `"echo":"bye"`, 1)
	if sa.count(`"echo"`) != 0 || sb.count(`xxxx`) != 0 {
		t.Fatal("echo reached the wrong socket or the oversized message went through")
	}

	// routes
	if code, _, body := bia.raw("GET", "/plugins/echo/api/hello", nil); code != 200 || !strings.Contains(body, `"kv":"bye"`) {
		t.Fatalf("route: %d %s", code, body)
	}
	anon := &user{r: r, c: &http.Client{}}
	if code, _, _ := anon.raw("GET", "/plugins/echo/api/hello", nil); code != 401 {
		t.Fatalf("route without session: %d", code)
	}
	if code, _, body := bia.raw("POST", "/plugins/echo/api/echo", []byte("abc")); code != 201 || body != "abc" {
		t.Fatalf("POST route: %d %s", code, body)
	}
	if code, _, _ := bia.raw("POST", "/plugins/echo/api/echo", bytes.Repeat([]byte("x"), 16<<10+1)); code != 413 {
		t.Fatalf("oversized POST: %d", code)
	}
	if code, _, _ := bia.raw("GET", "/plugins/echo/api/nope", nil); code != 404 {
		t.Fatalf("unknown route: %d", code)
	}

	// assets: public/ only, readable without a session (the sandboxed iframe sends no cookie)
	// the browser code, compiled by the server (TypeScript or JavaScript)
	if code, h, body := anon.raw("GET", "/plugins/echo/client.js", nil); code != 200 || !strings.HasPrefix(h.Get("Content-Type"), "text/javascript") || h.Get("Access-Control-Allow-Origin") != "*" || !strings.Contains(body, "hq.onLoad") {
		t.Fatalf("compiled client: %d %v %s", code, h, body)
	}
	if _, _, body := bia.raw("GET", "/api/plugins", nil); !strings.Contains(body, `"objects":[{"kind":"box","label":"Box","size":[1,2],"sprite":"box.png"}]`) || !strings.Contains(body, `"views":["board"]`) {
		t.Fatalf("/api/plugins objects and views: %s", body)
	}
	if code, h, body := anon.raw("GET", "/plugins/echo/views/board.js", nil); code != 200 || !strings.HasPrefix(h.Get("Content-Type"), "text/javascript") || h.Get("Access-Control-Allow-Origin") != "*" || h.Get("ETag") == "" || !strings.Contains(body, "__view") {
		t.Fatalf("compiled view: %d %v %s", code, h, body)
	}
	for _, p := range []string{"/plugins/echo/views/nope.js", "/plugins/echo/views/board", "/plugins/echo/views/board.png", "/plugins/nope/views/board.js"} {
		if code, _, _ := anon.raw("GET", p, nil); code != 404 {
			t.Errorf("%s: %d", p, code)
		}
	}
	code, h, body := anon.raw("GET", "/plugins/echo/assets/client.js", nil)
	if code != 200 || h.Get("Access-Control-Allow-Origin") != "*" || !strings.HasPrefix(h.Get("Content-Type"), "text/javascript") || h.Get("Cache-Control") != "no-cache" || !strings.Contains(body, "hq.onLoad") {
		t.Fatalf("client.js: %d %v %s", code, h, body)
	}
	for _, p := range []string{"main.ts", "../main.ts", "..%2Fmain.ts", "plugin.json", "missing.png"} {
		if code, _, _ := anon.raw("GET", "/plugins/echo/assets/"+p, nil); code != 404 {
			t.Errorf("asset %s: %d", p, code)
		}
	}

	// disable
	if code, _ := ana.do("PUT", "/api/admin/plugins/echo", map[string]any{"enabled": false}); code != 200 {
		t.Fatalf("disable: %d", code)
	}
	sb.wait(t, `{"t":"plgs"}`, 2)
	for _, p := range []string{"/plugins/echo/api/hello", "/plugins/echo/assets/client.js", "/plugins/echo/client.js", "/plugins/echo/views/board.js"} {
		if code, _, _ := bia.raw("GET", p, nil); code != 404 {
			t.Errorf("%s after disable: %d", p, code)
		}
	}
	if _, _, body := bia.raw("GET", "/api/plugins", nil); strings.TrimSpace(body) != "[]" {
		t.Fatalf("/api/plugins after disable: %s", body)
	}
	if _, _, audit := ana.raw("GET", "/api/admin/audit", nil); !strings.Contains(audit, "plugin.disable") {
		t.Fatalf("audit: %s", audit)
	}
}

func TestEnabledPluginAndItsDataSurviveARestart(t *testing.T) {
	r := newRig(t, withPlugins)
	ana, _ := r.join("Ana", "")
	ana.do("PUT", "/api/admin/plugins/echo", map[string]any{"enabled": true})
	s := ana.socket(t)
	s.send(t, `{"t":"plg","pl":"echo","d":{"v":"kept"}}`)
	s.wait(t, `"echo":"kept"`, 1)
	time.Sleep(200 * time.Millisecond) // the write goes through the persistence queue

	// a second server on the same database
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	srv2 := New(ctx, r.cfg, log, r.st, r.srv.media)
	ts2 := httptest.NewServer(srv2.Handler())
	t.Cleanup(ts2.Close)
	r2 := &rig{t: t, ts: ts2, st: r.st, cfg: r.cfg, srv: srv2}
	ana2 := &user{r: r2, c: ana.c}
	if code, _, body := ana2.raw("GET", "/plugins/echo/api/hello", nil); code != 200 || !strings.Contains(body, `"kv":"kept"`) {
		t.Fatalf("after restart: %d %s", code, body)
	}
}

func TestPluginPathsNeverReachTheSPAOrStartTheWorld(t *testing.T) {
	static := t.TempDir()
	if err := os.WriteFile(filepath.Join(static, "index.html"), []byte("<html>spa</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := newRig(t, func(c *config.Config) { withPlugins(c); c.StaticDir = static })
	anon := &user{r: r, c: &http.Client{}}
	if code, _, _ := anon.raw("GET", "/plugins/echo/assets/client.js", nil); code != 404 {
		t.Fatalf("asset of a plugin nobody enabled: %d", code)
	}
	r.srv.mu.Lock()
	started := len(r.srv.worlds)
	r.srv.mu.Unlock()
	if started != 0 {
		t.Fatal("an anonymous asset request started the office world")
	}
	for _, p := range []string{"/plugins/echo/assets/../main.ts", "/plugins/echo/main.ts", "/plugins/echo/plugin.json", "/plugins/", "/plugins/x"} {
		if code, _, body := anon.raw("GET", p, nil); code != 404 || strings.Contains(body, "spa") {
			t.Errorf("%s: %d %q", p, code, body)
		}
	}
}

func TestPluginRouteLimiterKeysOnlyRunningPlugins(t *testing.T) {
	r := newRig(t, withPlugins)
	ana, _ := r.join("Ana", "")
	for i := 0; i < 50; i++ {
		if code, _, _ := ana.raw("GET", "/plugins/rnd"+strconv.Itoa(i)+"/api/x", nil); code != 404 {
			t.Fatalf("unknown plugin route: %d", code)
		}
	}
	r.srv.plugLim.mu.Lock()
	n := len(r.srv.plugLim.m)
	r.srv.plugLim.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d limiter entries for plugins that do not exist", n)
	}
}

func bearer(r *rig, method, path, tok, body string) (int, string) {
	r.t.Helper()
	req, _ := http.NewRequest(method, r.ts.URL+path, strings.NewReader(body))
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestAppTokens(t *testing.T) {
	r := newRig(t, withPlugins)
	ana, _ := r.join("Ana", "")
	bia, _ := r.join("Bia", "")
	if code, _ := ana.do("GET", "/api/plugins/echo/token", nil); code != 404 {
		t.Fatalf("token of a plugin that is not running: %d", code)
	}
	ana.do("PUT", "/api/admin/plugins/echo", map[string]any{"enabled": true})
	if code, out := bia.do("GET", "/api/plugins/echo/token", nil); code != 200 || out["exists"] != false {
		t.Fatalf("no token yet: %d %v", code, out)
	}
	code, out := bia.do("POST", "/api/plugins/echo/token", nil)
	tok, _ := out["token"].(string)
	if code != 200 || !strings.HasPrefix(tok, "hqp_") {
		t.Fatalf("create: %d %v", code, out)
	}
	if code, out := bia.do("GET", "/api/plugins/echo/token", nil); code != 200 || out["exists"] != true || out["token"] != nil {
		t.Fatalf("info must never return the token: %d %v", code, out)
	}
	if _, _, audit := ana.raw("GET", "/api/admin/audit", nil); !strings.Contains(audit, "plugin.token.create") || strings.Contains(audit, tok) {
		t.Fatalf("audit: %s", audit)
	}

	// an app outside the browser calls the token route as Bia
	if code, body := bearer(r, "POST", "/plugins/echo/api/state", tok, "hp=3"); code != 200 || !strings.Contains(body, `"id":`+strconv.FormatInt(bia.ID, 10)) || !strings.Contains(body, "hp=3") {
		t.Fatalf("token route: %d %s", code, body)
	}
	if code, _ := bearer(r, "POST", "/plugins/echo/api/state", "", "x"); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := bearer(r, "POST", "/plugins/echo/api/state", "hqp_"+strings.Repeat("A", 43), "x"); code != 401 {
		t.Fatalf("wrong token: %d", code)
	}
	if code, _ := bearer(r, "GET", "/plugins/echo/api/hello", tok, ""); code != 401 {
		t.Fatalf("a token on a route without { token: true }: %d", code)
	}
	if code, _, _ := bia.raw("POST", "/plugins/echo/api/state", []byte("s")); code != 200 {
		t.Fatalf("the session still works on a token route: %d", code)
	}

	// revoke
	if code, _ := bia.do("DELETE", "/api/plugins/echo/token", nil); code != 200 {
		t.Fatalf("revoke: %d", code)
	}
	if code, _ := bearer(r, "POST", "/plugins/echo/api/state", tok, "x"); code != 401 {
		t.Fatalf("revoked token: %d", code)
	}
	// a removed member's token stops working
	_, out = ana.do("POST", "/api/plugins/echo/token", nil)
	anaTok := out["token"].(string)
	if code, _ := bearer(r, "POST", "/plugins/echo/api/state", anaTok, "x"); code != 200 {
		t.Fatalf("ana's token: %d", code)
	}
	_, out = bia.do("POST", "/api/plugins/echo/token", nil)
	biaTok := out["token"].(string)
	if code, _ := ana.do("DELETE", "/api/admin/members/"+strconv.FormatInt(bia.ID, 10), nil); code != 200 {
		t.Fatalf("remove bia: %d", code)
	}
	if code, _ := bearer(r, "POST", "/plugins/echo/api/state", biaTok, "x"); code != 401 {
		t.Fatalf("removed member's token: %d", code)
	}
	// disabled plugin: its routes are gone, tokens too
	ana.do("PUT", "/api/admin/plugins/echo", map[string]any{"enabled": false})
	if code, _ := bearer(r, "POST", "/plugins/echo/api/state", anaTok, "x"); code != 404 {
		t.Fatalf("disabled plugin: %d", code)
	}
}

// An installed plugin using the reserved hq- prefix is listed, refused and never served, even under
// the name of the bundled plugin it imitates; enabling that name runs the bundled one.
func TestPluginNameRefusalNoRoutes(t *testing.T) {
	r := newRig(t, func(c *config.Config) { c.PluginsDir = filepath.Join("testdata", "plugins-twin") })
	ana, _ := r.join("Ana", "")
	_, _, list := ana.raw("GET", "/api/admin/plugins", nil)
	for _, want := range []string{
		`"title":"Twin (bundled)","version":"1.0.0","description":"The bundled one.","state":"disabled","error":"","source":"bundled","refused":false`,
		`"state":"broken"`, `"source":"installed","refused":true`, `reserved for plugins bundled`,
	} {
		if !strings.Contains(list, want) {
			t.Fatalf("admin list lacks %s: %s", want, list)
		}
	}
	if code, out := ana.do("PUT", "/api/admin/plugins/hq-twin", map[string]any{"enabled": true}); code != 200 || out["state"] != "running" {
		t.Fatalf("enable: %d %v", code, out)
	}
	if code, _, body := ana.raw("GET", "/plugins/hq-twin/api/who", nil); code != 200 || !strings.Contains(body, "bundled") {
		t.Fatalf("route: %d %s", code, body)
	}
	if code, _, _ := ana.raw("GET", "/plugins/hq-twin/assets/only.json", nil); code != 404 {
		t.Fatalf("the refused folder's asset was served: %d", code)
	}
	if _, _, body := ana.raw("GET", "/api/plugins", nil); strings.Count(body, `"name":"hq-twin"`) != 1 {
		t.Fatalf("/api/plugins: %s", body)
	}
}

// A plugins folder with neither bundled/ nor installed/ means plugins are off, as with no folder.
func TestPluginsOffWithoutSides(t *testing.T) {
	r := newRig(t, func(c *config.Config) { c.PluginsDir = t.TempDir() })
	ana, _ := r.join("Ana", "")
	if code, _, body := ana.raw("GET", "/api/admin/plugins", nil); code != 200 || strings.TrimSpace(body) != "[]" {
		t.Fatalf("/api/admin/plugins: %d %s", code, body)
	}
}

// An administrator sets a plugin's declared settings in the admin dialog: checked against the manifest,
// stored, in the activity log, and seen at once by the running plugin.
func TestPluginSettingsFromTheAdminDialog(t *testing.T) {
	r := newRig(t, withPlugins)
	ana, _ := r.join("Ana", "") // admin
	bia, _ := r.join("Bia", "")
	_, _, list := ana.raw("GET", "/api/admin/plugins", nil)
	if !strings.Contains(list, `"settings":[{"key":"limit","label":"Limit","min":0,"max":8,"value":3}]`) {
		t.Fatalf("the admin list shows the declared setting with its default: %s", list)
	}
	if code, out := ana.do("PUT", "/api/admin/plugins/echo", map[string]any{"enabled": true}); code != 200 {
		t.Fatalf("enable: %d %v", code, out)
	}
	set := func(u *user, body map[string]any) int {
		code, _ := u.do("PUT", "/api/admin/plugins/echo/settings", body)
		return code
	}
	if code := set(bia, map[string]any{"key": "limit", "value": 5}); code != 403 {
		t.Fatalf("a member: %d", code)
	}
	for _, bad := range []map[string]any{{"key": "limit", "value": 9}, {"key": "limit", "value": 2.5}, {"key": "nope", "value": 1}, {"key": "limit"}} {
		if code := set(ana, bad); code != 400 {
			t.Fatalf("%v: %d", bad, code)
		}
	}
	if code := set(ana, map[string]any{"key": "limit", "value": 5}); code != 200 {
		t.Fatalf("set: %d", code)
	}
	if _, _, body := ana.raw("GET", "/plugins/echo/api/settings", nil); !strings.Contains(body, `"limit":5`) {
		t.Fatalf("the running plugin sees the new value: %s", body)
	}
	if _, _, list := ana.raw("GET", "/api/admin/plugins", nil); !strings.Contains(list, `"value":5`) {
		t.Fatalf("the admin list shows it: %s", list)
	}
	if _, _, audit := ana.raw("GET", "/api/admin/audit", nil); !strings.Contains(audit, "plugin.settings") || !strings.Contains(audit, "limit=5") {
		t.Fatalf("it is in the activity log: %s", audit)
	}
	if code := set(ana, map[string]any{"key": "limit", "value": 1}); code != 200 {
		t.Fatal(code)
	}
	if code, _ := ana.do("PUT", "/api/admin/plugins/nope/settings", map[string]any{"key": "limit", "value": 1}); code != 404 {
		t.Fatalf("an unknown plugin: %d", code)
	}
}
