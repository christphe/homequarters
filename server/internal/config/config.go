// Package config loads runtime configuration from environment variables.
// HQ_ENV=dev enables developer conveniences; HQ_ENV=production refuses to
// start with insecure defaults.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Env            string // dev | production
	Addr           string
	DBPath         string
	StaticDir      string
	Version        string // the deploy's commit (HQ_VERSION); empty: derived from the built page
	AllowedOrigins []string
	OfficeSlug     string
	OfficeName     string
	SessionTTL     time.Duration
	// MetricsToken protects /metrics with a bearer token. In dev, an empty token leaves /metrics open;
	// in production an empty token disables the endpoint (404).
	MetricsToken string

	LiveKitURL    string // public ws(s) URL used by browsers
	LiveKitAPIURL string // http(s) URL used by this server for admin calls
	LiveKitKey    string
	LiveKitSecret string

	TickHz         int
	AOICells       int
	AOIMaxCells    int
	MaxPlayers     int
	MaxGroup       int
	MediaTTL       time.Duration // validity of a media join token
	MediaReconcile time.Duration // how often SFU rooms are compared with the world's membership
	JoinRate       int           // dev /api/join requests per second per IP (raise for load tests only)

	// Demo turns a production deployment into a public sandbox: anyone may join WITHOUT an invite (always
	// as a member, never as admin), joins are rate limited per IP, and the office content (map, office chat,
	// whiteboards) is reset to the starter office every DemoReset.
	Demo      bool
	DemoReset time.Duration

	// AuthProviders lists how people sign in, in the order the join screen shows them. Empty means
	// "none": today's behaviour (an invite in production, an open join in dev, the cookie is the account).
	// With a provider, signing in is mandatory and nobody enters without an identity.
	AuthProviders []string
	// AuthDomains admits, without an invite, anybody whose provider proves an address in one of these
	// domains (Google: the hd claim of a Workspace account). Lower case.
	AuthDomains []string
	// PublicURL is the address people open (scheme and host, no path); the sign-in callback is built from
	// it. Required by google, whose console only accepts registered callback URLs.
	PublicURL          string
	GoogleClientID     string
	GoogleClientSecret string

	// Operator and Contact name who runs this office and how to reach them about personal data, on the
	// privacy policy page (/privacy). Both optional; the page falls back to "the administrators".
	Operator string
	Contact  string

	// SourceURL is where the people using this office get its source code (AGPL-3.0 section 13), shown on
	// the about page. An operator who runs modified code points it at their own repository.
	SourceURL string

	// StopOnStdinClose shuts the server down gracefully when its stdin closes. Dev only: the test runner
	// uses it on Windows, where a signal from Node is a hard kill that skips saving.
	StopOnStdinClose bool
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func envInt(k string, d int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return d
}

func (c *Config) Dev() bool { return c.Env != "production" }

// AuthEnabled reports whether signing in with a provider is required.
func (c *Config) AuthEnabled() bool { return len(c.AuthProviders) > 0 }

// The providers this build knows. "email" is planned and refused until it exists.
var knownProviders = map[string]bool{"google": true, "fake-oidc": true}

// loadAuth reads and checks the sign-in configuration.
func (c *Config) loadAuth() error {
	c.GoogleClientID = env("HQ_GOOGLE_CLIENT_ID", "")
	c.GoogleClientSecret = env("HQ_GOOGLE_CLIENT_SECRET", "")
	c.PublicURL = strings.TrimRight(env("HQ_PUBLIC_URL", ""), "/")
	raw := strings.TrimSpace(env("HQ_AUTH_PROVIDERS", "none"))
	if raw != "none" {
		seen := map[string]bool{}
		for _, p := range strings.Split(raw, ",") {
			p = strings.ToLower(strings.TrimSpace(p))
			switch {
			case p == "":
				return errors.New("HQ_AUTH_PROVIDERS has an empty entry")
			case p == "none":
				return errors.New("HQ_AUTH_PROVIDERS: none cannot be combined with a provider")
			case !knownProviders[p]:
				return fmt.Errorf("HQ_AUTH_PROVIDERS: unknown provider %q (known: google, fake-oidc)", p)
			case seen[p]:
				return fmt.Errorf("HQ_AUTH_PROVIDERS lists %s twice", p)
			}
			seen[p] = true
			c.AuthProviders = append(c.AuthProviders, p)
		}
	}
	if d := env("HQ_AUTH_DOMAINS", ""); d != "" {
		for _, x := range strings.Split(d, ",") {
			x = strings.ToLower(strings.TrimSpace(x))
			if x == "" || strings.ContainsAny(x, "@/: ") || !strings.Contains(x, ".") {
				return fmt.Errorf("HQ_AUTH_DOMAINS: %q is not a domain (write acme.com)", x)
			}
			c.AuthDomains = append(c.AuthDomains, x)
		}
	}
	if !c.AuthEnabled() {
		if len(c.AuthDomains) > 0 {
			return errors.New("HQ_AUTH_DOMAINS needs a sign-in provider in HQ_AUTH_PROVIDERS")
		}
		return nil
	}
	if c.Demo {
		return errors.New("the public demo is anonymous: HQ_DEMO cannot be combined with HQ_AUTH_PROVIDERS")
	}
	if c.PublicURL != "" {
		u, err := url.Parse(c.PublicURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Path != "" || u.RawQuery != "" {
			return errors.New("HQ_PUBLIC_URL must be a scheme and a host, like https://office.example.com")
		}
	}
	for _, p := range c.AuthProviders {
		switch p {
		case "fake-oidc":
			if !c.Dev() {
				return errors.New("fake-oidc signs anybody in: it is for development and tests, never production")
			}
		case "google":
			if c.GoogleClientID == "" {
				return errors.New("google sign-in requires HQ_GOOGLE_CLIENT_ID")
			}
			if c.GoogleClientSecret == "" {
				return errors.New("google sign-in requires HQ_GOOGLE_CLIENT_SECRET")
			}
			if c.PublicURL == "" {
				return errors.New("google sign-in requires HQ_PUBLIC_URL (the address registered as callback)")
			}
			if !c.Dev() && !strings.HasPrefix(c.PublicURL, "https://") {
				return errors.New("production requires HQ_PUBLIC_URL to use https")
			}
		}
	}
	return nil
}

func Load() (*Config, error) {
	c := &Config{
		Env:            env("HQ_ENV", "dev"),
		Addr:           env("HQ_ADDR", ":8080"),
		DBPath:         env("HQ_DB", "data/homequarters.db"),
		StaticDir:      env("HQ_STATIC_DIR", ""),
		Version:        env("HQ_VERSION", ""),
		OfficeSlug:     env("HQ_OFFICE_SLUG", "default"),
		OfficeName:     env("HQ_OFFICE_NAME", "Office"),
		MetricsToken:   env("HQ_METRICS_TOKEN", ""),
		SessionTTL:     time.Duration(envInt("HQ_SESSION_DAYS", 30)) * 24 * time.Hour,
		LiveKitURL:     env("LIVEKIT_URL", ""),
		LiveKitAPIURL:  env("LIVEKIT_API_URL", ""),
		LiveKitKey:     env("LIVEKIT_API_KEY", ""),
		LiveKitSecret:  env("LIVEKIT_API_SECRET", ""),
		TickHz:         envInt("HQ_TICK_HZ", 15),
		AOICells:       envInt("HQ_AOI_CELLS", 2),
		AOIMaxCells:    envInt("HQ_AOI_MAX_CELLS", 0),
		MaxPlayers:     envInt("HQ_MAX_PLAYERS", 2000),
		MaxGroup:       envInt("HQ_MAX_GROUP", 8),
		JoinRate:       envInt("HQ_JOIN_RATE", 20),
		MediaTTL:       time.Duration(envInt("HQ_MEDIA_TOKEN_TTL_SECONDS", 30)) * time.Second,
		MediaReconcile: time.Duration(envInt("HQ_MEDIA_RECONCILE_SECONDS", 10)) * time.Second,
		Demo:           env("HQ_DEMO", "") == "1" || env("HQ_DEMO", "") == "true",
		DemoReset:      time.Duration(envInt("HQ_DEMO_RESET_HOURS", 6)) * time.Hour,
		Operator:       env("HQ_OPERATOR", ""),
		Contact:        env("HQ_CONTACT", ""),
		SourceURL:      env("HQ_SOURCE_URL", "https://github.com/christphe/homequarters"),
	}
	c.StopOnStdinClose = env("HQ_STOP_ON_STDIN_CLOSE", "") == "1"
	if o := env("HQ_ALLOWED_ORIGINS", ""); o != "" {
		c.AllowedOrigins = strings.Split(o, ",")
	}
	if c.Env != "dev" && c.Env != "production" {
		return nil, errors.New("HQ_ENV must be dev or production")
	}
	if err := c.loadAuth(); err != nil {
		return nil, err
	}
	if c.LiveKitAPIURL == "" && c.LiveKitURL != "" {
		u := c.LiveKitURL
		u = strings.Replace(u, "wss://", "https://", 1)
		u = strings.Replace(u, "ws://", "http://", 1)
		c.LiveKitAPIURL = u
	}
	if c.TickHz < 5 || c.TickHz > 30 {
		return nil, errors.New("HQ_TICK_HZ must be within 5..30")
	}
	if c.AOIMaxCells == 0 { // unset: 8, or the default radius if that is already wider
		c.AOIMaxCells = max(8, c.AOICells)
	}
	if c.AOIMaxCells < c.AOICells || c.AOIMaxCells > max(8, c.AOICells) {
		return nil, errors.New("HQ_AOI_MAX_CELLS must be within HQ_AOI_CELLS..8")
	}
	if c.Env == "production" {
		if c.StopOnStdinClose {
			return nil, errors.New("HQ_STOP_ON_STDIN_CLOSE is for local tests only")
		}
		if c.LiveKitKey == "" || c.LiveKitSecret == "" || c.LiveKitURL == "" {
			return nil, errors.New("production requires LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET")
		}
		if c.LiveKitKey == "devkey" || len(c.LiveKitSecret) < 32 {
			return nil, errors.New("production requires a non-default LiveKit key and a secret with at least 32 characters")
		}
		if !strings.HasPrefix(c.LiveKitURL, "wss://") {
			return nil, errors.New("production requires LIVEKIT_URL to use wss://")
		}
		if c.MetricsToken != "" && len(c.MetricsToken) < 16 {
			return nil, errors.New("HQ_METRICS_TOKEN must have at least 16 characters")
		}
		if len(c.AllowedOrigins) == 0 {
			return nil, errors.New("production requires HQ_ALLOWED_ORIGINS (e.g. office.example.com)")
		}
	}
	return c, nil
}
