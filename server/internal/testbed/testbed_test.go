package testbed

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"homequarters/internal/gamemap"
)

var (
	echoDir    = filepath.Join("..", "httpapi", "testdata", "plugins", "installed", "echo")
	throwerDir = filepath.Join("testdata", "thrower")
)

type member struct {
	t   *testing.T
	bed *Bed
	c   *http.Client
	ID  int64
}

func join(t *testing.T, bed *Bed, name string) *member {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	m := &member{t: t, bed: bed, c: &http.Client{Jar: jar, Timeout: 10 * time.Second}}
	code, body := m.do("POST", "/api/join", map[string]any{"name": name})
	if code != http.StatusOK {
		t.Fatalf("join %s: %d %s", name, code, body)
	}
	var out struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.ID == 0 {
		t.Fatalf("join %s: %s", name, body)
	}
	m.ID = out.ID
	return m
}

// do sends a request with the member's cookie and returns the status and body.
func (m *member) do(method, path string, body any) (int, []byte) {
	m.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequestWithContext(m.t.Context(), method, m.bed.URL+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := m.c.Do(req)
	if err != nil {
		m.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func (m *member) socket(ctx context.Context) *websocket.Conn {
	m.t.Helper()
	u := "ws" + strings.TrimPrefix(m.bed.URL, "http") + "/ws"
	c, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPClient: m.c})
	if err != nil {
		m.t.Fatal(err)
	}
	c.SetReadLimit(1 << 22)
	return c
}

// standable finds a free tile of the default map, away from the spawn, in the spawn's area, with
// free neighbours: a saved position there is kept on join.
func standable(t *testing.T) (int, int) {
	t.Helper()
	cm, err := gamemap.Compile(gamemap.Default())
	if err != nil {
		t.Fatal(err)
	}
	sp := cm.Map.Spawn
	area := cm.AreaIndexAt(sp.X, sp.Y)
	free := func(x, y int) bool {
		for dy := -1; dy <= 1; dy++ {
			for dx := -1; dx <= 1; dx++ {
				if cm.IsSolidTile(x+dx, y+dy) {
					return false
				}
			}
		}
		return cm.AreaIndexAt(x, y) == area
	}
	for d := 3; d < 12; d++ {
		for _, p := range [][2]int{{sp.X + d, sp.Y}, {sp.X - d, sp.Y}, {sp.X, sp.Y + d}, {sp.X, sp.Y - d}} {
			if free(p[0], p[1]) {
				return p[0], p[1]
			}
		}
	}
	t.Fatal("no standable tile near the spawn")
	return 0, 0
}

func TestTestbed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	bed, err := Start(ctx, Options{Plugins: []string{echoDir, throwerDir}})
	if err != nil {
		t.Fatal(err)
	}
	dbDir := filepath.Dir(bed.db)
	closed := false
	defer func() {
		if !closed {
			bed.Close()
		}
	}()
	if !strings.HasPrefix(bed.URL, "http://127.0.0.1:") {
		t.Fatalf("URL %q", bed.URL)
	}

	ann := join(t, bed, "Ann")

	// placement: the saved position of an offline member, restored by the real join
	tx, ty := standable(t)
	if code, body := ann.do("POST", "/api/testbed/position", map[string]any{"id": ann.ID, "x": tx, "y": ty}); code != http.StatusNoContent {
		t.Fatalf("position: %d %s", code, body)
	}
	ws := ann.socket(ctx)
	defer ws.CloseNow()
	_, b, err := ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var hello struct {
		T   string `json:"t"`
		Cfg struct {
			X float64 `json:"x"`
			Y float64 `json:"y"`
		} `json:"cfg"`
	}
	if err := json.Unmarshal(b, &hello); err != nil || hello.T != "hello" {
		t.Fatalf("first message %s", b[:min(len(b), 200)])
	}
	if hello.Cfg.X != float64(tx*16+8) || hello.Cfg.Y != float64(ty*16+8) {
		t.Fatalf("hello at (%v,%v), want the centre of tile (%d,%d)", hello.Cfg.X, hello.Cfg.Y, tx, ty)
	}

	// a connected member is never moved
	if code, body := ann.do("POST", "/api/testbed/position", map[string]any{"id": ann.ID, "x": tx, "y": ty}); code != http.StatusConflict {
		t.Fatalf("position while online: %d %s", code, body)
	}
	// bad requests
	if code, _ := ann.do("POST", "/api/testbed/position", map[string]any{"id": 99999, "x": tx, "y": ty}); code != http.StatusNotFound {
		t.Fatalf("unknown member: %d", code)
	}
	if code, _ := ann.do("POST", "/api/testbed/position", map[string]any{"id": ann.ID, "x": -1, "y": ty}); code != http.StatusBadRequest {
		t.Fatalf("outside the map: %d", code)
	}

	// the plugins given are enabled and running, with an audit row by the testbed
	code, body := ann.do("GET", "/api/plugins", nil)
	if code != http.StatusOK || !strings.Contains(string(body), `"name":"echo"`) || !strings.Contains(string(body), `"name":"thrower"`) {
		t.Fatalf("/api/plugins: %d %s", code, body)
	}
	code, body = ann.do("GET", "/api/admin/audit", nil)
	if code != http.StatusOK || !strings.Contains(string(body), "plugin.enable") || !strings.Contains(string(body), "testbed") {
		t.Fatalf("audit: %d %s", code, body)
	}

	// plugin storage: read, and seeded only while the plugin is disabled
	code, body = ann.do("GET", "/api/testbed/kv/echo", nil)
	if code != http.StatusOK || strings.TrimSpace(string(body)) != "{}" {
		t.Fatalf("kv: %d %s", code, body)
	}
	if code, body := ann.do("PUT", "/api/testbed/kv/echo", map[string]string{"k": "seeded"}); code != http.StatusConflict {
		t.Fatalf("kv put while enabled: %d %s", code, body)
	}
	if code, body := ann.do("PUT", "/api/admin/plugins/echo", map[string]bool{"enabled": false}); code != http.StatusOK {
		t.Fatalf("disable: %d %s", code, body)
	}
	if code, body := ann.do("PUT", "/api/testbed/kv/echo", map[string]string{"k": "seeded", "other": "x"}); code != http.StatusNoContent {
		t.Fatalf("kv put: %d %s", code, body)
	}
	if code, body := ann.do("PUT", "/api/testbed/kv/echo", map[string]string{"k": "seeded"}); code != http.StatusNoContent {
		t.Fatalf("kv put: %d %s", code, body)
	}
	code, body = ann.do("GET", "/api/testbed/kv/echo", nil)
	var kv map[string]string
	if err := json.Unmarshal(body, &kv); err != nil {
		t.Fatal(err)
	}
	if code != http.StatusOK || len(kv) != 1 || kv["k"] != "seeded" {
		t.Fatalf("kv after a replace: %d %s", code, body)
	}
	if code, body := ann.do("PUT", "/api/admin/plugins/echo", map[string]bool{"enabled": true}); code != http.StatusOK {
		t.Fatalf("enable: %d %s", code, body)
	}
	code, body = ann.do("GET", "/plugins/echo/api/hello", nil)
	if code != http.StatusOK || !strings.Contains(string(body), `"kv":"seeded"`) {
		t.Fatalf("the plugin does not see the seeded value: %d %s", code, body)
	}
	if code, _ := ann.do("GET", "/api/testbed/kv/nosuch", nil); code != http.StatusNotFound {
		t.Fatalf("kv of an unknown plugin: %d", code)
	}

	// plugin errors are counted per plugin
	code, body = ann.do("GET", "/api/testbed/errors", nil)
	if code != http.StatusOK || strings.TrimSpace(string(body)) != "{}" {
		t.Fatalf("errors before: %d %s", code, body)
	}
	if code, _ := ann.do("GET", "/plugins/thrower/api/boom", nil); code < 500 {
		t.Fatalf("boom: %d", code)
	}
	code, body = ann.do("GET", "/api/testbed/errors", nil)
	var errs map[string]int
	if err := json.Unmarshal(body, &errs); err != nil {
		t.Fatal(err)
	}
	if code != http.StatusOK || errs["thrower"] != 1 || len(errs) != 1 {
		t.Fatalf("errors after: %d %s", code, body)
	}

	// a member who just left may still stand in the world (reconnect grace): still refused, with a delay
	ws.Close(websocket.StatusNormalClosure, "")
	for deadline := time.Now().Add(5 * time.Second); ; {
		pb, _ := json.Marshal(map[string]any{"id": ann.ID, "x": tx, "y": ty})
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, bed.URL+"/api/testbed/position", bytes.NewReader(pb))
		req.Header.Set("Content-Type", "application/json")
		resp, err := ann.c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if ra := resp.Header.Get("Retry-After"); resp.StatusCode == http.StatusConflict && ra != "" {
			if n, _ := strconv.Atoi(ra); n < 1 || n > 12 {
				t.Fatalf("Retry-After %q", ra)
			}
			break
		}
		if resp.StatusCode != http.StatusConflict || time.Now().After(deadline) {
			t.Fatalf("position right after leaving: %d, Retry-After %q", resp.StatusCode, resp.Header.Get("Retry-After"))
		}
		time.Sleep(20 * time.Millisecond)
	}

	closed = true
	if err := bed.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dbDir); !os.IsNotExist(err) {
		t.Fatalf("the temporary database folder is still there: %v", err)
	}
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, bed.URL+"/healthz", nil)
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
		t.Fatal("still listening after Close")
	}
}

func TestTestbedKeepsGivenDatabase(t *testing.T) {
	db := filepath.Join(t.TempDir(), "bed.db")
	bed, err := Start(context.Background(), Options{Plugins: []string{echoDir}, DB: db})
	if err != nil {
		t.Fatal(err)
	}
	if err := bed.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(db); err != nil {
		t.Fatalf("the given database is gone: %v", err)
	}
	// and a second bed opens it again
	bed, err = Start(context.Background(), Options{Plugins: []string{echoDir}, DB: db})
	if err != nil {
		t.Fatal(err)
	}
	bed.Close()
}

func TestTestbedRefusesProduction(t *testing.T) {
	t.Setenv("HQ_ENV", "production")
	bed, err := Start(context.Background(), Options{Plugins: []string{echoDir}})
	if err == nil {
		bed.Close()
		t.Fatal("started with HQ_ENV=production")
	}
}

func TestTestbedRefusesStaticWithoutClient(t *testing.T) {
	bed, err := Start(context.Background(), Options{Plugins: []string{echoDir}, Static: t.TempDir()})
	if err == nil {
		bed.Close()
		t.Fatal("started serving a folder with no index.html")
	}
	if !strings.Contains(err.Error(), "index.html") {
		t.Fatalf("the error does not say what is missing: %v", err)
	}
}

func TestTestbedRefusesBrokenPlugin(t *testing.T) {
	bed, err := Start(context.Background(), Options{Plugins: []string{filepath.Join("..", "httpapi", "testdata", "plugins", "installed", "broken")}})
	if err == nil {
		bed.Close()
		t.Fatal("started with a plugin that does not compile")
	}
	if !strings.Contains(err.Error(), "broken") {
		t.Fatalf("the error does not name the plugin: %v", err)
	}
}

func TestTestbedRefusesAnAddressBeyondLoopback(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:0", ":0"} {
		bed, err := Start(context.Background(), Options{Plugins: []string{echoDir}, Addr: addr})
		if err == nil {
			bed.Close()
			t.Fatalf("started on %s", addr)
		}
		if !strings.Contains(err.Error(), "loopback") {
			t.Fatalf("%s: the error does not say why: %v", addr, err)
		}
	}
	bed, err := Start(context.Background(), Options{Plugins: []string{echoDir}, Addr: "localhost:0"})
	if err != nil {
		t.Fatalf("localhost refused: %v", err)
	}
	bed.Close()
}

// The writes a plugin queues as it stops reach the database after the disable answered: a replacement
// of its data waits for them, or they would land on top of it.
func TestTestbedKVReplaceWaitsForQueuedWrites(t *testing.T) {
	bed, err := Start(context.Background(), Options{Plugins: []string{filepath.Join("testdata", "writer")}})
	if err != nil {
		t.Fatal(err)
	}
	defer bed.Close()
	ann := join(t, bed, "Ann")
	for i := range 3 {
		if code, body := ann.do("PUT", "/api/admin/plugins/writer", map[string]bool{"enabled": false}); code != http.StatusOK {
			t.Fatalf("disable: %d %s", code, body)
		}
		// at once, as seedKv does: the 600 writes of the plugin's unload may still be queued
		if code, body := ann.do("PUT", "/api/testbed/kv/writer", map[string]string{"seeded": "yes"}); code != http.StatusNoContent {
			t.Fatalf("kv put: %d %s", code, body)
		}
		time.Sleep(200 * time.Millisecond) // a write still queued would land meanwhile
		code, body := ann.do("GET", "/api/testbed/kv/writer", nil)
		var kv map[string]string
		if err := json.Unmarshal(body, &kv); err != nil {
			t.Fatal(err)
		}
		if code != http.StatusOK || len(kv) != 1 || kv["seeded"] != "yes" {
			t.Fatalf("round %d: %d keys after the replace, want only the seeded one (%d)", i, len(kv), code)
		}
		if code, body := ann.do("PUT", "/api/admin/plugins/writer", map[string]bool{"enabled": true}); code != http.StatusOK {
			t.Fatalf("enable: %d %s", code, body)
		}
	}
}

// The OS may hand out a port that fetch and browsers refuse (6000, 10080...): the testbed asks for another one,
// and keeps a port given explicitly.
func TestTestbedAvoidsPortsBrowsersRefuse(t *testing.T) {
	var given []int
	fake := func(ports ...int) func(string, string) (net.Listener, error) {
		return func(network, addr string) (net.Listener, error) {
			p := ports[len(given)]
			given = append(given, p)
			return fakeListener{port: p}, nil
		}
	}
	ln, err := listenWith(fake(6000, 10080, 51234), "127.0.0.1:0")
	if err != nil || ln.Addr().(*net.TCPAddr).Port != 51234 || len(given) != 3 {
		t.Fatalf("listen = %v, %v after %v; want port 51234 on the third try", ln, err, given)
	}
	given = nil
	if ln, err := listenWith(fake(6000), "127.0.0.1:6000"); err != nil || ln.Addr().(*net.TCPAddr).Port != 6000 {
		t.Fatalf("an explicit port is kept: %v, %v", ln, err)
	}
}

type fakeListener struct{ port int }

func (fakeListener) Accept() (net.Conn, error) { return nil, errors.New("fake") }
func (fakeListener) Close() error              { return nil }
func (l fakeListener) Addr() net.Addr          { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: l.port} }
