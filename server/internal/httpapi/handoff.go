package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"html/template"
	"net/http"
	"sync"
	"time"

	"homequarters/internal/store"
)

// Sign-in for the desktop app (desktop/), which must not ask for a password in its own window and
// cannot anyway (Google refuses embedded webviews). The app draws a secret n and opens the person's
// browser on /auth/{p}/start?handoff=<sha256(n)>; its window waits on /auth/{p}/handoff/{n}:
//
//	browser: start (handoff=h) -> provider -> callback -> result kept under h, "go back to the app" page
//	app:     /auth/{p}/handoff/{n} -> waits for h = sha256(n) -> the session (or the name form) in the app
//
// The browser never holds the session and never sees n, so what it shows or keeps (address bar,
// history) cannot open it. A result is kept only after the provider signed the person in, for
// handoffTTL, used once, in a table of at most maxHandoffs entries.

const (
	handoffTTL  = 5 * time.Minute
	maxHandoffs = 256
)

// handoff is what a sign-in earned for the app: a member, an admitted identity still to name itself,
// or why it failed (the join screen's auth code).
type handoff struct {
	user, office int64
	provider     string
	signup       string // sealed signup
	code         string
	exp          time.Time
}

type handoffs struct {
	mu sync.Mutex
	m  map[string]handoff
}

// put keeps a result under the browser's hash; false when the table is full of live ones.
func (hs *handoffs) put(h string, v handoff, now time.Time) bool {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	if hs.m == nil {
		hs.m = map[string]handoff{}
	}
	for k, e := range hs.m {
		if now.After(e.exp) {
			delete(hs.m, k)
		}
	}
	if len(hs.m) >= maxHandoffs {
		return false
	}
	v.exp = now.Add(handoffTTL)
	hs.m[h] = v
	return true
}

// take hands a live result once.
func (hs *handoffs) take(h string, now time.Time) (handoff, bool) {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	v, ok := hs.m[h]
	delete(hs.m, h)
	return v, ok && !now.After(v.exp)
}

func handoffHash(n string) string {
	sum := sha256.Sum256([]byte(n))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// a hash or a secret: 32 random bytes, or their SHA-256, in unpadded base64url
func handoffLike(v string) bool { return len(v) == 43 && tokenLike(v) }

var handoffPage = template.Must(template.New("handoff").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
{{if .Refresh}}<meta http-equiv="refresh" content="1">{{end}}<title>Home Quarters</title>
<style>body{font:16px system-ui,sans-serif;background:#1b1830;color:#f2eefc;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:28rem;padding:24px;text-align:center}a{color:#3cc9b0}</style>
</head><body><main><h1>{{.Title}}</h1><p>{{.Text}}</p>{{if .Cancel}}<p><a href="/">Cancel</a></p>{{end}}</main></body></html>`))

func showHandoffPage(w http.ResponseWriter, title, text string, refresh, cancel bool) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer") // the app's address carries its secret
	handoffPage.Execute(w, map[string]any{"Title": title, "Text": text, "Refresh": refresh, "Cancel": cancel})
}

// handOff ends a browser sign-in made for the app: the result waits for the app, and the browser is
// told to go back to it.
func (s *Server) handOff(w http.ResponseWriter, f *flow, v handoff) {
	if !s.handoffs.put(f.Handoff, v, time.Now()) {
		showHandoffPage(w, "Sign-in did not finish", "Too many sign-ins are waiting right now. Try again from the Home Quarters app in a few minutes.", false, false)
		return
	}
	if v.code != "" {
		showHandoffPage(w, "Sign-in did not finish", "Go back to the Home Quarters app to see why and try again. You can close this tab.", false, false)
		return
	}
	showHandoffPage(w, "You are signed in", "Go back to the Home Quarters app. You can close this tab.", false, false)
}

// redeemHandoff is the app's window trading its secret for what the browser earned. It waits a while
// for the browser to finish, then shows a page that asks again by itself.
func (s *Server) redeemHandoff(w http.ResponseWriter, r *http.Request) {
	n := r.PathValue("secret")
	if s.providers[r.PathValue("provider")] == nil || !handoffLike(n) {
		http.NotFound(w, r)
		return
	}
	if !s.joinLim.Allow(clientIP(r)) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	h := handoffHash(n)
	deadline := time.Now().Add(s.handoffWait)
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		if v, ok := s.handoffs.take(h, time.Now()); ok {
			s.finishHandoff(w, r, v)
			return
		}
		if time.Now().After(deadline) {
			showHandoffPage(w, "Sign in in your browser", "Home Quarters opened your browser to sign in. Finish there, and this window follows.", true, true)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
		}
	}
}

func (s *Server) finishHandoff(w http.ResponseWriter, r *http.Request, v handoff) {
	switch {
	case v.user != 0:
		tok, err := s.st.CreateSession(r.Context(), v.user, v.office, s.cfg.SessionTTL)
		if err != nil {
			authDone(w, r, "failed", nil)
			return
		}
		s.setCookie(w, tok)
		s.audit(r, &store.Session{UserID: v.user, OfficeID: v.office}, "auth.login", v.user, "", "provider="+v.provider+" via=desktop")
	case v.signup != "":
		s.authCookie(w, signupCookie, v.signup, "/", int(signupTTL.Seconds()))
	}
	authDone(w, r, v.code, nil)
}
