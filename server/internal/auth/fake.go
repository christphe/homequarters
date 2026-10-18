package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"html/template"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"
)

// The fake provider's fixed client. It signs anybody in, which is why the
// configuration refuses it in production.
const (
	FakeName     = "fake-oidc"
	FakeIssuer   = "homequarters-fake-oidc"
	FakeClientID = "homequarters-dev"
	FakeSecret   = "fake-oidc-secret"
	fakeCookie   = "hq_fake_oidc"
	fakeBase     = "/auth/" + FakeName
)

// Fake is an OpenID Connect provider for development and tests. It walks the
// same path as Google - redirect, consent page, code, back-channel exchange,
// id_token - with the consent reduced to one "Authorize" button.
//
// Like Google it remembers the browser: the first visit invents an identity
// (user-xxxx@<domain>) and keeps it in its own cookie, so the same browser
// signs in as the same person and a new browser (or private window) is a new
// person. A login_hint with an address signs in as that address instead.
type Fake struct {
	Domain string // the domain of invented addresses
	codes  *Pending[fakeCode]
}

type fakeCode struct {
	claims      map[string]any
	challenge   string
	redirectURI string
}

func NewFake(domain string) *Fake {
	if domain == "" {
		domain = "dev.local"
	}
	return &Fake{Domain: domain, codes: NewPending[fakeCode](time.Minute, 1000)}
}

// Provider is the client side of the fake: the browser goes to this server's
// authorize page, the code is exchanged at tokenBase (this server, over HTTP).
func (f *Fake) Provider(tokenBase string) *Provider {
	return &Provider{
		Name:     FakeName,
		Issuers:  []string{FakeIssuer},
		AuthURL:  fakeBase + "/authorize",
		TokenURL: strings.TrimRight(tokenBase, "/") + fakeBase + "/token",
		ClientID: FakeClientID,
		Secret:   FakeSecret,
		HTTP:     &http.Client{Timeout: 5 * time.Second},
	}
}

// consumer domains have no Workspace: Google sends no hd for them.
var consumer = map[string]bool{"gmail.com": true, "googlemail.com": true}

// who is the identity this browser signs in as.
func (f *Fake) who(w http.ResponseWriter, r *http.Request, hint string) (sub, email string) {
	hint = strings.ToLower(hint)
	// an invented address names the same person as the browser that invented it
	if id, ok := strings.CutPrefix(hint, "user-"); ok && strings.HasSuffix(id, "@"+f.Domain) {
		if id = strings.TrimSuffix(id, "@"+f.Domain); len(id) == 8 && strings.Trim(id, "0123456789abcdef") == "" {
			return "fake-" + id, hint
		}
	}
	if a, err := mail.ParseAddress(hint); err == nil && a.Address == hint && len(hint) <= 254 {
		h := sha256.Sum256([]byte(hint))
		return "fake-" + hex.EncodeToString(h[:8]), strings.ToLower(hint)
	}
	id := ""
	if c, err := r.Cookie(fakeCookie); err == nil && len(c.Value) == 8 && strings.Trim(c.Value, "0123456789abcdef") == "" {
		id = c.Value
	} else {
		b := sha256.Sum256([]byte(Random(16)))
		id = hex.EncodeToString(b[:4])
		http.SetCookie(w, &http.Cookie{Name: fakeCookie, Value: id, Path: fakeBase, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: 365 * 24 * 3600})
	}
	return "fake-" + id, "user-" + id + "@" + f.Domain
}

var fakePage = template.Must(template.New("fake").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fake sign-in</title>
<style>body{font:16px system-ui,sans-serif;background:#f4f1ea;color:#1d1d1d;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;border:2px solid #1d1d1d;padding:24px;max-width:360px;margin:16px}
button{font:inherit;padding:8px 16px;margin-right:8px;cursor:pointer;border:1px solid #1d1d1d}.primary{background:#1d4ed8;color:#fff;border-color:#1d4ed8}
p.note{color:#555;font-size:14px}</style></head>
<body><main><h1>Fake sign-in</h1>
<p>Development only. Home Quarters asks who you are.</p>
<p>You will sign in as <strong id="fake-email">{{.Email}}</strong>.</p>
<form method="post" action="` + fakeBase + `/authorize">
{{range $k, $v := .Fields}}<input type="hidden" name="{{$k}}" value="{{$v}}">{{end}}
<button class="primary" name="decision" value="allow">Authorize</button>
<button name="decision" value="deny">Cancel</button>
</form>
<p class="note">A private window is a new person.</p></main></body></html>`))

// Authorize is the consent page (GET) and its answer (POST).
func (f *Fake) Authorize(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	q := r.Form
	redirect, err := url.Parse(q.Get("redirect_uri"))
	// the code only ever goes back to this server's own callback
	if err != nil || (redirect.Scheme != "http" && redirect.Scheme != "https") || redirect.Path != fakeBase+"/callback" || redirect.Host != r.Host || q.Get("client_id") != FakeClientID ||
		q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" ||
		q.Get("state") == "" || q.Get("nonce") == "" {
		// most often a consent page left open across a restart or a change of address
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fake sign-in</title></head><body><main><h1>This sign-in cannot continue</h1><p>It was started from another address, or is incomplete. <a href="/">Go back to the office</a> and sign in again.</p></main></body></html>`))
		return
	}
	hint := q.Get("login_hint")
	sub, email := f.who(w, r, hint)
	if r.Method == http.MethodGet {
		fields := map[string]string{}
		for _, k := range []string{"client_id", "redirect_uri", "response_type", "state", "nonce", "code_challenge", "code_challenge_method", "login_hint"} {
			if v := q.Get(k); v != "" {
				fields[k] = v
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fakePage.Execute(w, map[string]any{"Email": email, "Fields": fields})
		return
	}
	back := redirect.Query()
	back.Set("state", q.Get("state"))
	if q.Get("decision") != "allow" {
		back.Set("error", "access_denied")
	} else {
		now := time.Now()
		claims := map[string]any{"iss": FakeIssuer, "aud": FakeClientID, "sub": sub, "email": email, "email_verified": true,
			"nonce": q.Get("nonce"), "iat": now.Unix(), "exp": now.Add(5 * time.Minute).Unix()}
		if d := email[strings.LastIndexByte(email, '@')+1:]; !consumer[d] {
			claims["hd"] = d
		}
		code, err := f.codes.Put(fakeCode{claims: claims, challenge: q.Get("code_challenge"), redirectURI: q.Get("redirect_uri")})
		if err != nil {
			http.Error(w, "busy", http.StatusServiceUnavailable)
			return
		}
		back.Set("code", code)
	}
	redirect.RawQuery = back.Encode()
	http.Redirect(w, r, redirect.String(), http.StatusSeeOther)
}

// Token exchanges a code for an id_token, checking the client, the redirect
// and the PKCE verifier like a real provider. The token is unsigned
// (alg none): its only reader is this server, over its own connection.
func (f *Fake) Token(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	c, ok := f.codes.Take(r.PostForm.Get("code"))
	if !ok || r.PostForm.Get("grant_type") != "authorization_code" || r.PostForm.Get("client_id") != FakeClientID ||
		r.PostForm.Get("client_secret") != FakeSecret || r.PostForm.Get("redirect_uri") != c.redirectURI ||
		Challenge(r.PostForm.Get("code_verifier")) != c.challenge {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid_grant"}`))
		return
	}
	enc := func(v any) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	tok := enc(map[string]string{"alg": "none", "typ": "JWT"}) + "." + enc(c.claims) + "."
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]string{"id_token": tok, "token_type": "Bearer"})
}
