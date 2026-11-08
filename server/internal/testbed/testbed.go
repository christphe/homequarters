// Package testbed starts the real Home Quarters server in-process for tests: dev mode, no LiveKit, a
// database of its own, the given plugin folders loaded and enabled. Next to the server's own routes
// it serves a few test-only endpoints under /api/testbed/, which only this package registers:
//
//	POST /api/testbed/position {"id":N,"x":tx,"y":ty}  saved position of an offline member, at a tile
//	GET  /api/testbed/kv/{plugin}                     a plugin's stored keys and values
//	PUT  /api/testbed/kv/{plugin}                     replaces them, while the plugin is disabled
//	GET  /api/testbed/errors                          {"<plugin>": count} of "plugin error" logs
//
// The server stays authoritative: placement writes where an offline member stood, the world restores
// it when they join; a connected member is never moved. It refuses to start with HQ_ENV=production, and
// on any address but loopback.
package testbed

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"homequarters/internal/config"
	"homequarters/internal/gamemap"
	"homequarters/internal/httpapi"
	"homequarters/internal/media"
	"homequarters/internal/plugin"
	"homequarters/internal/store"
	"homequarters/internal/world"
)

// Options configures a testbed. Plugins are plugin folders (a folder whose parent is named bundled
// is a bundled plugin, any other an installed one). Addr defaults to 127.0.0.1:0 (a free port); an
// address that is not loopback is refused.
// Static, when set, is a built web client (web/dist) to serve. DB, when set, is kept after Close (a
// restart test reopens it); otherwise the database lives in a temporary folder removed by Close. Log
// receives the server's logs (none when nil).
type Options struct {
	Plugins []string
	Addr    string
	Static  string
	DB      string
	Log     *slog.Logger
}

// Bed is a running testbed. URL is its base address, http://127.0.0.1:PORT.
type Bed struct {
	URL string

	db     string // database file
	tmp    string // temporary folder to remove on Close, "" when the database was given
	st     *store.Store
	srv    *httpapi.Server
	hs     *http.Server
	cancel context.CancelFunc
	served chan struct{}
	office int64
	names  map[string]bool // the loaded plugins
	errs   *errCounter

	mu   sync.Mutex
	live map[int64]int       // open sockets per member
	left map[int64]time.Time // when a member's last socket closed

	once     sync.Once
	closeErr error
}

const (
	officeSlug = "default"
	// cookie names of internal/httpapi (the current one and the one it still accepts)
	sessionCookie       = "hq_session"
	legacySessionCookie = "tilework_session"
	maxKVBody           = 1 << 20
)

// linger is how long a member who closed their socket may still stand in the world (the reconnect
// grace), plus a margin for the server to save where they left: no placement before it ends.
var linger = world.DefaultConfig().Grace + time.Second

// Start opens the database, enables every plugin given (with an audit row by the testbed), and serves
// the server until Close or until ctx ends. A plugin that cannot run makes Start fail.
func Start(ctx context.Context, o Options) (bed *Bed, err error) {
	if env := os.Getenv("HQ_ENV"); env != "" && env != "dev" {
		return nil, fmt.Errorf("the testbed is for tests: it refuses HQ_ENV=%s", env)
	}
	log := o.Log
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	errs := &errCounter{n: map[string]int{}}
	log = slog.New(&countHandler{inner: log.Handler(), c: errs})

	cat := plugin.LoadDirs(o.Plugins)
	var broken []string
	names := map[string]bool{}
	for _, i := range cat {
		if i.Err != "" {
			broken = append(broken, fmt.Sprintf("%s (%s): %s", i.Name, i.Dir, i.Err))
			continue
		}
		names[i.Name] = true
	}
	if len(broken) > 0 {
		return nil, fmt.Errorf("plugins that cannot run: %s", strings.Join(broken, "; "))
	}

	b := &Bed{db: o.DB, names: names, errs: errs, live: map[int64]int{}, left: map[int64]time.Time{}, served: make(chan struct{})}
	if b.db == "" {
		if b.tmp, err = os.MkdirTemp("", "hq-testbed-*"); err != nil {
			return nil, err
		}
		b.db = filepath.Join(b.tmp, "testbed.db")
	}
	defer func() {
		if err != nil { // undo what was opened
			if b.st != nil {
				b.st.Close()
			}
			if b.tmp != "" {
				os.RemoveAll(b.tmp)
			}
		}
	}()
	if b.st, err = store.Open(b.db); err != nil {
		return nil, err
	}
	mj, _ := json.Marshal(gamemap.Default())
	office, err := b.st.EnsureOffice(ctx, officeSlug, "Testbed", string(mj))
	if err != nil {
		return nil, err
	}
	b.office = office.ID
	for _, i := range cat {
		if err = b.st.SetPluginEnabled(ctx, office.ID, i.Name, true); err != nil {
			return nil, err
		}
		if err = b.st.Audit(ctx, office.ID, 0, "plugin.enable", 0, i.Name, "testbed"); err != nil {
			return nil, err
		}
	}

	addr := o.Addr
	if addr == "" {
		addr = "127.0.0.1:0"
	}
	ln, err := listen(addr)
	if err != nil {
		return nil, err
	}
	tcp := ln.Addr().(*net.TCPAddr)
	if !tcp.IP.IsLoopback() { // all interfaces (0.0.0.0, ":0") included
		ln.Close()
		return nil, fmt.Errorf("the testbed listens on this machine only: %s is not a loopback address (its test endpoints have no authentication)", addr)
	}
	b.URL = "http://" + net.JoinHostPort(tcp.IP.String(), strconv.Itoa(tcp.Port))

	cfg := &config.Config{Env: "dev", Addr: tcp.String(), DBPath: b.db, StaticDir: o.Static, PluginDirs: o.Plugins,
		OfficeSlug: officeSlug, OfficeName: "Testbed", SessionTTL: 24 * time.Hour, TickHz: 15, AOICells: 2,
		MaxPlayers: 100, MaxGroup: 8, JoinRate: 5000, MediaTTL: 30 * time.Second, MediaReconcile: time.Hour}
	sctx, cancel := context.WithCancel(context.Background())
	b.cancel = cancel
	b.srv = httpapi.New(sctx, cfg, log, b.st, media.New(media.Config{}, log))
	b.hs = &http.Server{Handler: b.handler(b.srv.Handler()), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		defer close(b.served)
		if err := b.hs.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("testbed server", "err", err)
		}
	}()
	go func() {
		select {
		case <-ctx.Done():
			b.Close()
		case <-sctx.Done():
		}
	}()
	log.Info("testbed listening", "url", b.URL, "plugins", len(cat))
	return b, nil
}

// Close stops the server gracefully (worlds save where everybody stood, plugins unload), closes the
// database and removes it unless it was given. It may be called more than once.
func (b *Bed) Close() error {
	b.once.Do(func() {
		b.cancel()
		sctx, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		errs := []error{b.hs.Shutdown(sctx)}
		<-b.served
		wctx, wc := context.WithTimeout(context.Background(), 10*time.Second)
		defer wc()
		errs = append(errs, b.srv.Wait(wctx), b.st.Close())
		if b.tmp != "" {
			errs = append(errs, os.RemoveAll(b.tmp))
		}
		b.closeErr = errors.Join(errs...)
	})
	return b.closeErr
}

// handler serves the test-only endpoints, and everything else through the real server, noting which
// members have a socket open.
func (b *Bed) handler(real http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/testbed/position", b.position)
	mux.HandleFunc("GET /api/testbed/kv/{plugin}", b.getKV)
	mux.HandleFunc("PUT /api/testbed/kv/{plugin}", b.putKV)
	mux.HandleFunc("GET /api/testbed/errors", b.errorCounts)
	mux.HandleFunc("/api/testbed/", http.NotFound)
	mux.Handle("GET /ws", b.track(real))
	mux.Handle("/", real)
	return mux
}

// track counts the open sockets of each member around the real /ws handler, which returns when the
// socket ends.
func (b *Bed) track(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			c, err = r.Cookie(legacySessionCookie)
		}
		var uid int64
		if err == nil {
			if se, err := b.st.LookupSession(r.Context(), c.Value); err == nil {
				uid = se.UserID
			}
		}
		if uid == 0 { // the real handler refuses it
			next.ServeHTTP(w, r)
			return
		}
		b.mu.Lock()
		b.live[uid]++
		b.mu.Unlock()
		defer func() {
			b.mu.Lock()
			b.live[uid]--
			if b.live[uid] == 0 {
				delete(b.live, uid)
				b.left[uid] = time.Now()
			}
			b.mu.Unlock()
		}()
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// position writes the saved position of an offline member at the centre of a tile: the world puts
// them there when they join. 409 while they are in the world (socket open, or within the reconnect
// grace after it closed, with Retry-After).
func (b *Bed) position(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID   int64 `json:"id"`
		X, Y *int
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil || body.ID <= 0 || body.X == nil || body.Y == nil {
		fail(w, http.StatusBadRequest, `body is {"id":member,"x":tileX,"y":tileY}`)
		return
	}
	ctx := r.Context()
	var one int
	if err := b.st.DB.QueryRowContext(ctx, `SELECT 1 FROM memberships WHERE office_id=? AND user_id=?`, b.office, body.ID).Scan(&one); err != nil {
		fail(w, http.StatusNotFound, "no such member")
		return
	}
	office, err := b.st.OfficeByID(ctx, b.office)
	if err != nil {
		fail(w, http.StatusInternalServerError, "office")
		return
	}
	var m gamemap.Map
	if err := json.Unmarshal([]byte(office.MapJSON), &m); err != nil {
		fail(w, http.StatusInternalServerError, "office map")
		return
	}
	cm, err := gamemap.Compile(&m)
	if err != nil {
		fail(w, http.StatusInternalServerError, "office map")
		return
	}
	tx, ty := *body.X, *body.Y
	switch {
	case tx < 0 || ty < 0 || tx >= m.W || ty >= m.H:
		fail(w, http.StatusBadRequest, fmt.Sprintf("tile (%d,%d) is outside the %dx%d map", tx, ty, m.W, m.H))
		return
	case cm.IsSolidTile(tx, ty):
		fail(w, http.StatusBadRequest, fmt.Sprintf("tile (%d,%d) is solid: the member would join at the spawn", tx, ty))
		return
	}
	b.mu.Lock()
	online := b.live[body.ID] > 0
	leftAt, left := b.left[body.ID]
	b.mu.Unlock()
	if online {
		fail(w, http.StatusConflict, "the member is connected: the server never moves a connected member; place them before they join")
		return
	}
	if since := time.Since(leftAt); left && since < linger {
		w.Header().Set("Retry-After", strconv.Itoa(int((linger-since)/time.Second)+1))
		fail(w, http.StatusConflict, "the member just left and may still stand in the world (reconnect grace): try again after Retry-After seconds")
		return
	}
	const T = gamemap.TilePx
	if err := b.st.SaveLastPos(ctx, b.office, body.ID, float64(tx*T+T/2), float64(ty*T+T/2)); err != nil {
		fail(w, http.StatusInternalServerError, "save position")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (b *Bed) getKV(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("plugin")
	if !b.names[name] {
		fail(w, http.StatusNotFound, "no such plugin")
		return
	}
	kv, err := b.st.PluginKV(r.Context(), b.office, name)
	if err != nil {
		fail(w, http.StatusInternalServerError, "read plugin data")
		return
	}
	if kv == nil {
		kv = map[string]string{}
	}
	writeJSON(w, http.StatusOK, kv)
}

// putKV replaces a plugin's stored keys and values. Only while the plugin is disabled (an
// administrator's PUT /api/admin/plugins/{name}): a running plugin keeps its data in memory, and
// enabling it loads what is stored.
func (b *Bed) putKV(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("plugin")
	if !b.names[name] {
		fail(w, http.StatusNotFound, "no such plugin")
		return
	}
	var kv map[string]string
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxKVBody)).Decode(&kv); err != nil || kv == nil {
		fail(w, http.StatusBadRequest, "body is a JSON object of string values")
		return
	}
	ctx := r.Context()
	flags, err := b.st.PluginFlags(ctx, b.office)
	if err != nil {
		fail(w, http.StatusInternalServerError, "read plugin flags")
		return
	}
	if flags[name] {
		fail(w, http.StatusConflict, "the plugin is enabled: disable it first (PUT /api/admin/plugins/"+name+" {\"enabled\":false})")
		return
	}
	// what the plugin wrote before it stopped (its unload included) is queued for the database: let it
	// land first, or it would overwrite the data put here
	if err := b.srv.KVSettled(ctx, b.office, name); err != nil {
		fail(w, http.StatusServiceUnavailable, "the plugin's last writes are still being saved")
		return
	}
	old, err := b.st.PluginKV(ctx, b.office, name)
	if err != nil {
		fail(w, http.StatusInternalServerError, "read plugin data")
		return
	}
	for k := range old {
		if _, keep := kv[k]; keep {
			continue
		}
		if err := b.st.DeletePluginKV(ctx, b.office, name, k); err != nil {
			fail(w, http.StatusInternalServerError, "delete plugin data")
			return
		}
	}
	for k, v := range kv {
		if err := b.st.PutPluginKV(ctx, b.office, name, k, v); err != nil {
			fail(w, http.StatusInternalServerError, "write plugin data")
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (b *Bed) errorCounts(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, b.errs.snapshot())
}

// errCounter counts the host's "plugin error" log records per plugin.
type errCounter struct {
	mu sync.Mutex
	n  map[string]int
}

func (c *errCounter) add(name string) {
	c.mu.Lock()
	c.n[name]++
	c.mu.Unlock()
}

func (c *errCounter) snapshot() map[string]int {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]int, len(c.n))
	for k, v := range c.n {
		out[k] = v
	}
	return out
}

// countHandler passes records to the inner handler and counts "plugin error" records by their
// plugin attribute, whatever the inner handler's level.
type countHandler struct {
	inner slog.Handler
	c     *errCounter
	attrs []slog.Attr // from WithAttrs
}

func (h *countHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return l >= slog.LevelWarn || h.inner.Enabled(ctx, l)
}

func (h *countHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Message == "plugin error" {
		name := ""
		for _, a := range h.attrs {
			if a.Key == "plugin" {
				name = a.Value.String()
			}
		}
		r.Attrs(func(a slog.Attr) bool {
			if a.Key == "plugin" {
				name = a.Value.String()
				return false
			}
			return true
		})
		h.c.add(name)
	}
	if !h.inner.Enabled(ctx, r.Level) {
		return nil
	}
	return h.inner.Handle(ctx, r)
}

func (h *countHandler) WithAttrs(as []slog.Attr) slog.Handler {
	return &countHandler{inner: h.inner.WithAttrs(as), c: h.c, attrs: append(append([]slog.Attr(nil), h.attrs...), as...)}
}

func (h *countHandler) WithGroup(name string) slog.Handler {
	return &countHandler{inner: h.inner.WithGroup(name), c: h.c, attrs: h.attrs}
}

// blockedPorts are the ports browsers and fetch refuse to connect to (the Fetch standard's "bad ports" at or
// above 1024, the only ones an OS hands out for port 0): a free port among them would make every call fail.
var blockedPorts = map[int]bool{1719: true, 1720: true, 1723: true, 2049: true, 3659: true, 4045: true, 4190: true,
	5060: true, 5061: true, 6000: true, 6566: true, 6665: true, 6666: true, 6667: true, 6668: true, 6669: true,
	6679: true, 6697: true, 10080: true}

// listen listens on addr; for port 0 it asks again while the OS gives a port a browser would refuse.
func listen(addr string) (net.Listener, error) { return listenWith(net.Listen, addr) }

func listenWith(netListen func(network, addr string) (net.Listener, error), addr string) (net.Listener, error) {
	for range 20 {
		ln, err := netListen("tcp", addr)
		if err != nil {
			return nil, err
		}
		_, port, _ := net.SplitHostPort(addr)
		if port != "0" || !blockedPorts[ln.Addr().(*net.TCPAddr).Port] {
			return ln, nil
		}
		defer ln.Close() // held until a good one is found, so the OS does not hand the same one back
	}
	return nil, fmt.Errorf("no free port outside the ports browsers refuse after 20 tries")
}
