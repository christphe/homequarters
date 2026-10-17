package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"tilework/internal/auth"
	"tilework/internal/store"
)

// Sign-in with a provider (TILEWORK_AUTH_PROVIDERS). Without one, nothing here
// is routed and the office behaves as before: the session cookie is the account.
//
// With one, a person reaches the office only through an identity:
//
//	/auth/{p}/start -> provider -> /auth/{p}/callback -> known identity: session
//	                                                  -> new and admitted: name form, POST /api/join
//	                                                  -> session without identity: linked to it
//
// Admission of a new identity is either a verified address in an authorised
// domain or an invite. The invite is checked at the callback and spent only
// when the member is created.
//
// The server keeps no table of sign-ins in progress: the flow and the admitted
// identity travel in signed cookies (auth.Sealer), so no client can fill memory
// and lock others out.

const (
	stateCookie  = "tilework_auth_" // + the first characters of the state: one per tab
	signupCookie = "tilework_signup"
	flowTTL      = 10 * time.Minute
	signupTTL    = 30 * time.Minute
)

// flow is one sign-in between the redirect to the provider and its callback.
type flow struct {
	State       string `json:"s"`
	Provider    string `json:"p"`
	Verifier    string `json:"v"`
	Nonce       string `json:"n"`
	RedirectURI string `json:"r"`
	Invite      string `json:"i,omitempty"`
	Hint        string `json:"h,omitempty"`
	LinkUser    int64  `json:"l,omitempty"` // a member without identity who is linking one
}

// signup is a new identity that was admitted and has yet to pick a name.
type signup struct {
	Provider string `json:"p"`
	Subject  string `json:"s"`
	Email    string `json:"e"`
	Invite   string `json:"i,omitempty"`
	DomainOK bool   `json:"d,omitempty"`
}

func (su signup) identity() store.Identity {
	return store.Identity{Provider: su.Provider, Subject: su.Subject, Email: su.Email}
}

// setupAuth builds the configured providers. The fake one exchanges its codes
// with this very server, over the loopback address it listens on.
func (s *Server) setupAuth() {
	s.providers = map[string]*auth.Provider{}
	s.sealer = auth.NewSealer()
	for _, name := range s.cfg.AuthProviders {
		switch name {
		case "google":
			s.providers[name] = auth.Google(s.cfg.GoogleClientID, s.cfg.GoogleClientSecret)
		case auth.FakeName:
			domain := ""
			if len(s.cfg.AuthDomains) > 0 {
				domain = s.cfg.AuthDomains[0]
			}
			s.fake = auth.NewFake(domain)
			s.providers[name] = s.fake.Provider("http://" + loopback(s.cfg.Addr))
		}
	}
}

// loopback turns a listen address (":8080", "0.0.0.0:8080") into one to dial.
func loopback(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port)
}

func (s *Server) authRoutes(mux *http.ServeMux) {
	if !s.cfg.AuthEnabled() {
		return
	}
	mux.HandleFunc("GET /auth/{provider}/start", s.authStart)
	mux.HandleFunc("POST /api/signout", s.signOut)
	mux.HandleFunc("GET /auth/{provider}/callback", s.authCallback)
	if s.fake != nil {
		limited := func(h http.HandlerFunc) http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) {
				if !s.joinLim.Allow(clientIP(r)) {
					http.Error(w, "rate limited", http.StatusTooManyRequests)
					return
				}
				h(w, r)
			}
		}
		mux.HandleFunc("GET /auth/fake-oidc/authorize", limited(s.fake.Authorize))
		mux.HandleFunc("POST /auth/fake-oidc/authorize", limited(s.fake.Authorize))
		mux.HandleFunc("POST /auth/fake-oidc/token", limited(s.fake.Token))
	}
}

// redirectURI is the callback the provider sends the browser back to. Google
// needs the registered public address; the fake one, in dev, follows the host
// the browser used (the Vite proxy keeps it).
func (s *Server) redirectURI(r *http.Request, p *auth.Provider) string {
	base := s.cfg.PublicURL
	if base == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		base = scheme + "://" + r.Host
	}
	return base + "/auth/" + p.Name + "/callback"
}

func tokenLike(v string) bool {
	return v != "" && len(v) <= 128 && strings.Trim(v, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") == ""
}

// authDone sends the browser back to the app; code says what happened (the
// join screen explains it), empty when it simply worked. On a failure the
// invite and login hint the sign-in started with go back too, so a retry
// still carries them.
func authDone(w http.ResponseWriter, r *http.Request, code string, f *flow) {
	q := url.Values{}
	if code != "" {
		q.Set("auth", code)
	}
	if f != nil && code != "" && code != "linked" {
		if f.Invite != "" {
			q.Set("invite", f.Invite)
		}
		if f.Hint != "" {
			q.Set("login_hint", f.Hint)
		}
	}
	to := "/"
	if len(q) > 0 {
		to += "?" + q.Encode()
	}
	http.Redirect(w, r, to, http.StatusSeeOther)
}

func (s *Server) authCookie(w http.ResponseWriter, name, value, path string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: path, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: !s.cfg.Dev(), MaxAge: maxAge})
}

func flowCookie(state string) string {
	if len(state) > 12 {
		state = state[:12]
	}
	return stateCookie + state
}

func (s *Server) authStart(w http.ResponseWriter, r *http.Request) {
	p := s.providers[r.PathValue("provider")]
	if p == nil {
		http.NotFound(w, r)
		return
	}
	if !s.joinLim.Allow(clientIP(r)) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	f := flow{State: auth.Random(24), Provider: p.Name, Verifier: auth.Random(32), Nonce: auth.Random(24), RedirectURI: s.redirectURI(r, p)}
	q := r.URL.Query()
	if inv := q.Get("invite"); tokenLike(inv) {
		f.Invite = inv
	}
	if hint := q.Get("login_hint"); len(hint) <= 254 && strings.Contains(hint, "@") {
		f.Hint = hint
	}
	if se, err := s.rawSession(r); err == nil {
		if se.Linked {
			authDone(w, r, "", nil)
			return
		}
		f.LinkUser = se.UserID // a member from before sign-in: this sign-in attaches their identity
	}
	sealed, err := s.sealer.Seal("flow", f, flowTTL)
	if err != nil {
		authDone(w, r, "failed", &f)
		return
	}
	// The flow is bound to this browser: a callback carrying somebody else's
	// state (login CSRF) finds no matching cookie. One cookie per state, so two
	// tabs signing in at once do not overwrite each other.
	s.authCookie(w, flowCookie(f.State), sealed, "/auth/", int(flowTTL.Seconds()))
	http.Redirect(w, r, p.AuthCodeURL(f.RedirectURI, f.State, f.Nonce, f.Verifier, f.Hint), http.StatusSeeOther)
}

func (s *Server) authCallback(w http.ResponseWriter, r *http.Request) {
	p := s.providers[r.PathValue("provider")]
	if p == nil {
		http.NotFound(w, r)
		return
	}
	if !s.joinLim.Allow(clientIP(r)) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	q := r.URL.Query()
	state := q.Get("state")
	if state == "" || len(state) > 128 {
		authDone(w, r, "failed", nil)
		return
	}
	c, err := r.Cookie(flowCookie(state))
	s.authCookie(w, flowCookie(state), "", "/auth/", -1) // spent, whatever happens next
	var f flow
	if err != nil || s.sealer.Open("flow", c.Value, &f) != nil || f.State != state || f.Provider != p.Name {
		authDone(w, r, "failed", nil)
		return
	}
	if q.Get("error") != "" {
		authDone(w, r, "cancelled", &f)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	claims, err := p.Exchange(ctx, q.Get("code"), f.RedirectURI, f.Verifier, f.Nonce)
	if err != nil {
		s.log.Warn("sign-in failed", "provider", p.Name, "err", err) // our own wording: no code, token or address
		authDone(w, r, "failed", &f)
		return
	}
	office, err := s.st.OfficeBySlug(ctx, s.cfg.OfficeSlug)
	if err != nil {
		authDone(w, r, "failed", &f)
		return
	}
	id := store.Identity{Provider: p.Name, Subject: claims.Subject, Email: claims.Email}
	uid, err := s.st.UserByIdentity(ctx, office.ID, id.Provider, id.Subject)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.log.Error("identity lookup", "err", err)
		authDone(w, r, "failed", &f)
		return
	}
	found := err == nil

	if f.LinkUser != 0 {
		if found && uid != f.LinkUser {
			authDone(w, r, "taken", &f)
			return
		}
		switch err := s.st.LinkIdentity(ctx, office.ID, f.LinkUser, id); {
		case errors.Is(err, store.ErrIdentityTaken):
			authDone(w, r, "taken", &f)
			return
		case err != nil: // includes a membership removed while signing in
			authDone(w, r, "failed", &f)
			return
		}
		s.audit(r, &store.Session{UserID: f.LinkUser, OfficeID: office.ID}, "auth.link", f.LinkUser, "", "provider="+p.Name)
		authDone(w, r, "linked", &f)
		return
	}

	if found {
		tok, err := s.st.CreateSession(ctx, uid, office.ID, s.cfg.SessionTTL)
		if err != nil {
			authDone(w, r, "failed", &f)
			return
		}
		s.setCookie(w, tok)
		s.audit(r, &store.Session{UserID: uid, OfficeID: office.ID}, "auth.login", uid, "", "provider="+p.Name)
		authDone(w, r, "", &f)
		return
	}

	su := signup{Provider: id.Provider, Subject: id.Subject, Email: id.Email,
		DomainOK: claims.EmailVerified && claims.Domain != "" && slices.Contains(s.cfg.AuthDomains, claims.Domain)}
	if f.Invite != "" {
		if inv, err := s.st.InviteUsable(ctx, f.Invite); err == nil && inv.OfficeID == office.ID {
			su.Invite = f.Invite
		}
	}
	if !su.DomainOK && su.Invite == "" {
		f.Invite = "" // it did not admit them: showing it again would contradict the refusal
		authDone(w, r, "denied", &f)
		return
	}
	sealed, err := s.sealer.Seal("signup", su, signupTTL)
	if err != nil {
		authDone(w, r, "failed", &f)
		return
	}
	s.authCookie(w, signupCookie, sealed, "/", int(signupTTL.Seconds()))
	authDone(w, r, "", &f)
}

// pendingSignup is the admitted identity waiting for its name form, if any.
func (s *Server) pendingSignup(r *http.Request) (signup, bool) {
	var su signup
	if s.sealer == nil {
		return su, false
	}
	c, err := r.Cookie(signupCookie)
	if err != nil || s.sealer.Open("signup", c.Value, &su) != nil {
		return su, false
	}
	return su, true
}

// joinSignedIn creates the member an admitted identity becomes, with the name
// and avatar they chose here (nothing is taken from the provider). The signup
// cookie cannot be spent twice: the identity can belong to one member only.
func (s *Server) joinSignedIn(w http.ResponseWriter, r *http.Request, name string, avatar json.RawMessage) {
	su, ok := s.pendingSignup(r)
	if !ok {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "sign in first", "code": "expired"})
		return
	}
	office, err := s.st.OfficeBySlug(r.Context(), s.cfg.OfficeSlug)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "office unavailable"})
		return
	}
	// Without an invite, a production member is a member: the first admin of a
	// new office comes from an admin invite (tilework -invite admin). In dev the
	// first member becomes admin, as without sign-in.
	forced := ""
	if !s.cfg.Dev() {
		forced = "member"
	}
	invite := su.Invite
	uid, role, err := s.st.AddMemberWithIdentity(r.Context(), office.ID, name, avatar, forced, invite, su.identity())
	if errors.Is(err, store.ErrInviteInvalid) && su.DomainOK {
		// the invite was spent meanwhile, but the domain admits this person anyway
		invite = ""
		uid, role, err = s.st.AddMemberWithIdentity(r.Context(), office.ID, name, avatar, forced, "", su.identity())
	}
	switch {
	case errors.Is(err, store.ErrInviteInvalid):
		s.authCookie(w, signupCookie, "", "/", -1)
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "invite invalid, expired or exhausted", "code": "invite"})
		return
	case errors.Is(err, store.ErrIdentityTaken):
		s.authCookie(w, signupCookie, "", "/", -1)
		writeJSON(w, http.StatusConflict, map[string]string{"error": "this account already has a member", "code": "taken"})
		return
	case err != nil:
		s.log.Error("add signed-in member", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	s.authCookie(w, signupCookie, "", "/", -1)
	tok, err := s.st.CreateSession(r.Context(), uid, office.ID, s.cfg.SessionTTL)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	s.setCookie(w, tok)
	via := "domain"
	if invite != "" {
		via = "invite"
	}
	s.audit(r, &store.Session{UserID: uid, OfficeID: office.ID}, "member.join", uid, name, "role="+role+" provider="+su.Provider+" via="+via)
	writeJSON(w, http.StatusOK, map[string]any{"id": uid, "name": name, "role": role})
}

// signOut makes this browser forget its session (and any sign-up in progress).
// A session linked to an account ends for good (a copy of the cookie stops
// working too): signing in again finds the same member. A session not linked
// yet is only forgotten here: it is how a person on a borrowed browser says
// "this is not me" before linking, and for a member from before sign-in it may
// be their only way in, from their own browser.
func (s *Server) signOut(w http.ResponseWriter, r *http.Request) {
	se, err := s.rawSession(r)
	if err != nil && !errors.Is(err, store.ErrNotFound) { // never say "signed out" while the session may live on
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	if err == nil && se.Linked {
		c, _ := r.Cookie(cookieName)
		if err := s.st.DeleteSession(r.Context(), c.Value); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
			return
		}
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: !s.cfg.Dev(), MaxAge: -1})
	s.authCookie(w, signupCookie, "", "/", -1)
	w.WriteHeader(http.StatusNoContent)
}
