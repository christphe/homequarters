package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// ErrSeal means a sealed value was forged, damaged or expired.
var ErrSeal = errors.New("invalid or expired sealed value")

// Sealer signs small values that the browser carries in a cookie between two
// requests (a sign-in in progress, a new identity waiting for its name), so
// the server keeps nothing in memory for them: no table to fill, nothing to
// bound. The key is drawn at start and never leaves the process; a restart
// voids what was in flight, which costs one more click.
type Sealer struct{ key []byte }

func NewSealer() *Sealer {
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		panic(err)
	}
	return &Sealer{key: k}
}

type sealed struct {
	V   json.RawMessage `json:"v"`
	Exp int64           `json:"e"`
	Use string          `json:"u"` // what the value is for: a flow cannot be replayed as a signup
}

func (s *Sealer) mac(b []byte) []byte {
	m := hmac.New(sha256.New, s.key)
	m.Write(b)
	return m.Sum(nil)
}

// Seal returns v, signed, valid for ttl, for the purpose use.
func (s *Sealer) Seal(use string, v any, ttl time.Duration) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	body, _ := json.Marshal(sealed{V: raw, Exp: time.Now().Add(ttl).Unix(), Use: use})
	return base64.RawURLEncoding.EncodeToString(body) + "." + base64.RawURLEncoding.EncodeToString(s.mac(body)), nil
}

// Open checks the signature, the purpose and the expiry, then decodes into v.
func (s *Sealer) Open(use, tok string, v any) error {
	if len(tok) > 4096 {
		return ErrSeal
	}
	b64, sig64, ok := strings.Cut(tok, ".")
	if !ok {
		return ErrSeal
	}
	body, err1 := base64.RawURLEncoding.DecodeString(b64)
	sig, err2 := base64.RawURLEncoding.DecodeString(sig64)
	if err1 != nil || err2 != nil || !hmac.Equal(sig, s.mac(body)) {
		return ErrSeal
	}
	var w sealed
	if json.Unmarshal(body, &w) != nil || w.Use != use || time.Now().Unix() > w.Exp {
		return ErrSeal
	}
	if json.Unmarshal(w.V, v) != nil {
		return ErrSeal
	}
	return nil
}
