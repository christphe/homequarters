package config

import (
	"strings"
	"testing"
)

func TestHomeQuartersConfiguration(t *testing.T) {
	t.Setenv("HQ_ENV", "production")
	t.Setenv("HQ_ADDR", "127.0.0.1:19001")
	t.Setenv("HQ_DB", "data/preserved.db")
	t.Setenv("HQ_ALLOWED_ORIGINS", "office.example.com")
	t.Setenv("LIVEKIT_URL", "wss://lk.example.com")
	t.Setenv("LIVEKIT_API_KEY", "prodkey")
	t.Setenv("LIVEKIT_API_SECRET", "0123456789abcdef0123456789abcdef")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Dev() || c.Addr != "127.0.0.1:19001" || c.DBPath != "data/preserved.db" {
		t.Fatalf("Home Quarters configuration was ignored: %+v", c)
	}
}

func setProd(t *testing.T) {
	t.Helper()
	t.Setenv("HQ_ENV", "production")
	t.Setenv("LIVEKIT_URL", "wss://lk.example.com")
	t.Setenv("LIVEKIT_API_KEY", "prodkey")
	t.Setenv("LIVEKIT_API_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("HQ_ALLOWED_ORIGINS", "office.example.com")
}

func TestProductionAcceptsAFullConfiguration(t *testing.T) {
	setProd(t)
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
}

func TestProductionRefusesInsecureDefaults(t *testing.T) {
	for name, mutate := range map[string]func(*testing.T){
		"dev LiveKit key":     func(t *testing.T) { t.Setenv("LIVEKIT_API_KEY", "devkey") },
		"short secret":        func(t *testing.T) { t.Setenv("LIVEKIT_API_SECRET", "short") },
		"plain ws://":         func(t *testing.T) { t.Setenv("LIVEKIT_URL", "ws://lk.example.com") },
		"no allowed origins":  func(t *testing.T) { t.Setenv("HQ_ALLOWED_ORIGINS", "") },
		"short metrics token": func(t *testing.T) { t.Setenv("HQ_METRICS_TOKEN", "short") },
	} {
		t.Run(name, func(t *testing.T) {
			setProd(t)
			mutate(t)
			if _, err := Load(); err == nil {
				t.Fatal("production must refuse this configuration")
			}
		})
	}
}

func TestMetricsTokenIsOptionalButValidated(t *testing.T) {
	setProd(t)
	t.Setenv("HQ_METRICS_TOKEN", "0123456789abcdef")
	c, err := Load()
	if err != nil || c.MetricsToken == "" {
		t.Fatalf("%v %v", c, err)
	}
}

func TestLargestInterestRadiusDefaultsAndBounds(t *testing.T) {
	for _, tc := range []struct {
		aoi, max string
		want     int
		ok       bool
	}{
		{"", "", 8, true},    // defaults: 2..8
		{"6", "4", 4, false}, // never below the default radius
		{"9", "", 9, true},   // never narrower than the default radius
		{"2", "8", 8, true},  // the documented ceiling
		{"2", "9", 0, false},
		{"3", "2", 0, false},
	} {
		t.Setenv("HQ_AOI_CELLS", tc.aoi)
		t.Setenv("HQ_AOI_MAX_CELLS", tc.max)
		c, err := Load()
		if (err == nil) != tc.ok || (tc.ok && c.AOIMaxCells != tc.want) {
			t.Fatalf("AOI=%q MAX=%q: err=%v cfg=%+v", tc.aoi, tc.max, err, c)
		}
	}
}

// The test runner stops a server on Windows by closing its stdin (a signal there is a hard kill);
// production never takes that switch.
func TestStopOnStdinCloseIsDevOnly(t *testing.T) {
	t.Setenv("HQ_STOP_ON_STDIN_CLOSE", "1")
	c, err := Load()
	if err != nil || !c.StopOnStdinClose {
		t.Fatalf("dev takes the switch: %v %+v", err, c)
	}
	setProd(t)
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "HQ_STOP_ON_STDIN_CLOSE") {
		t.Fatalf("production must refuse it: %v", err)
	}
}

func TestAuthProvidersDefaultToNone(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.AuthEnabled() || len(c.AuthProviders) != 0 {
		t.Fatalf("no provider must mean today's behaviour, got %v", c.AuthProviders)
	}
}

func TestAuthProvidersAreParsedInOrder(t *testing.T) {
	t.Setenv("HQ_AUTH_PROVIDERS", " fake-oidc , google ")
	t.Setenv("HQ_GOOGLE_CLIENT_ID", "id.apps.googleusercontent.com")
	t.Setenv("HQ_GOOGLE_CLIENT_SECRET", "secret")
	t.Setenv("HQ_PUBLIC_URL", "http://localhost:5173/")
	t.Setenv("HQ_AUTH_DOMAINS", "Acme.com, example.org")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(c.AuthProviders, ",") != "fake-oidc,google" || !c.AuthEnabled() {
		t.Fatalf("providers: %v", c.AuthProviders)
	}
	if strings.Join(c.AuthDomains, ",") != "acme.com,example.org" {
		t.Fatalf("domains are compared lower case: %v", c.AuthDomains)
	}
	if c.PublicURL != "http://localhost:5173" {
		t.Fatalf("public URL keeps no trailing slash: %q", c.PublicURL)
	}
}

func TestAuthConfigurationIsRefusedWhenIncoherent(t *testing.T) {
	google := func(t *testing.T) {
		t.Setenv("HQ_AUTH_PROVIDERS", "google")
		t.Setenv("HQ_GOOGLE_CLIENT_ID", "id.apps.googleusercontent.com")
		t.Setenv("HQ_GOOGLE_CLIENT_SECRET", "secret")
		t.Setenv("HQ_PUBLIC_URL", "https://office.example.com")
	}
	for name, c := range map[string]struct {
		prod bool
		set  func(*testing.T)
		want string
	}{
		"unknown provider":       {set: func(t *testing.T) { t.Setenv("HQ_AUTH_PROVIDERS", "github") }, want: "unknown"},
		"email is not built yet": {set: func(t *testing.T) { t.Setenv("HQ_AUTH_PROVIDERS", "email") }, want: "unknown"},
		"none with a provider":   {set: func(t *testing.T) { t.Setenv("HQ_AUTH_PROVIDERS", "none,fake-oidc") }, want: "none"},
		"duplicate provider":     {set: func(t *testing.T) { t.Setenv("HQ_AUTH_PROVIDERS", "fake-oidc,fake-oidc") }, want: "twice"},
		"empty entry":            {set: func(t *testing.T) { t.Setenv("HQ_AUTH_PROVIDERS", "fake-oidc,,") }, want: "empty"},
		"demo with a provider": {set: func(t *testing.T) {
			t.Setenv("HQ_AUTH_PROVIDERS", "fake-oidc")
			t.Setenv("HQ_DEMO", "1")
		}, want: "demo"},
		"domains without a provider": {set: func(t *testing.T) { t.Setenv("HQ_AUTH_DOMAINS", "acme.com") }, want: "HQ_AUTH_DOMAINS"},
		"malformed domain": {set: func(t *testing.T) {
			t.Setenv("HQ_AUTH_PROVIDERS", "fake-oidc")
			t.Setenv("HQ_AUTH_DOMAINS", "@acme.com")
		}, want: "domain"},
		"google without a client id": {set: func(t *testing.T) {
			google(t)
			t.Setenv("HQ_GOOGLE_CLIENT_ID", "")
		}, want: "HQ_GOOGLE_CLIENT_ID"},
		"google without a secret": {set: func(t *testing.T) {
			google(t)
			t.Setenv("HQ_GOOGLE_CLIENT_SECRET", "")
		}, want: "HQ_GOOGLE_CLIENT_SECRET"},
		"google without a public URL": {set: func(t *testing.T) {
			google(t)
			t.Setenv("HQ_PUBLIC_URL", "")
		}, want: "HQ_PUBLIC_URL"},
		"public URL with a path": {set: func(t *testing.T) {
			google(t)
			t.Setenv("HQ_PUBLIC_URL", "https://office.example.com/homequarters")
		}, want: "HQ_PUBLIC_URL"},
		"production with fake-oidc": {prod: true, set: func(t *testing.T) { t.Setenv("HQ_AUTH_PROVIDERS", "fake-oidc") }, want: "fake-oidc"},
		"production google over http": {prod: true, set: func(t *testing.T) {
			google(t)
			t.Setenv("HQ_PUBLIC_URL", "http://office.example.com")
		}, want: "https"},
	} {
		t.Run(name, func(t *testing.T) {
			if c.prod {
				setProd(t)
			}
			c.set(t)
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want an error mentioning %q, got %v", c.want, err)
			}
		})
	}
}

func TestProductionAcceptsGoogle(t *testing.T) {
	setProd(t)
	t.Setenv("HQ_AUTH_PROVIDERS", "google")
	t.Setenv("HQ_GOOGLE_CLIENT_ID", "id.apps.googleusercontent.com")
	t.Setenv("HQ_GOOGLE_CLIENT_SECRET", "secret")
	t.Setenv("HQ_PUBLIC_URL", "https://office.example.com")
	t.Setenv("HQ_AUTH_DOMAINS", "acme.com")
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
}
