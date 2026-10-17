package auth

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func jwt(claims map[string]any) string {
	enc := func(v any) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	return enc(map[string]string{"alg": "RS256"}) + "." + enc(claims) + ".sig"
}

func good(now time.Time) map[string]any {
	return map[string]any{"iss": "https://accounts.google.com", "aud": "client", "sub": "1234", "email": "Ann@Acme.com",
		"email_verified": true, "hd": "Acme.com", "nonce": "n0", "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()}
}

func TestIDTokenClaimsAreChecked(t *testing.T) {
	p := Google("client", "secret")
	now := time.Now()
	c, err := p.checkIDToken(jwt(good(now)), "n0", now)
	if err != nil {
		t.Fatal(err)
	}
	if c.Subject != "1234" || c.Email != "ann@acme.com" || !c.EmailVerified || c.Domain != "acme.com" {
		t.Fatalf("claims: %+v", c)
	}
	for name, mutate := range map[string]func(map[string]any){
		"another issuer":    func(m map[string]any) { m["iss"] = "https://evil.example" },
		"another client":    func(m map[string]any) { m["aud"] = "other" },
		"audience list":     func(m map[string]any) { m["aud"] = []string{"other", "third"} },
		"expired":           func(m map[string]any) { m["exp"] = now.Add(-time.Hour).Unix() },
		"no expiry":         func(m map[string]any) { delete(m, "exp") },
		"issued later":      func(m map[string]any) { m["iat"] = now.Add(time.Hour).Unix() },
		"replayed nonce":    func(m map[string]any) { m["nonce"] = "other" },
		"missing nonce":     func(m map[string]any) { delete(m, "nonce") },
		"missing subject":   func(m map[string]any) { delete(m, "sub") },
		"oversized subject": func(m map[string]any) { m["sub"] = strings.Repeat("x", 300) },
	} {
		t.Run(name, func(t *testing.T) {
			m := good(now)
			mutate(m)
			if _, err := p.checkIDToken(jwt(m), "n0", now); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	m := good(now)
	m["aud"] = []string{"other", "client"}
	if _, err := p.checkIDToken(jwt(m), "n0", now); err != nil {
		t.Fatalf("an audience list naming this client is valid: %v", err)
	}
	m = good(now)
	m["email_verified"] = "false"
	if c, err := p.checkIDToken(jwt(m), "n0", now); err != nil || c.EmailVerified {
		t.Fatalf("an unverified address must not count as verified: %+v %v", c, err)
	}
	if _, err := p.checkIDToken("not.a-jwt", "n0", now); err == nil {
		t.Fatal("garbage accepted")
	}
	if _, err := p.checkIDToken(jwt(good(now)), "", now); err == nil {
		t.Fatal("a flow without a nonce must not accept any token")
	}
}

func TestExchangeSendsPKCEAndNeverEchoesTheBody(t *testing.T) {
	now := time.Now()
	var form map[string][]string
	ok := true
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		form = r.PostForm
		if !ok {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"invalid_grant","code":"the-secret-code"}`))
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"id_token": jwt(good(now))})
	}))
	defer ts.Close()
	p := Google("client", "secret")
	p.TokenURL = ts.URL
	c, err := p.Exchange(t.Context(), "the-secret-code", "https://office/cb", "verifier", "n0")
	if err != nil || c.Subject != "1234" {
		t.Fatalf("%+v %v", c, err)
	}
	if form["code_verifier"][0] != "verifier" || form["client_secret"][0] != "secret" || form["redirect_uri"][0] != "https://office/cb" {
		t.Fatalf("form: %v", form)
	}
	ok = false
	_, err = p.Exchange(t.Context(), "the-secret-code", "https://office/cb", "verifier", "n0")
	if err == nil || strings.Contains(err.Error(), "the-secret-code") {
		t.Fatalf("a failed exchange must fail without quoting the provider: %v", err)
	}
}

func TestAuthCodeURLAsksForNoProfile(t *testing.T) {
	u := Google("client", "secret").AuthCodeURL("https://office/cb", "st", "n0", "verifier", "ann@acme.com")
	for _, want := range []string{"scope=openid+email&", "code_challenge=" + Challenge("verifier"), "code_challenge_method=S256", "login_hint=ann%40acme.com", "nonce=n0", "state=st"} {
		if !strings.Contains(u+"&", want) {
			t.Errorf("%s lacks %s", u, want)
		}
	}
	if strings.Contains(u, "profile") {
		t.Errorf("the name and picture are chosen in Tilework: %s", u)
	}
}

func TestPendingIsBoundedAndSingleUse(t *testing.T) {
	p := NewPending[int](time.Minute, 2)
	now := time.Now()
	p.now = func() time.Time { return now }
	a, _ := p.Put(1)
	if _, err := p.Put(2); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Put(3); err != ErrFull {
		t.Fatalf("a full store must refuse, got %v", err)
	}
	if v, ok := p.Get(a); !ok || v != 1 {
		t.Fatal("get")
	}
	if v, ok := p.Take(a); !ok || v != 1 {
		t.Fatal("take")
	}
	if _, ok := p.Take(a); ok {
		t.Fatal("a key works once")
	}
	now = now.Add(2 * time.Minute)
	if _, err := p.Put(4); err != nil { // one live slot was free
		t.Fatal(err)
	}
	if _, err := p.Put(5); err != nil {
		t.Fatalf("expired values make room when full: %v", err)
	}
	if p.Len() != 2 {
		t.Fatalf("the expired value is swept, len %d", p.Len())
	}
}
