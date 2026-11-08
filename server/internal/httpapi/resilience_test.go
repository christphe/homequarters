package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// stopper is the rig's stop: cancel the server's context, then wait for its worlds and writers, as main does.
func stopper(t *testing.T, cancel context.CancelFunc, srv *Server) func() {
	return func() {
		cancel()
		ctx, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		if err := srv.Wait(ctx); err != nil {
			t.Fatal("server did not stop:", err)
		}
	}
}

// restart stops r's server and starts another on the same database and configuration, as a process restart does.
func (r *rig) restart() *rig {
	r.t.Helper()
	r.stop()
	r.ts.Close()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx, cancel := context.WithCancel(context.Background())
	r.t.Cleanup(cancel)
	srv := New(ctx, r.cfg, log, r.st, r.srv.media)
	ts := httptest.NewServer(srv.Handler())
	r.t.Cleanup(ts.Close)
	return &rig{t: r.t, ts: ts, st: r.st, cfg: r.cfg, srv: srv, stop: stopper(r.t, cancel, srv)}
}

// on is u with the same cookies, talking to another server (after a restart).
func (u *user) on(r *rig) *user { return &user{r: r, c: u.c, ID: u.ID} }

// placeAt makes u's next connection start at pixel (x, y): where the world puts a member who left there.
func (u *user) placeAt(t *testing.T, x, y float64) {
	t.Helper()
	o, err := u.r.st.OfficeBySlug(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	if err := u.r.st.SaveLastPos(context.Background(), o.ID, u.ID, x, y); err != nil {
		t.Fatal(err)
	}
}

type helloMsg struct {
	You int64 `json:"you"`
	Cfg struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
	} `json:"cfg"`
	Chat []struct {
		F int64  `json:"f"`
		N string `json:"n"`
		X string `json:"x"`
	} `json:"chat"`
}

func (s *socket) hello(t *testing.T) helloMsg {
	t.Helper()
	s.wait(t, `{"t":"hello"`, 1)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range s.frames {
		if strings.HasPrefix(f, `{"t":"hello"`) {
			var h helloMsg
			if err := json.Unmarshal([]byte(f), &h); err != nil {
				t.Fatal(err)
			}
			return h
		}
	}
	panic("unreachable")
}

// locate asks the server where player id stands.
func (s *socket) locate(t *testing.T, id int64) (float64, float64) {
	t.Helper()
	n := s.count(`"t":"loc"`)
	s.send(t, `{"t":"loc","id":`+strconv.FormatInt(id, 10)+`}`)
	s.wait(t, `"t":"loc"`, n+1)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, v := range slices.Backward(s.frames) {
		if strings.Contains(v, `"t":"loc"`) {
			var l struct {
				OK bool    `json:"ok"`
				X  float64 `json:"x"`
				Y  float64 `json:"y"`
			}
			if err := json.Unmarshal([]byte(v), &l); err != nil {
				t.Fatal(err)
			}
			if !l.OK {
				t.Fatalf("locate %d: %s", id, v)
			}
			return l.X, l.Y
		}
	}
	panic("unreachable")
}

// walk sends an input for d, then a stop, and says where the server put the player.
func (s *socket) walk(t *testing.T, id int64, dx int, d time.Duration) (float64, float64) {
	t.Helper()
	s.send(t, `{"t":"in","s":1,"x":`+strconv.Itoa(dx)+`,"y":0}`)
	time.Sleep(d)
	s.send(t, `{"t":"in","s":2,"x":0,"y":0}`)
	time.Sleep(300 * time.Millisecond)
	return s.locate(t, id)
}

func TestOversizedFrameClosesWith1009AndNoSessionIs401(t *testing.T) {
	r := newRig(t, nil)
	ana, _ := r.join("Ana", "")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.ts.URL, "http")+"/ws", &websocket.DialOptions{HTTPClient: ana.c})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err := c.Write(ctx, websocket.MessageText, []byte(strings.Repeat("x", 4000))); err != nil { // over the 2 KB frame limit
		t.Fatal(err)
	}
	for {
		if _, _, err = c.Read(ctx); err != nil {
			break
		}
	}
	if code := websocket.CloseStatus(err); code != websocket.StatusMessageTooBig {
		t.Fatalf("an oversized frame closes the connection with 1009: %v (%v)", code, err)
	}

	resp, err := request(t, http.MethodGet, r.ts.URL+"/ws")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("/ws without a session: %d", resp.StatusCode)
	}
}

// A client flooding inputs, with a speed of its own in each, moves no faster than the configured speed:
// the server takes a direction only. The flood may trip the rate limit and close the socket; the client
// comes back as the browser's does, and keeps flooding.
func TestInputFloodCannotOutrunTheServerSpeed(t *testing.T) {
	r := newRig(t, nil)
	ana, _ := r.join("Ana", "")
	ana.placeAt(t, 6*16+8, 20*16+8)
	s := ana.socket(t)
	s.hello(t)
	x0, y0 := s.locate(t, ana.ID)
	seq := 5000
	reconnects := 0
	for end := time.Now().Add(2 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		for range 20 {
			seq++
			msg := []byte(`{"t":"in","s":` + strconv.Itoa(seq) + `,"x":1,"y":0,"speed":9999}`)
			if err := s.c.Write(context.Background(), websocket.MessageText, msg); err != nil {
				s = ana.socket(t)
				reconnects++
				break
			}
		}
	}
	if err := s.c.Write(context.Background(), websocket.MessageText, []byte(`{"t":"in","s":99999,"x":0,"y":0}`)); err != nil {
		ana.socket(t).send(t, `{"t":"in","s":99999,"x":0,"y":0}`)
	}
	time.Sleep(600 * time.Millisecond)
	s = ana.socket(t) // a fresh connection answers whatever the flood did to the last one
	x1, y1 := s.locate(t, ana.ID)
	dist := math.Hypot(x1-x0, y1-y0)
	t.Logf("moved %.1f px in about 2.6 s, %d reconnects", dist, reconnects)
	if dist > 72*2.9 {
		t.Fatalf("flooding inputs moved the player %.1f px in about 2.6 s (limit about 209)", dist)
	}
}

// Where somebody stood is kept across a restart, whether they left before it (their reconnect grace ran
// out) or were still within their grace when the server stopped; their session survives too.
func TestPositionAndSessionSurviveARestart(t *testing.T) {
	r := newRig(t, nil)
	r.srv.grace = 300 * time.Millisecond
	ana, _ := r.join("Ana", "")
	bia, _ := r.join("Bia", "")
	ana.placeAt(t, 20*16+8, 30*16+8)
	bia.placeAt(t, 20*16+8, 32*16+8)
	sa, sb := ana.socket(t), bia.socket(t)
	sa.hello(t)
	sb.hello(t)
	ax, ay := sa.walk(t, ana.ID, 1, 500*time.Millisecond)
	bx, by := sb.walk(t, bia.ID, -1, 500*time.Millisecond)
	if ax < 20*16+8+20 || bx > 20*16+8-20 {
		t.Fatalf("setup: both walked away from where they started: ana %v,%v bia %v,%v", ax, ay, bx, by)
	}

	// Ana leaves and her grace runs out: her place is written while the server runs
	sa.c.Close(websocket.StatusNormalClosure, "")
	o, _ := r.st.OfficeBySlug(context.Background(), "default")
	saved := func(id int64) (x, y float64) {
		if err := r.st.DB.QueryRow(`SELECT last_x, last_y FROM memberships WHERE office_id=? AND user_id=?`, o.ID, id).Scan(&x, &y); err != nil {
			t.Fatal(err)
		}
		return
	}
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if x, y := saved(ana.ID); math.Hypot(x-ax, y-ay) < 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the place of somebody whose grace ran out is saved")
		}
	}
	// Bia's connection drops and the server stops within her grace
	sb.c.Close(websocket.StatusNormalClosure, "")
	r2 := r.restart()

	for _, c := range []struct {
		u    *user
		x, y float64
	}{{ana, ax, ay}, {bia, bx, by}} {
		u := c.u.on(r2)
		h := u.socket(t).hello(t)
		if h.You != u.ID {
			t.Fatalf("the session survives a restart: hello for %d, want %d", h.You, u.ID)
		}
		if math.Hypot(h.Cfg.X-c.x, h.Cfg.Y-c.y) >= 3 {
			t.Fatalf("member %d re-enters at %v,%v after a restart, left at %v,%v", u.ID, h.Cfg.X, h.Cfg.Y, c.x, c.y)
		}
	}
}

// A burst of 30 chat messages cannot flood the office: about 8 get through.
func TestChatFloodIsRateLimited(t *testing.T) {
	r := newRig(t, nil)
	ana, _ := r.join("Ana", "")
	bia, _ := r.join("Bia", "")
	sa, sb := ana.socket(t), bia.socket(t)
	sa.hello(t)
	sb.hello(t)
	for i := range 30 {
		sa.send(t, `{"t":"chat","sc":"o","text":"flood `+strconv.Itoa(i)+`"}`)
	}
	time.Sleep(1500 * time.Millisecond)
	if got := sb.count(`"x":"flood `); got == 0 || got > 10 {
		t.Fatalf("30 sent, a burst of about 8 accepted: %d delivered", got)
	}
}

// A newcomer gets the office chat, never a direct message, and the office chat survives a restart.
func TestOfficeChatHistoryReachesNewcomersAndSurvivesARestart(t *testing.T) {
	r := newRig(t, nil)
	ana, _ := r.join("Ana", "")
	bia, _ := r.join("Bia", "")
	sa, sb := ana.socket(t), bia.socket(t)
	sa.hello(t)
	sb.hello(t)
	sa.send(t, `{"t":"chat","sc":"o","text":"  hello office  "}`)
	sa.send(t, `{"t":"chat","sc":"d","id":`+strconv.FormatInt(bia.ID, 10)+`,"text":"secret between A and B"}`)
	sb.wait(t, `secret between A and B`, 1)

	inHistory := func(h helloMsg) (office, secret bool) {
		for _, c := range h.Chat {
			office = office || (c.X == "hello office" && c.N == "Ana" && c.F == ana.ID)
			secret = secret || strings.Contains(c.X, "secret")
		}
		return
	}
	dan, _ := r.join("Dan", "")
	if office, secret := inHistory(dan.socket(t).hello(t)); !office || secret {
		t.Fatalf("a newcomer receives the office chat (%v) and no direct message (%v)", office, secret)
	}
	o, _ := r.st.OfficeBySlug(context.Background(), "default")
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if rows, _ := r.st.RecentChat(context.Background(), o.ID, 10); len(rows) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the office chat is written")
		}
	}
	r2 := r.restart()
	eve, _ := r2.join("Eve", "")
	if office, secret := inHistory(eve.socket(t).hello(t)); !office || secret {
		t.Fatalf("after a restart the office chat is still there (%v), no direct message (%v)", office, secret)
	}
}

func TestProfileRefusesAnEmptyNameAndAnonymousCallers(t *testing.T) {
	r := newRig(t, nil)
	ana, _ := r.join("Ana", "")
	if code, _ := ana.do("PUT", "/api/profile", map[string]any{"name": "   ", "avatar": map[string]any{}}); code != http.StatusBadRequest {
		t.Fatalf("an empty name: %d", code)
	}
	anon := &user{r: r, c: &http.Client{}}
	if code, _ := anon.do("PUT", "/api/profile", map[string]any{"name": "x"}); code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", code)
	}
}
