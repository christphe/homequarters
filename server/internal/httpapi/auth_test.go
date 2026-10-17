package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"tilework/internal/auth"
	"tilework/internal/config"
	"tilework/internal/gamemap"
	"tilework/internal/media"
	"tilework/internal/store"
)

// authRig is a server with fake-oidc sign-in and acme.test as authorised domain.
// Everything it logs is kept, to prove what it never logs.
type authRig struct {
	*rig
	logs *bytes.Buffer
}

func newAuthRig(t *testing.T, mutate func(*config.Config)) *authRig {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	mj, _ := json.Marshal(gamemap.Default())
	if _, err := st.EnsureOffice(context.Background(), "default", "T", string(mj)); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Env: "dev", OfficeSlug: "default", OfficeName: "T", SessionTTL: time.Hour, TickHz: 15, AOICells: 2,
		MaxPlayers: 100, MaxGroup: 8, JoinRate: 1000, MediaTTL: 30 * time.Second, MediaReconcile: time.Hour,
		AuthProviders: []string{"fake-oidc"}, AuthDomains: []string{"acme.test"}}
	if mutate != nil {
		mutate(cfg)
	}
	logs := &bytes.Buffer{}
	log := slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	srv := New(ctx, cfg, log, st, media.New(media.Config{}, log))
	// production cookies are Secure: serve over TLS so the client sends them back
	ts := httptest.NewUnstartedServer(srv.Handler())
	if cfg.Env == "production" {
		ts.StartTLS()
		srv.providers["fake-oidc"].HTTP = ts.Client()
	} else {
		ts.Start()
	}
	t.Cleanup(ts.Close)
	srv.providers["fake-oidc"].TokenURL = ts.URL + "/auth/fake-oidc/token" // the test server's port, not TILEWORK_ADDR
	return &authRig{rig: &rig{t: t, ts: ts, st: st, cfg: cfg, srv: srv}, logs: logs}
}

// browser is a client with its own cookies, like a browser profile.
func (r *authRig) browser() *user {
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	if r.ts.TLS != nil {
		c.Transport = r.ts.Client().Transport
	}
	return &user{r: r.rig, c: c}
}

// signIn clicks the provider button, then Authorize (or Cancel) on the fake
// consent page, following every redirect; it returns where the browser lands.
func (u *user) signIn(query, decision string) *url.URL {
	u.r.t.Helper()
	resp, err := u.c.Get(u.r.ts.URL + "/auth/fake-oidc/start?" + query)
	if err != nil {
		u.r.t.Fatal(err)
	}
	page, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.Request.URL.Path != "/auth/fake-oidc/authorize" {
		return resp.Request.URL // never reached the provider (already signed in)
	}
	if !bytes.Contains(page, []byte("Authorize")) {
		u.r.t.Fatalf("no consent page: %s", page)
	}
	form := resp.Request.URL.Query()
	form.Set("decision", decision)
	resp, err = u.c.PostForm(u.r.ts.URL+"/auth/fake-oidc/authorize", form)
	if err != nil {
		u.r.t.Fatal(err)
	}
	resp.Body.Close()
	return resp.Request.URL
}

func (u *user) me() map[string]any {
	u.r.t.Helper()
	_, out := u.do("GET", "/api/me", nil)
	return out
}

func (u *user) joinNamed(name string) (int, map[string]any) {
	u.r.t.Helper()
	code, out := u.do("POST", "/api/join", map[string]any{"name": name})
	if id, ok := out["id"].(float64); ok {
		u.ID = int64(id)
	}
	return code, out
}

func landed(t *testing.T, u *url.URL, want string) {
	t.Helper()
	if u.Path != "/" || u.Query().Get("auth") != want {
		t.Fatalf("landed on %s, want / with auth=%q", u, want)
	}
}

func TestNoProviderKeepsTodaysJoin(t *testing.T) {
	r := newRig(t, nil)
	u, code := r.join("Ana", "")
	if code != http.StatusOK {
		t.Fatalf("open dev join: %d", code)
	}
	if auth, ok := u.do("GET", "/api/me", nil); auth != 200 || ok["authenticated"] != true || len(ok["auth"].([]any)) != 0 {
		t.Fatalf("me: %v", ok)
	}
	if resp, _ := http.Get(r.ts.URL + "/auth/fake-oidc/start"); resp.StatusCode == http.StatusSeeOther || resp.Request.URL.Path != "/auth/fake-oidc/start" {
		t.Fatal("no sign-in route exists without a provider")
	}
}

func TestSignInIsRequiredToJoin(t *testing.T) {
	r := newAuthRig(t, nil)
	b := r.browser()
	if code, _ := b.joinNamed("Sneaky"); code != http.StatusForbidden {
		t.Fatalf("join without sign-in: %d", code)
	}
	if me := b.me(); me["authenticated"] != false || me["auth"].([]any)[0] != "fake-oidc" || me["signup"] != nil {
		t.Fatalf("me: %v", me)
	}
}

func TestDomainMemberSignsUpThenComesBack(t *testing.T) {
	r := newAuthRig(t, nil)
	b := r.browser()
	landed(t, b.signIn("", "allow"), "")
	me := b.me()
	email, _ := me["signup"].(map[string]any)["email"].(string)
	if me["authenticated"] != false || !strings.HasSuffix(email, "@acme.test") {
		t.Fatalf("an admitted identity gets the name form first: %v", me)
	}
	code, out := b.joinNamed("Ana")
	if code != http.StatusOK || out["role"] != "admin" {
		t.Fatalf("join: %d %v (dev: first member is admin)", code, out)
	}
	if me := b.me(); me["authenticated"] != true || me["name"] != "Ana" {
		t.Fatalf("the name is the one chosen here: %v", me)
	}
	if code, _ := b.joinNamed("Again"); code != http.StatusForbidden {
		t.Fatal("an admission is used once")
	}

	// Same browser profile, session gone: the provider remembers it, the account is found.
	again := r.browser()
	fakeURL, _ := url.Parse(r.ts.URL + "/auth/fake-oidc/authorize")
	for _, c := range b.c.Jar.Cookies(fakeURL) {
		if c.Name == "tilework_fake_oidc" {
			again.c.Jar.SetCookies(fakeURL, []*http.Cookie{c})
		}
	}
	landed(t, again.signIn("", "allow"), "")
	if me := again.me(); me["authenticated"] != true || int64(me["id"].(float64)) != b.ID {
		t.Fatalf("a returning identity lands in its account: %v", me)
	}
	// A new browser profile is a new person.
	other := r.browser()
	landed(t, other.signIn("", "allow"), "")
	if code, out := other.joinNamed("Bea"); code != 200 || int64(out["id"].(float64)) == b.ID || out["role"] != "member" {
		t.Fatalf("new browser: %d %v", code, out)
	}
}

func TestOutsiderNeedsAnInvite(t *testing.T) {
	r := newAuthRig(t, nil)
	admin := r.browser()
	admin.signIn("", "allow")
	admin.joinNamed("Ana")

	bob := r.browser()
	landed(t, bob.signIn("login_hint=bob@gmail.com", "allow"), "denied")
	if me := bob.me(); me["signup"] != nil {
		t.Fatalf("refused identities get no name form: %v", me)
	}
	_, inv := admin.do("POST", "/api/invites", map[string]any{"role": "member", "maxUses": 1, "hours": 1})
	tok := inv["token"].(string)
	landed(t, bob.signIn("invite="+tok+"&login_hint=bob@gmail.com", "allow"), "")
	if _, err := r.st.InviteUsable(context.Background(), tok); err != nil {
		t.Fatal("signing in must not spend the invite; creating the member does")
	}
	if code, out := bob.joinNamed("Bob"); code != 200 || out["role"] != "member" {
		t.Fatalf("invited outsider: %d %v", code, out)
	}
	if _, err := r.st.InviteUsable(context.Background(), tok); err == nil {
		t.Fatal("the invite is spent")
	}
	carol := r.browser()
	landed(t, carol.signIn("invite="+tok+"&login_hint=carol@gmail.com", "allow"), "denied")

	// Removing a member is not a ban: they are admitted again like anybody new, which for an outsider means an invite.
	if code, _ := admin.do("DELETE", "/api/admin/members/"+itoa(bob.ID), nil); code != 200 {
		t.Fatal("remove")
	}
	again := r.browser()
	landed(t, again.signIn("login_hint=bob@gmail.com", "allow"), "denied")
}

func TestRemovedDomainMemberStartsOver(t *testing.T) {
	r := newAuthRig(t, nil)
	admin := r.browser()
	admin.signIn("", "allow")
	admin.joinNamed("Ana")
	cy := r.browser()
	cy.signIn("login_hint=cy@acme.test", "allow")
	cy.joinNamed("Cy")
	if code, _ := admin.do("DELETE", "/api/admin/members/"+itoa(cy.ID), nil); code != 200 {
		t.Fatal("remove")
	}
	back := r.browser()
	landed(t, back.signIn("login_hint=cy@acme.test", "allow"), "")
	if me := back.me(); me["authenticated"] != false || me["signup"] == nil {
		t.Fatalf("a removed member signs up again, they do not get the old account: %v", me)
	}
	if code, out := back.joinNamed("Cy2"); code != 200 || int64(out["id"].(float64)) == cy.ID {
		t.Fatalf("new member expected: %d %v", code, out)
	}
}

// legacy is a member from before sign-in: a session, no identity.
func (r *authRig) legacy(name, role string) *user {
	r.t.Helper()
	ctx := context.Background()
	o, _ := r.st.OfficeBySlug(ctx, "default")
	uid, _, err := r.st.AddMember(ctx, o.ID, name, json.RawMessage(`{}`), role)
	if err != nil {
		r.t.Fatal(err)
	}
	tok, _ := r.st.CreateSession(ctx, uid, o.ID, time.Hour)
	u := r.browser()
	base, _ := url.Parse(r.ts.URL)
	u.c.Jar.SetCookies(base, []*http.Cookie{{Name: cookieName, Value: tok, Path: "/"}})
	u.ID = uid
	return u
}

func TestExistingMembersLinkTheirAccount(t *testing.T) {
	r := newAuthRig(t, nil)
	old := r.legacy("Olga", "admin")
	if me := old.me(); me["authenticated"] != false || me["link"].(map[string]any)["name"] != "Olga" {
		t.Fatalf("an unlinked session is asked to link: %v", me)
	}
	for _, ep := range [][2]string{{"GET", "/api/admin/members"}, {"POST", "/api/invites"}, {"PUT", "/api/profile"}, {"POST", "/api/desk"}, {"GET", "/ws"}, {"POST", "/api/account-link"}} {
		if code, _ := old.do(ep[0], ep[1], map[string]any{}); code != http.StatusUnauthorized && code != http.StatusForbidden {
			t.Errorf("unlinked session reached %v: %d", ep, code)
		}
	}
	// Linking does not ask for the domain: Olga is already a member.
	landed(t, old.signIn("login_hint=olga@gmail.com", "allow"), "linked")
	if me := old.me(); me["authenticated"] != true || int64(me["id"].(float64)) != old.ID || me["name"] != "Olga" || me["role"] != "admin" {
		t.Fatalf("linked into the same account: %v", me)
	}
	if code, _ := old.do("GET", "/api/admin/members", nil); code != 200 {
		t.Fatalf("a linked admin is an admin again: %d", code)
	}
	// From another machine, the identity now signs in as Olga.
	elsewhere := r.browser()
	landed(t, elsewhere.signIn("login_hint=olga@gmail.com", "allow"), "")
	if me := elsewhere.me(); int64(me["id"].(float64)) != old.ID {
		t.Fatalf("sign-in finds the linked account: %v", me)
	}
	// An identity already linked to someone cannot be linked to another member.
	pat := r.legacy("Pat", "member")
	landed(t, pat.signIn("login_hint=olga@gmail.com", "allow"), "taken")
	if me := pat.me(); me["link"] == nil {
		t.Fatalf("Pat is still unlinked: %v", me)
	}
	_, list := old.do("GET", "/api/admin/members", nil)
	emails := map[string]string{}
	for _, m := range list["members"].([]any) {
		mm := m.(map[string]any)
		emails[mm["name"].(string)] = mm["email"].(string)
	}
	if emails["Olga"] != "olga@gmail.com" || emails["Pat"] != "" {
		t.Fatalf("admins see who has linked: %v", emails)
	}
}

func TestPersonalLinksStopAtLinkedAccounts(t *testing.T) {
	r := newAuthRig(t, nil)
	ctx := context.Background()
	o, _ := r.st.OfficeBySlug(ctx, "default")
	pat := r.legacy("Pat", "member")
	tok, _ := r.st.CreateAccountLink(ctx, pat.ID, o.ID)
	// still unlinked: the link opens a session, which then has to link
	fresh := r.browser()
	resp, err := fresh.c.Get(r.ts.URL + "/link/" + tok)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if me := fresh.me(); me["link"] == nil {
		t.Fatalf("a personal link of an unlinked member leads to linking: %v", me)
	}
	fresh.signIn("login_hint=pat@acme.test", "allow")
	tok, _ = r.st.CreateAccountLink(ctx, pat.ID, o.ID)
	resp, _ = r.browser().c.Get(r.ts.URL + "/link/" + tok)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("a linked member's personal link is refused: %d", resp.StatusCode)
	}
	if code, _ := fresh.do("POST", "/api/account-link", nil); code != http.StatusForbidden {
		t.Fatalf("no personal link is minted while sign-in is on: %d", code)
	}
}

func TestCallbackRefusesForgedOrReplayedState(t *testing.T) {
	r := newAuthRig(t, nil)
	b := r.browser()
	landed(t, b.signIn("", "deny"), "cancelled")

	// Stop at the callback to replay it.
	b.c.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if req.URL.Path == "/auth/fake-oidc/callback" {
			return http.ErrUseLastResponse
		}
		return nil
	}
	resp, _ := b.c.Get(r.ts.URL + "/auth/fake-oidc/start")
	resp.Body.Close()
	form := resp.Request.URL.Query()
	form.Set("decision", "allow")
	resp, _ = b.c.PostForm(r.ts.URL+"/auth/fake-oidc/authorize", form)
	resp.Body.Close()
	callback := resp.Header.Get("Location")
	b.c.CheckRedirect = nil

	// another browser cannot use it: the state is bound to the one that started
	resp, _ = r.browser().c.Get(callback)
	resp.Body.Close()
	landed(t, resp.Request.URL, "failed")
	// a tampered state fails too
	resp, _ = b.c.Get(strings.Replace(callback, "state=", "state=x", 1))
	resp.Body.Close()
	landed(t, resp.Request.URL, "failed")
	// the real one still works once (each state has its own cookie), then it is spent
	resp, _ = b.c.Get(callback)
	resp.Body.Close()
	landed(t, resp.Request.URL, "")
	resp, _ = b.c.Get(callback)
	resp.Body.Close()
	landed(t, resp.Request.URL, "failed")
}

func TestSealedValuesCannotBeForgedOrSwapped(t *testing.T) {
	r := newAuthRig(t, nil)
	b := r.browser()
	b.signIn("", "allow") // an admitted identity: the signup cookie is set
	base, _ := url.Parse(r.ts.URL)
	var su string
	for _, c := range b.c.Jar.Cookies(base) {
		if c.Name == signupCookie {
			su = c.Value
		}
	}
	if su == "" {
		t.Fatal("no signup cookie")
	}
	for name, val := range map[string]string{
		"tampered": su[:len(su)-2] + "AA",
		"other server": func() string {
			v, _ := auth.NewSealer().Seal("signup", signup{Provider: "fake-oidc", Subject: "x", DomainOK: true}, time.Hour)
			return v
		}(),
		"a flow": func() string {
			v, _ := r.srv.sealer.Seal("flow", signup{Provider: "fake-oidc", Subject: "x", DomainOK: true}, time.Hour)
			return v
		}(),
		"expired": func() string {
			v, _ := r.srv.sealer.Seal("signup", signup{Provider: "fake-oidc", Subject: "x", DomainOK: true}, -time.Minute)
			return v
		}(),
	} {
		forged := r.browser()
		forged.c.Jar.SetCookies(base, []*http.Cookie{{Name: signupCookie, Value: val, Path: "/"}})
		if code, _ := forged.joinNamed("Mallory"); code != http.StatusForbidden {
			t.Errorf("%s signup cookie accepted: %d", name, code)
		}
	}
}

func TestManySignInsInProgressLockNobodyOut(t *testing.T) {
	r := newAuthRig(t, nil)
	// an attacker keeps no cookies; with a jar the test would resend thousands of them
	flood := &user{r: r.rig, c: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	for range 12000 { // more than the old table held (10,000): nothing is kept on the server
		resp, err := flood.c.Get(r.ts.URL + "/auth/fake-oidc/start")
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body) // drained, so the connection is reused
		resp.Body.Close()
	}
	// The flood shares this test's address and drained its rate bucket (per IP, older than sign-in);
	// once it refills, a sign-in works: the flood left nothing behind.
	time.Sleep(2100 * time.Millisecond)
	landed(t, r.browser().signIn("", "allow"), "")
}

func TestTwoTabsSignInAtOnce(t *testing.T) {
	r := newAuthRig(t, nil)
	b := r.browser()
	b.c.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if req.URL.Path == "/auth/fake-oidc/callback" {
			return http.ErrUseLastResponse
		}
		return nil
	}
	var callbacks []string
	for range 2 {
		resp, _ := b.c.Get(r.ts.URL + "/auth/fake-oidc/start")
		resp.Body.Close()
		form := resp.Request.URL.Query()
		form.Set("decision", "allow")
		resp, _ = b.c.PostForm(r.ts.URL+"/auth/fake-oidc/authorize", form)
		resp.Body.Close()
		callbacks = append(callbacks, resp.Header.Get("Location"))
	}
	b.c.CheckRedirect = nil
	resp, _ := b.c.Get(callbacks[0]) // the first tab finishes after the second one started
	resp.Body.Close()
	landed(t, resp.Request.URL, "")
}

func TestAFailedSignInKeepsTheInvite(t *testing.T) {
	r := newAuthRig(t, nil)
	end := r.browser().signIn("invite=AbC_123&login_hint=bob@gmail.com", "deny")
	if end.Query().Get("auth") != "cancelled" || end.Query().Get("invite") != "AbC_123" || end.Query().Get("login_hint") != "bob@gmail.com" {
		t.Fatalf("the retry must still carry the invite: %s", end)
	}
}

func TestSignOutForgetsThisBrowser(t *testing.T) {
	if resp, _ := http.Post(newRig(t, nil).ts.URL+"/api/signout", "", nil); resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("without sign-in there is no sign-out (the cookie is the account): %d", resp.StatusCode)
	}
	r := newAuthRig(t, nil)
	pat := r.legacy("Pat", "member")
	base, _ := url.Parse(r.ts.URL)
	patsOwn := r.browser() // Pat's own browser holds the same session
	patsOwn.c.Jar.SetCookies(base, pat.c.Jar.Cookies(base))
	if me := pat.me(); me["link"] == nil {
		t.Fatal("setup")
	}
	if code, _ := pat.do("POST", "/api/signout", nil); code != http.StatusNoContent {
		t.Fatalf("sign out: %d", code)
	}
	if me := pat.me(); me["link"] != nil || me["authenticated"] != false {
		t.Fatalf("after signing out the browser is nobody: %v", me)
	}
	// someone else can now sign in from it without being linked to Pat
	landed(t, pat.signIn("login_hint=zoe@acme.test", "allow"), "")
	if me := pat.me(); me["signup"] == nil {
		t.Fatalf("a fresh admission, not Pat's account: %v", me)
	}
	if me := patsOwn.me(); me["link"] == nil {
		t.Fatalf("Pat's session still works from Pat's own browser: %v", me)
	}
}

func TestJoinRefusalsSayWhy(t *testing.T) {
	r := newAuthRig(t, nil)
	admin := r.browser()
	admin.signIn("", "allow")
	admin.joinNamed("Ana")
	_, inv := admin.do("POST", "/api/invites", map[string]any{"role": "member", "maxUses": 1, "hours": 1})
	tok := inv["token"].(string)
	bob, cy := r.browser(), r.browser()
	bob.signIn("invite="+tok+"&login_hint=bob@gmail.com", "allow")
	cy.signIn("invite="+tok+"&login_hint=cy@gmail.com", "allow")
	bob.joinNamed("Bob")
	if code, out := cy.joinNamed("Cy"); code != http.StatusForbidden || out["code"] != "invite" {
		t.Fatalf("the invite was spent by someone else meanwhile: %d %v", code, out)
	}
	if code, out := r.browser().joinNamed("Nobody"); code != http.StatusForbidden || out["code"] != "expired" {
		t.Fatalf("no sign-in: %d %v", code, out)
	}
	if end := r.browser().signIn("invite="+tok+"&login_hint=dee@gmail.com", "allow"); end.Query().Get("auth") != "denied" || end.Query().Get("invite") != "" {
		t.Fatalf("a refusal does not bring the spent invite back: %s", end)
	}
}

func TestOnlyConfiguredProvidersCountAsLinked(t *testing.T) {
	r := newAuthRig(t, nil)
	pat := r.legacy("Pat", "member")
	ctx := context.Background()
	o, _ := r.st.OfficeBySlug(ctx, "default")
	if err := r.st.LinkIdentity(ctx, o.ID, pat.ID, store.Identity{Provider: "google", Subject: "g1"}); err != nil {
		t.Fatal(err)
	}
	if me := pat.me(); me["link"] == nil {
		t.Fatalf("an identity of a provider not configured here does not let the member in: %v", me)
	}
	landed(t, pat.signIn("login_hint=pat@acme.test", "allow"), "linked")
	if me := pat.me(); me["authenticated"] != true || int64(me["id"].(float64)) != pat.ID {
		t.Fatalf("linking the configured provider keeps the account: %v", me)
	}
}

func TestTheDefaultJoinRateFitsSignIns(t *testing.T) {
	r := newAuthRig(t, func(c *config.Config) { c.JoinRate = 20 }) // TILEWORK_JOIN_RATE's default
	for i := range 4 {
		b := r.browser()
		landed(t, b.signIn("", "allow"), "")
		if code, _ := b.joinNamed("P" + strconv.Itoa(i)); code != 200 {
			t.Fatalf("sign-up %d at the default rate: %d", i, code)
		}
	}
}

func TestFakeInventedAddressIsTheSamePerson(t *testing.T) {
	r := newAuthRig(t, nil)
	a := r.browser()
	a.signIn("", "allow")
	a.joinNamed("Ana")
	_, list := a.do("GET", "/api/admin/members", nil)
	addr := list["members"].([]any)[0].(map[string]any)["email"].(string)
	pat := r.legacy("Pat", "member")
	landed(t, pat.signIn("login_hint="+addr, "allow"), "taken")
}

func TestSignInLogsNoSecrets(t *testing.T) {
	r := newAuthRig(t, nil)
	b := r.browser()
	b.signIn("login_hint=secret.person@acme.test", "allow")
	b.joinNamed("Sam")
	r.srv.providers["fake-oidc"].TokenURL = r.ts.URL + "/nowhere" // a failed exchange logs too
	r.browser().signIn("login_hint=secret.person@acme.test", "allow")
	r.srv.providers["fake-oidc"].TokenURL = "http://127.0.0.1:1/nowhere" // unreachable: the transport error is logged too
	r.browser().signIn("login_hint=secret.person@acme.test", "allow")
	logs := r.logs.String()
	if !strings.Contains(logs, "sign-in failed") {
		t.Fatalf("the failure is logged: %s", logs)
	}
	for _, leak := range []string{"secret.person", "acme.test", "code=", "id_token", "state=", r.srv.fake.Domain, "%!", "nowhere"} {
		if strings.Contains(logs, leak) {
			t.Errorf("logs contain %q:\n%s", leak, logs)
		}
	}
	rows, _ := r.st.DB.Query(`SELECT action, target_name, detail FROM audit_log`)
	defer rows.Close()
	seen := ""
	for rows.Next() {
		var a, n, d string
		rows.Scan(&a, &n, &d)
		seen += a + "|" + n + "|" + d + "\n"
	}
	if !strings.Contains(seen, "member.join|Sam|role=admin provider=fake-oidc via=domain") || strings.Contains(seen, "secret.person") {
		t.Fatalf("audit: %s", seen)
	}
}

func TestProductionDomainMemberIsNeverTheFirstAdmin(t *testing.T) {
	// config refuses fake-oidc in production; the rig bypasses it to exercise the join rule
	r := newAuthRig(t, func(c *config.Config) { c.Env = "production" })
	b := r.browser()
	b.signIn("", "allow")
	if code, out := b.joinNamed("Ana"); code != 200 || out["role"] != "member" {
		t.Fatalf("production: the first admin comes from an admin invite, got %d %v", code, out)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
