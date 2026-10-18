// Package auth signs people in through OpenID Connect providers (Google, and a
// fake one for development and tests). It is the only package that speaks to a
// provider. It knows nothing about members: it proves who somebody is, and
// httpapi decides what that person may do.
//
// The flow is the authorization code flow with PKCE. The id_token comes back
// from the provider's token endpoint, over a connection this server opened
// (TLS for Google), so its claims are checked but its signature is not: that is
// what OpenID Connect Core 3.1.3.7 allows for this flow, and it keeps a JWT and
// key-rotation library out of the build.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Provider is one OpenID Connect provider as this server uses it.
type Provider struct {
	Name     string   // "google", "fake-oidc": also the path segment of its routes
	Issuers  []string // accepted iss values
	AuthURL  string   // where the browser is sent
	TokenURL string   // where this server exchanges the code
	ClientID string
	Secret   string
	HTTP     *http.Client
}

// Google returns the Google provider for a registered OAuth client.
func Google(clientID, secret string) *Provider {
	return &Provider{
		Name:     "google",
		Issuers:  []string{"https://accounts.google.com", "accounts.google.com"},
		AuthURL:  "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL: "https://oauth2.googleapis.com/token",
		ClientID: clientID,
		Secret:   secret,
		HTTP:     &http.Client{Timeout: 10 * time.Second},
	}
}

// Claims is what a provider proved about a person. Only the subject identifies
// them; the email is for people to read and the domain decides admission.
type Claims struct {
	Subject       string
	Email         string
	EmailVerified bool
	// Domain is the organisation the account belongs to (Google's hd claim:
	// set for Workspace accounts only), lower case, empty for personal accounts.
	Domain string
}

// AuthCodeURL is the provider page the browser is sent to. Only openid and
// email are asked for: the name and picture stay chosen in Home Quarters.
func (p *Provider) AuthCodeURL(redirectURI, state, nonce, verifier, loginHint string) string {
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {p.ClientID},
		"redirect_uri":          {redirectURI},
		"scope":                 {"openid email"},
		"state":                 {state},
		"nonce":                 {nonce},
		"code_challenge":        {Challenge(verifier)},
		"code_challenge_method": {"S256"},
	}
	if loginHint != "" {
		q.Set("login_hint", loginHint)
	}
	sep := "?"
	if strings.Contains(p.AuthURL, "?") {
		sep = "&"
	}
	return p.AuthURL + sep + q.Encode()
}

// Challenge is the S256 PKCE challenge of a verifier.
func Challenge(verifier string) string {
	h := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

// Exchange trades an authorization code for the person's claims and checks
// them: issuer, audience, expiry and the nonce this flow sent.
func (p *Provider) Exchange(ctx context.Context, code, redirectURI, verifier, nonce string) (*Claims, error) {
	if code == "" || len(code) > 2048 {
		return nil, errors.New("missing or oversized code")
	}
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"client_id":     {p.ClientID},
		"client_secret": {p.Secret},
		"code_verifier": {verifier},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	hc := p.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 10 * time.Second}
	}
	res, err := hc.Do(req)
	if err != nil {
		// the url.Error wrapper quotes the URL; keep only the cause
		if inner := errors.Unwrap(err); inner != nil {
			err = inner
		}
		return nil, fmt.Errorf("token endpoint unreachable: %w", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return nil, errors.New("token response unreadable")
	}
	if res.StatusCode != http.StatusOK {
		// the body may echo the code: report the status only
		return nil, fmt.Errorf("token endpoint answered %d", res.StatusCode)
	}
	var tr struct {
		IDToken string `json:"id_token"`
	}
	if err := json.Unmarshal(body, &tr); err != nil || tr.IDToken == "" {
		return nil, errors.New("token response has no id_token")
	}
	return p.checkIDToken(tr.IDToken, nonce, time.Now())
}

// idClaims is the id_token payload. aud may be a string or a list.
type idClaims struct {
	Iss           string          `json:"iss"`
	Sub           string          `json:"sub"`
	Aud           json.RawMessage `json:"aud"`
	Exp           int64           `json:"exp"`
	Iat           int64           `json:"iat"`
	Nonce         string          `json:"nonce"`
	Email         string          `json:"email"`
	EmailVerified json.RawMessage `json:"email_verified"`
	HD            string          `json:"hd"`
}

// Clock skew tolerated on exp and iat.
const skew = 2 * time.Minute

func (p *Provider) checkIDToken(tok, nonce string, now time.Time) (*Claims, error) {
	if len(tok) > 16<<10 {
		return nil, errors.New("id_token too large")
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return nil, errors.New("id_token is not a JWT")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errors.New("id_token payload is not base64url")
	}
	var c idClaims
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, errors.New("id_token payload is not JSON")
	}
	issOK := false
	for _, i := range p.Issuers {
		issOK = issOK || c.Iss == i
	}
	if !issOK {
		return nil, errors.New("id_token from another issuer")
	}
	if !audHas(c.Aud, p.ClientID) {
		return nil, errors.New("id_token for another client")
	}
	if c.Exp == 0 || now.After(time.Unix(c.Exp, 0).Add(skew)) {
		return nil, errors.New("id_token expired")
	}
	if c.Iat != 0 && time.Unix(c.Iat, 0).After(now.Add(skew)) {
		return nil, errors.New("id_token issued in the future")
	}
	if nonce == "" || c.Nonce != nonce {
		return nil, errors.New("id_token nonce does not match this sign-in")
	}
	if c.Sub == "" || len(c.Sub) > 255 || len(c.Email) > 320 {
		return nil, errors.New("id_token subject missing or oversized")
	}
	// Google sends email_verified as a boolean; some providers as a string.
	verified := string(c.EmailVerified) == "true" || string(c.EmailVerified) == `"true"`
	return &Claims{Subject: c.Sub, Email: strings.ToLower(c.Email), EmailVerified: verified, Domain: strings.ToLower(c.HD)}, nil
}

func audHas(raw json.RawMessage, clientID string) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one == clientID
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		for _, a := range many {
			if a == clientID {
				return true
			}
		}
	}
	return false
}

// Random returns n random bytes, base64url encoded: states, nonces, verifiers.
func Random(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand does not fail on supported platforms
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
