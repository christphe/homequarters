// Package httpapi wires HTTP endpoints, WebSocket sessions, health checks and metrics.
package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"homequarters/internal/auth"
	"homequarters/internal/config"
	"homequarters/internal/gamemap"
	"homequarters/internal/media"
	"homequarters/internal/store"
	"homequarters/internal/world"
)

const cookieName = "hq_session"

// legacyCookieName is the session cookie from before the rename to Home
// Quarters (ADR 0024); moveLegacySession carries it over so nobody signs in again.
const legacyCookieName = "tilework_session"

type Server struct {
	cfg *config.Config
	// version names this deploy (commit, or a hash of the built page); clients on another version reload
	version string
	log     *slog.Logger
	st      *store.Store
	media   *media.Client
	ctx     context.Context

	mu     sync.Mutex
	worlds map[int64]*world.World
	// mapMu orders map changes (admin edits, desk claims) so the saved map is the one last applied.
	mapMu sync.Mutex

	posQ    chan posSave
	chatQ   chan chatSave
	boardQ  chan boardSave
	auditQ  chan actionSave
	workers sync.WaitGroup

	inst      string // installation id, namespaces SFU rooms
	joinLim   *limiter
	mapLim    *limiter
	profLim   *limiter
	adminLim  *limiter
	annLim    *limiter
	renameLim *limiter // office renames: each is a broadcast to everybody
	demoLim   *limiter

	// sign-in (HQ_AUTH_PROVIDERS); nil maps when it is off
	providers map[string]*auth.Provider
	fake      *auth.Fake
	sealer    *auth.Sealer // signs the cookies of sign-ins in progress
}

type chatSave struct {
	office, user int64
	text         string
	ts           int64
}

type boardSave struct {
	office int64
	key    string
	data   []byte
}

type actionSave struct {
	office, actor  int64
	action, target string
}

type posSave struct {
	office, user int64
	x, y         float64
}

func New(ctx context.Context, cfg *config.Config, log *slog.Logger, st *store.Store, md *media.Client) *Server {
	s := &Server{cfg: cfg, log: log, st: st, media: md, ctx: ctx, worlds: map[int64]*world.World{},
		posQ: make(chan posSave, 1024), chatQ: make(chan chatSave, 256), boardQ: make(chan boardSave, 64), joinLim: newLimiter(float64(cfg.JoinRate), float64(cfg.JoinRate)*2), mapLim: newLimiter(1, 5), profLim: newLimiter(0.5, 5), adminLim: newLimiter(5, 20), annLim: newLimiter(1.0/15, 2), renameLim: newLimiter(1.0/10, 3)}
	s.version = resolveVersion(cfg.Version, cfg.StaticDir)
	if cfg.AuthEnabled() {
		s.setupAuth()
	}
	log.Info("version", "v", s.version)
	if id, err := st.InstanceID(ctx); err == nil {
		s.inst = id
	} else {
		log.Error("instance id", "err", err)
	}
	s.auditQ = make(chan actionSave, 128)
	s.demoLim = newLimiter(0.2, 5) // demo: about one new account per 5 s per IP, burst 5
	s.workers.Add(1)
	go func() { defer s.workers.Done(); s.savePositions(ctx) }()
	go s.reconcileMedia(ctx)
	if cfg.Demo {
		if err := s.demoStartup(ctx); err != nil {
			log.Error("demo startup", "err", err)
		}
		go s.demoLoop(ctx)
	}
	return s
}

func (s *Server) savePositions(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			// leaves queued just before the stop are not lost
			fctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			for {
				select {
				case p := <-s.posQ:
					if err := s.st.SaveLastPos(fctx, p.office, p.user, p.x, p.y); err != nil {
						s.log.Error("save last position", "err", err)
					}
				default:
					return
				}
			}
		case b := <-s.boardQ:
			if err := s.st.SaveBoard(ctx, b.office, b.key, b.data); err != nil {
				s.log.Error("save whiteboard", "err", err) // never log the strokes
			}
		case a := <-s.auditQ:
			if err := s.st.Audit(ctx, a.office, a.actor, a.action, 0, a.target, ""); err != nil {
				s.log.Error("audit action", "err", err)
			}
		case c := <-s.chatQ:
			if err := s.st.AppendChat(ctx, c.office, c.user, c.text, c.ts); err != nil {
				s.log.Error("save chat", "err", err) // never log the message text
			}
		case p := <-s.posQ:
			if err := s.st.SaveLastPos(ctx, p.office, p.user, p.x, p.y); err != nil {
				s.log.Error("save last position", "err", err)
			}
		}
	}
}

// worldFor lazily starts the simulation goroutine for an office.
func (s *Server) worldFor(o *store.Office) (*world.World, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx.Err() != nil {
		return nil, s.ctx.Err()
	}
	if w, ok := s.worlds[o.ID]; ok {
		return w, nil
	}
	// the caller's row may predate a rename (or a map save); read it again under s.mu, which renames also hold
	if fresh, err := s.st.OfficeByID(s.ctx, o.ID); err == nil {
		o = fresh
	}
	var m gamemap.Map
	if err := json.Unmarshal([]byte(o.MapJSON), &m); err != nil {
		return nil, fmt.Errorf("office %d map: %w", o.ID, err)
	}
	cm, err := gamemap.Compile(&m)
	if err != nil {
		return nil, fmt.Errorf("office %d map: %w", o.ID, err)
	}
	wc := world.DefaultConfig()
	wc.TickHz, wc.AOICells, wc.MaxPlayers = s.cfg.TickHz, s.cfg.AOICells, s.cfg.MaxPlayers
	wc.Version = s.version
	wc.Prox.MaxGroup = s.cfg.MaxGroup
	if s.cfg.AOIMaxCells > 0 {
		wc.AOIMaxCells = s.cfg.AOIMaxCells
	}
	if wc.AOIMaxCells < wc.AOICells {
		wc.AOIMaxCells = wc.AOICells
	}
	w := world.New(wc, o.ID, o.Name, cm, s.media, s.log.With("office", o.ID))
	if s.inst != "" {
		w.RoomPrefix = s.inst + ".o" + strconv.FormatInt(o.ID, 10)
	}
	if rows, err := s.st.RecentChat(s.ctx, o.ID, 100); err == nil {
		h := make([]world.ChatEntry, 0, len(rows))
		for _, r := range rows {
			h = append(h, world.ChatEntry{From: uint32(r.UserID), Name: r.Name, Text: r.Text, TS: r.TS})
		}
		w.SeedChat(h)
	} else {
		s.log.Error("load chat history", "err", err)
	}
	if boards, err := s.st.LoadBoards(s.ctx, o.ID); err == nil {
		w.SeedBoards(boards)
	} else {
		s.log.Error("load whiteboards", "err", err)
	}
	w.OnBoardSave = func(office int64, key string, data []byte, final bool) bool {
		if final { // shutting down: the writer goroutine is gone, write here
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			return s.st.SaveBoard(ctx, office, key, data) == nil
		}
		select {
		case s.boardQ <- boardSave{office, key, data}:
			return true
		default:
			return false // busy: the world keeps the board dirty and tries again
		}
	}
	w.OnChat = func(office int64, from uint32, text string, ts int64) {
		select {
		case s.chatQ <- chatSave{office, int64(from), text, ts}:
		default: // history is best effort; never block the world loop
		}
	}
	w.OnAction = func(office int64, actor uint32, action, target string) {
		select {
		case s.auditQ <- actionSave{office, int64(actor), action, target}:
		default:
			s.log.Error("audit queue full")
		}
	}
	w.OnStop = func(office int64, last []world.LastPos) {
		ps := make([]store.LastPos, len(last))
		for i, p := range last {
			ps[i] = store.LastPos{UserID: int64(p.User), X: p.X, Y: p.Y}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second) // the server context is already done
		defer cancel()
		if err := s.st.SaveLastPositions(ctx, office, ps); err != nil {
			s.log.Error("save positions on stop", "err", err)
		}
	}
	w.OnLeave = func(office int64, user uint32, x, y float64) {
		select {
		case s.posQ <- posSave{office, int64(user), x, y}:
		default:
		}
	}
	s.workers.Add(1)
	go func() { defer s.workers.Done(); w.Run(s.ctx) }()
	s.worlds[o.ID] = w
	return w, nil
}

// Wait waits for world final snapshots after cancellation, before the database is closed or the process exits.
func (s *Server) Wait(ctx context.Context) error {
	done := make(chan struct{})
	go func() { s.workers.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /readyz", s.ready)
	mux.HandleFunc("GET /metrics", s.metrics)
	mux.HandleFunc("POST /api/join", s.join)
	// Before any session exists, so it cannot be an authenticated API call.
	mux.HandleFunc("GET /link/{token}", s.accountLink)
	s.authRoutes(mux)
	mux.HandleFunc("POST /api/account-link", s.newAccountLink)
	mux.HandleFunc("POST /api/invites", s.createInvite)
	mux.HandleFunc("GET /api/admin/members", s.listMembers)
	mux.HandleFunc("PATCH /api/admin/members/{id}", s.patchMember)
	mux.HandleFunc("DELETE /api/admin/members/{id}", s.deleteMember)
	mux.HandleFunc("GET /api/admin/invites", s.listInvites)
	mux.HandleFunc("DELETE /api/admin/invites/{id}", s.revokeInvite)
	mux.HandleFunc("GET /api/admin/audit", s.listAudit)
	mux.HandleFunc("POST /api/admin/announce", s.announce)
	mux.HandleFunc("PATCH /api/admin/office", s.renameOffice)
	mux.HandleFunc("GET /api/admin/map", s.getFullMap)
	mux.HandleFunc("PUT /api/map", s.putMap)
	mux.HandleFunc("POST /api/desk", func(w http.ResponseWriter, r *http.Request) { s.changeDesk(w, r, false) })
	mux.HandleFunc("POST /api/desk/release", func(w http.ResponseWriter, r *http.Request) { s.changeDesk(w, r, true) })
	mux.HandleFunc("PUT /api/profile", s.putProfile)
	mux.HandleFunc("GET /api/me", s.me)
	mux.HandleFunc("GET /about", s.about)
	mux.HandleFunc("GET /privacy", s.privacy)
	mux.HandleFunc("GET /ws", s.ws)
	if s.cfg.StaticDir != "" {
		mux.Handle("/", spa(s.cfg.StaticDir, s.version))
	}
	return secureHeaders(s.moveLegacySession(mux))
}

// moveLegacySession serves a request that carries only the old session cookie
// as if it carried the new one, and answers with the new cookie set and the
// old one cleared. The token itself is checked by the handlers as usual.
func (s *Server) moveLegacySession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := r.Cookie(cookieName); err == nil {
			next.ServeHTTP(w, r)
			return
		}
		old, err := r.Cookie(legacyCookieName)
		if err != nil || old.Value == "" {
			next.ServeHTTP(w, r)
			return
		}
		r = r.Clone(r.Context())
		r.AddCookie(&http.Cookie{Name: cookieName, Value: old.Value})
		s.setCookie(w, old.Value)
		http.SetCookie(w, &http.Cookie{Name: legacyCookieName, Value: "", Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: !s.cfg.Dev(), MaxAge: -1})
		next.ServeHTTP(w, r)
	})
}

func secureHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "same-origin")
		hd.Set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), idle-detection=(self), geolocation=()")
		h.ServeHTTP(w, r)
	})
}

// resolveVersion is the deploy's commit when one is given, otherwise a short hash of the built page
// (a new client build is a new version), or "dev" without a page.
func resolveVersion(commit, staticDir string) string {
	if v := strings.TrimSpace(commit); v != "" {
		return v
	}
	if staticDir != "" {
		if b, err := os.ReadFile(filepath.Join(staticDir, "index.html")); err == nil {
			sum := sha256.Sum256(b)
			return hex.EncodeToString(sum[:6])
		}
	}
	return "dev"
}

func spa(dir, version string) http.Handler {
	fsrv := http.FileServer(http.Dir(dir))
	meta := `<meta name="hq-version" content="` + html.EscapeString(version) + `">`
	page := func(w http.ResponseWriter) {
		b, err := os.ReadFile(filepath.Join(dir, "index.html"))
		if err != nil {
			http.Error(w, "client not built", http.StatusNotFound)
			return
		}
		// the page names the server's version: a client loaded from it reloads when hello says otherwise
		b = bytes.Replace(b, []byte("</head>"), []byte(meta+"</head>"), 1)
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(b)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			page(w)
			return
		}
		p := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if fi, err := os.Stat(p); err != nil || fi.IsDir() {
			if !strings.HasPrefix(r.URL.Path, "/assets/") {
				page(w)
				return
			}
		}
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable") // content-hashed names
		} else {
			// index.html and other unhashed files: revalidate on every load, or a browser may keep
			// running the previous client for hours after a deploy (heuristic caching from Last-Modified)
			w.Header().Set("Cache-Control", "no-cache")
		}
		fsrv.ServeHTTP(w, r)
	})
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.st.DB.PingContext(ctx); err != nil {
		http.Error(w, "db unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Write([]byte("ready"))
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func (s *Server) setCookie(w http.ResponseWriter, tok string) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: tok, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteLaxMode, Secure: !s.cfg.Dev(), MaxAge: int(s.cfg.SessionTTL.Seconds())})
}

type joinReq struct {
	Name   string          `json:"name"`
	Avatar json.RawMessage `json:"avatar"`
	Invite string          `json:"invite"`
}

// join creates a member. In production an invite is mandatory; in dev an invite-less join is allowed
// (the first member of an office becomes admin) to keep local development friction-free.
func (s *Server) join(w http.ResponseWriter, r *http.Request) {
	if !s.joinLim.Allow(clientIP(r)) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limited"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var req joinReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	name := store.CleanName(req.Name)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name required"})
		return
	}
	if s.cfg.AuthEnabled() { // nobody joins without an identity, not even in dev
		s.joinSignedIn(w, r, name, NormalizeAvatar(req.Avatar))
		return
	}
	var o *store.Office
	forced := ""
	var err error
	switch {
	case req.Invite != "":
		inv, ierr := s.st.ConsumeInvite(r.Context(), req.Invite)
		if ierr != nil {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "invite invalid, expired or exhausted"})
			return
		}
		forced = inv.Role
		o, err = s.st.OfficeByID(r.Context(), inv.OfficeID)
	case s.cfg.Demo:
		// Public sandbox: no invite, always a plain member (never the office's first admin), tight per-IP limit.
		if !s.demoLim.Allow(clientIP(r)) {
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limited"})
			return
		}
		forced = "member"
		o, err = s.st.OfficeBySlug(r.Context(), s.cfg.OfficeSlug)
	case s.cfg.Dev():
		o, err = s.st.OfficeBySlug(r.Context(), s.cfg.OfficeSlug)
	default:
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "join requires an invite"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "office unavailable"})
		return
	}
	uid, role, err := s.st.AddMember(r.Context(), o.ID, name, NormalizeAvatar(req.Avatar), forced)
	if err != nil {
		s.log.Error("add member", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	tok, err := s.st.CreateSession(r.Context(), uid, o.ID, s.cfg.SessionTTL)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	s.setCookie(w, tok)
	if req.Invite != "" {
		s.audit(r, &store.Session{UserID: uid, OfficeID: o.ID}, "member.join", uid, name, "role="+role)
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": uid, "name": name, "role": role})
}

// accountLink is how one person reaches their own account from a second
// machine. It is a plain URL rather than a form because it has to work before
// there is a session: the client asks /api/me on load, so setting the cookie
// and redirecting drops the browser straight into the office, with the same
// identity and no join screen. An invite cannot do this - an invite makes a
// new member, which is a second person, not a second machine.
func (s *Server) accountLink(w http.ResponseWriter, r *http.Request) {
	if !s.joinLim.Allow(clientIP(r)) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	tok, uid, oid, err := s.st.RedeemAccountLink(r.Context(), r.PathValue("token"), s.cfg.SessionTTL, s.cfg.AuthProviders)
	if err != nil {
		// This URL is a credential. Say that it did not work, never why.
		http.Error(w, "this link is not valid", http.StatusForbidden)
		return
	}
	s.setCookie(w, tok)
	s.audit(r, &store.Session{UserID: uid, OfficeID: oid}, "account.link.use", uid, "", "")
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// newAccountLink mints the caller's own link, and only ever their own: the
// user it belongs to comes from the session, never from the request, so there
// is no shape of this call that hands one person another person's account.
// Minting replaces the previous link, which is how it is revoked.
func (s *Server) newAccountLink(w http.ResponseWriter, r *http.Request) {
	if s.cfg.AuthEnabled() { // a member who signs in reaches their account from any machine already
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "personal links are replaced by sign-in"})
		return
	}
	se, err := s.session(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not signed in"})
		return
	}
	tok, err := s.st.CreateAccountLink(r.Context(), se.UserID, se.OfficeID)
	if err != nil {
		s.log.Error("account link", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	s.audit(r, se, "account.link.create", se.UserID, "", "self")
	writeJSON(w, http.StatusOK, map[string]any{"url": "/link/" + tok})
}

// session is the caller's session, for every endpoint that acts in the office.
// While sign-in is required, a session without an identity (a member from
// before sign-in) reaches nothing until it links one.
func (s *Server) session(r *http.Request) (*store.Session, error) {
	se, err := s.rawSession(r)
	if err != nil {
		return nil, err
	}
	if s.cfg.AuthEnabled() && !se.Linked {
		return nil, store.ErrNotFound
	}
	return se, nil
}

// rawSession is the session cookie's session, linked or not. Linked means an
// identity of a provider configured now: a member who only has one of a
// provider since removed links again, rather than being let in by it.
func (s *Server) rawSession(r *http.Request) (*store.Session, error) {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return nil, store.ErrNotFound
	}
	se, err := s.st.LookupSession(r.Context(), c.Value)
	if err != nil || !s.cfg.AuthEnabled() {
		return se, err
	}
	if se.Linked, err = s.st.HasIdentityFor(r.Context(), se.UserID, s.cfg.AuthProviders); err != nil {
		return nil, err
	}
	return se, nil
}

// me tells the client where it stands: in the office, or which screen to show
// first (sign-in buttons, the name form of a new identity, or linking).
func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	providers := s.cfg.AuthProviders
	if providers == nil {
		providers = []string{}
	}
	out := map[string]any{"authenticated": false, "dev": s.cfg.Dev(), "demo": s.demoInfo(), "auth": providers}
	se, err := s.rawSession(r)
	switch {
	case err == nil && (!s.cfg.AuthEnabled() || se.Linked):
		out["authenticated"], out["id"], out["name"], out["role"], out["avatar"] = true, se.UserID, se.Name, se.Role, se.Avatar
	case err == nil:
		out["link"] = map[string]string{"name": se.Name}
	default:
		if su, ok := s.pendingSignup(r); ok {
			out["signup"] = map[string]string{"email": su.Email}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

var errBadOrigin = errors.New("origin not allowed")

type inviteReq struct {
	Role    string `json:"role"`
	MaxUses int    `json:"maxUses"`
	Hours   int    `json:"hours"`
}

// createInvite lets an office admin mint an invite link with explicit access controls.
func (s *Server) createInvite(w http.ResponseWriter, r *http.Request) {
	se, err := s.session(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if se.Role != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin only"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var req inviteReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if req.Role == "" {
		req.Role = "member"
	}
	if req.MaxUses == 0 {
		req.MaxUses = 1
	}
	if req.Hours == 0 {
		req.Hours = 24
	}
	tok, err := s.st.CreateInvite(r.Context(), se.OfficeID, req.Role, req.MaxUses, time.Duration(req.Hours)*time.Hour, se.UserID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	s.log.Info("invite created", "by", se.UserID, "role", req.Role, "uses", req.MaxUses, "hours", req.Hours) // never logs the token
	s.audit(r, se, "invite.create", 0, "", "role="+req.Role+" uses="+strconv.Itoa(req.MaxUses)+" hours="+strconv.Itoa(req.Hours))
	writeJSON(w, http.StatusOK, map[string]any{"token": tok, "path": "/?invite=" + tok})
}

// putMap lets an admin replace the office map. The map is validated and compiled server-side
// (never trusted), persisted, then hot-swapped into the running world.
func (s *Server) putMap(w http.ResponseWriter, r *http.Request) {
	se, err := s.session(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if se.Role != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin only"})
		return
	}
	if !s.mapLim.Allow(strconv.FormatInt(se.UserID, 10)) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limited"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 512<<10)
	var m gamemap.Map
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid map json"})
		return
	}
	if err := gamemap.OnePlacePerPerson(&m); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	cm, err := gamemap.Compile(&m)
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	office, err := s.st.OfficeByID(r.Context(), se.OfficeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	wd, err := s.worldFor(office)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	s.mapMu.Lock()
	defer s.mapMu.Unlock()
	if err := wd.ReloadMap(r.Context(), cm); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	raw, _ := json.Marshal(&m)
	rev, err := s.st.SaveMap(r.Context(), office.ID, string(raw))
	if err != nil {
		s.log.Error("save map", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "map applied but not saved"})
		return
	}
	s.log.Info("map updated", "by", se.UserID, "rev", rev, "props", len(m.Props), "areas", len(m.Areas))
	s.audit(r, se, "map.update", 0, "", "rev="+strconv.FormatInt(rev, 10)+" props="+strconv.Itoa(len(m.Props))+" areas="+strconv.Itoa(len(m.Areas)))
	writeJSON(w, http.StatusOK, map[string]any{"rev": rev})
}

// claimReasons names, for the client, why the world refused a desk claim.
var claimReasons = map[error]string{
	world.ErrClaimOffline: "offline", world.ErrClaimNoDesk: "no_desk", world.ErrClaimFar: "far",
	world.ErrClaimTaken: "taken", world.ErrClaimRoom: "room", world.ErrClaimHasPlace: "has_place",
	world.ErrReleaseNotMine: "not_mine",
}

// changeDesk lets a member who has no desk or office take the free desk they stand next to, or
// (release) free their own desk from inside its room. The world checks all of it (presence,
// distance, the desk, one place per person) and applies it; the map is then saved like an admin
// edit, so the change survives a restart.
func (s *Server) changeDesk(w http.ResponseWriter, r *http.Request, release bool) {
	se, err := s.session(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !s.mapLim.Allow(strconv.FormatInt(se.UserID, 10)) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limited"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 256)
	var req struct {
		X int `json:"x"`
		Y int `json:"y"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	office, err := s.st.OfficeByID(r.Context(), se.OfficeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	s.mu.Lock()
	wd := s.worlds[office.ID]
	s.mu.Unlock()
	if wd == nil { // no world running means nobody is connected
		writeJSON(w, http.StatusConflict, map[string]string{"error": "offline"})
		return
	}
	s.mapMu.Lock()
	defer s.mapMu.Unlock()
	// Once the world applies the claim, it must be saved and logged even if the client goes away.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
	defer cancel()
	change, action := wd.ClaimDesk, "desk.claim"
	if release {
		change, action = wd.ReleaseDesk, "desk.release"
	}
	m, err := change(ctx, uint32(se.UserID), req.X, req.Y)
	if err != nil {
		if reason, ok := claimReasons[err]; ok {
			code := http.StatusConflict
			if err == world.ErrClaimNoDesk {
				code = http.StatusNotFound
			}
			writeJSON(w, code, map[string]string{"error": reason})
			return
		}
		s.log.Error("change desk", "action", action, "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	raw, _ := json.Marshal(m)
	rev, err := s.st.SaveMap(ctx, office.ID, string(raw))
	if err != nil {
		s.log.Error("save map", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "applied but not saved"})
		return
	}
	at := strconv.Itoa(req.X) + "," + strconv.Itoa(req.Y)
	s.log.Info("desk changed", "action", action, "by", se.UserID, "at", at, "rev", rev)
	if err := s.st.Audit(ctx, se.OfficeID, se.UserID, action, se.UserID, "", "at="+at+" rev="+strconv.FormatInt(rev, 10)); err != nil {
		s.log.Error("audit", "action", action, "err", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"x": req.X, "y": req.Y})
}

// putProfile lets a member change their own display name and avatar.
func (s *Server) putProfile(w http.ResponseWriter, r *http.Request) {
	se, err := s.session(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !s.profLim.Allow(strconv.FormatInt(se.UserID, 10)) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limited"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var req joinReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	name := store.CleanName(req.Name)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name required"})
		return
	}
	av := NormalizeAvatar(req.Avatar)
	if err := s.st.UpdateProfile(r.Context(), se.UserID, name, av); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	if office, err := s.st.OfficeByID(r.Context(), se.OfficeID); err == nil {
		if wd, err := s.worldFor(office); err == nil {
			wd.UpdateProfile(r.Context(), uint32(se.UserID), name, av)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": name, "avatar": json.RawMessage(av)})
}

// reconcileMedia periodically removes from the SFU anyone the world does not consider a member of that room.
func (s *Server) reconcileMedia(ctx context.Context) {
	if s.media == nil || !s.media.Enabled() {
		return
	}
	t := time.NewTicker(s.cfg.MediaReconcile)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.mu.Lock()
			ws := make(map[int64]*world.World, len(s.worlds))
			for id, w := range s.worlds {
				ws[id] = w
			}
			s.mu.Unlock()
			for id, w := range ws {
				rctx, cancel := context.WithTimeout(ctx, 8*time.Second)
				n, err := s.media.Reconcile(rctx, w.MediaPrefix()+".", w.MediaMembers)
				cancel()
				if err != nil {
					s.log.Warn("media reconcile", "office", id, "err", err)
				} else if n > 0 {
					s.log.Warn("removed unauthorised SFU participants", "office", id, "count", n)
				}
			}
		}
	}
}
