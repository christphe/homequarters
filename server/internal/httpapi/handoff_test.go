package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"homequarters/internal/auth"
)

// The desktop app signs in through the person's own browser: the app keeps a secret n, the browser
// signs in with only its hash, and the app then trades n for the session the browser earned.
func handoffPair() (n, h string) {
	n = auth.Random(32)
	sum := sha256.Sum256([]byte(n))
	return n, base64.RawURLEncoding.EncodeToString(sum[:])
}

// redeem is the app's window asking for the session; it returns where the window lands and the page.
func (u *user) redeem(n string) (*url.URL, string) {
	u.r.t.Helper()
	resp, err := u.c.Get(u.r.ts.URL + "/auth/fake-oidc/handoff/" + n)
	if err != nil {
		u.r.t.Fatal(err)
	}
	defer resp.Body.Close()
	page, _ := io.ReadAll(resp.Body)
	return resp.Request.URL, string(page)
}

func fastHandoffs(r *authRig) { r.srv.handoffWait = 50 * time.Millisecond }

func TestDesktopSignInHappensInTheBrowserAndLandsInTheApp(t *testing.T) {
	r := newAuthRig(t, nil)
	fastHandoffs(r)
	browser, app := r.browser(), r.browser()
	n, h := handoffPair()

	end := browser.signIn("handoff="+h, "allow")
	if end.Path != "/auth/fake-oidc/callback" {
		t.Fatalf("the browser stays on a page that sends the person back to the app, landed on %s", end)
	}
	if me := browser.me(); me["authenticated"] != false || me["signup"] != nil {
		t.Fatalf("the browser itself is not signed in: %v", me)
	}

	// a new identity: the name form shows in the app
	if to, _ := app.redeem(n); to.Path != "/" {
		t.Fatalf("the app lands in the office: %s", to)
	}
	if me := app.me(); me["signup"] == nil {
		t.Fatalf("the app holds the admitted identity: %v", me)
	}
	if code, out := app.joinNamed("Ana"); code != http.StatusOK {
		t.Fatalf("join from the app: %d %v", code, out)
	}
	if me := app.me(); me["authenticated"] != true || me["name"] != "Ana" {
		t.Fatalf("me: %v", me)
	}

	// spent: a second window with the same secret gets nothing
	late := r.browser()
	if _, page := late.redeem(n); !strings.Contains(page, "browser") {
		t.Fatalf("a spent secret waits like an unknown one: %q", page)
	}
	if me := late.me(); me["authenticated"] != false || me["signup"] != nil {
		t.Fatalf("used once: %v", me)
	}
}

func TestDesktopSignInOfAReturningMember(t *testing.T) {
	r := newAuthRig(t, nil)
	fastHandoffs(r)
	first := r.browser()
	first.signIn("", "allow")
	first.joinNamed("Ana")

	// the same person (same provider account), signing in for the app this time
	browser, app := r.browser(), r.browser()
	fakeURL, _ := url.Parse(r.ts.URL + "/auth/fake-oidc/authorize")
	browser.c.Jar.SetCookies(fakeURL, first.c.Jar.Cookies(fakeURL))
	n, h := handoffPair()
	browser.signIn("handoff="+h, "allow")
	if to, _ := app.redeem(n); to.Path != "/" || to.Query().Get("auth") != "" {
		t.Fatalf("landed on %s", to)
	}
	if me := app.me(); me["authenticated"] != true || int64(me["id"].(float64)) != first.ID {
		t.Fatalf("the app is in the member's account: %v", me)
	}
	if me := browser.me(); me["authenticated"] != false {
		t.Fatalf("the browser is not: %v", me)
	}
}

func TestOnlyTheAppsSecretRedeemsTheHandoff(t *testing.T) {
	r := newAuthRig(t, nil)
	fastHandoffs(r)
	n, h := handoffPair()
	r.browser().signIn("handoff="+h, "allow")

	// what the browser saw (its address bar, history) is the hash: it does not open the session
	thief := r.browser()
	if to, page := thief.redeem(h); to.Path == "/" || !strings.Contains(page, "browser") {
		t.Fatalf("the hash is not the secret: %s %q", to, page)
	}
	for _, bad := range []string{"short", strings.Repeat("x", 200), "..%2Fapi%2Fme"} {
		if resp, err := thief.c.Get(r.ts.URL + "/auth/fake-oidc/handoff/" + bad); err == nil && resp.StatusCode == http.StatusOK && resp.Request.URL.Path == "/" {
			t.Fatalf("%q redeemed something", bad)
		}
	}
	if me := thief.me(); me["authenticated"] != false || me["signup"] != nil {
		t.Fatalf("nothing for the thief: %v", me)
	}
	if to, _ := r.browser().redeem(n); to.Path != "/" {
		t.Fatalf("the real secret still works: %s", to)
	}
}

func TestACancelledDesktopSignInSaysWhyInTheApp(t *testing.T) {
	r := newAuthRig(t, nil)
	fastHandoffs(r)
	n, h := handoffPair()
	r.browser().signIn("handoff="+h, "deny")
	if to, _ := r.browser().redeem(n); to.Path != "/" || to.Query().Get("auth") != "cancelled" {
		t.Fatalf("the app's join screen explains the refusal: %s", to)
	}
}

func TestHandoffsAreBoundedAndExpire(t *testing.T) {
	var hs handoffs
	now := time.Now()
	for i := 0; i < maxHandoffs; i++ {
		if !hs.put(auth.Random(16), handoff{code: "x"}, now) {
			t.Fatalf("refused entry %d below the bound", i)
		}
	}
	if hs.put("one-too-many", handoff{code: "x"}, now) {
		t.Fatal("the table never grows past its bound")
	}
	// once they expire, room comes back on its own
	if !hs.put("later", handoff{code: "x"}, now.Add(handoffTTL+time.Second)) {
		t.Fatal("expired entries make room")
	}
	if _, ok := hs.take("later", now.Add(2*handoffTTL+2*time.Second)); ok {
		t.Fatal("an expired handoff is not handed")
	}
}
