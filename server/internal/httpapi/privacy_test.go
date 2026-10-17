package httpapi

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"tilework/internal/config"
)

func privacyBody(t *testing.T, ts string) string {
	t.Helper()
	resp, err := http.Get(ts + "/privacy")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("privacy: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	return string(b)
}

func TestPrivacyPolicyFollowsTheConfiguration(t *testing.T) {
	plain := privacyBody(t, newRig(t, nil).ts.URL)
	for _, want := range []string{"Privacy policy", "never recorded", "contact the administrators", "500 messages", "Your profile is kept", `href="/"`} {
		if !strings.Contains(plain, want) {
			t.Errorf("without sign-in the policy lacks %q", want)
		}
	}
	for _, not := range []string{"Google", "sign-in account"} {
		if strings.Contains(plain, not) {
			t.Errorf("without sign-in the policy mentions %q", not)
		}
	}
	r := newAuthRig(t, func(c *config.Config) {
		c.AuthProviders = []string{"google", "fake-oidc"}
		c.GoogleClientID, c.GoogleClientSecret = "id", "secret"
		c.Operator, c.Contact = `Fantastic <Jam>`, "privacy@example.com"
	})
	google := privacyBody(t, r.ts.URL)
	for _, want := range []string{"Limited Use", "openid", "Fantastic &lt;Jam&gt;", `href="mailto:privacy@example.com"`, "sign-in email address"} {
		if !strings.Contains(google, want) {
			t.Errorf("with Google the policy lacks %q", want)
		}
	}
}
