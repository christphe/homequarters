package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"strings"
	"time"
)

var ErrAccountLinkInvalid = errors.New("account link invalid")

// CreateAccountLink mints the personal link of one user and returns the opaque
// token; only its hash is stored. There is one per user, so minting a new link
// is also how the previous one is revoked - which is the only revocation this
// needs, because the link is the account and nothing else carries it.
func (s *Store) CreateAccountLink(ctx context.Context, userID, officeID int64) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	tok := base64.RawURLEncoding.EncodeToString(raw)
	_, err := s.DB.ExecContext(ctx, `INSERT INTO account_links(user_id,office_id,token_hash,created_at) VALUES (?,?,?,?)
		ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash, office_id=excluded.office_id, created_at=excluded.created_at`,
		userID, officeID, hashToken(tok), time.Now().Unix())
	return tok, err
}

// RedeemAccountLink opens a session for the user a link belongs to and ends
// every other session they hold in that office.
//
// Ending the others is the point rather than a limitation: moving between a
// laptop, a Mac and a desktop is what this is for, and one live session per
// account means a stolen link cannot be used quietly - the person it was taken
// from is logged out, which is the only signal a bearer token can give.
//
// providers are the sign-in providers configured now: a member who signs in
// with one of them has no use for a bearer link, and honouring one would let a
// leaked link bypass the sign-in.
func (s *Store) RedeemAccountLink(ctx context.Context, tok string, ttl time.Duration, providers []string) (session string, userID, officeID int64, err error) {
	if tok == "" || len(tok) > 128 {
		return "", 0, 0, ErrAccountLinkInvalid
	}
	err = s.DB.QueryRowContext(ctx, `SELECT user_id, office_id FROM account_links WHERE token_hash=?`,
		hashToken(tok)).Scan(&userID, &officeID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, 0, ErrAccountLinkInvalid
	}
	if err != nil {
		return "", 0, 0, err
	}
	// A membership can be revoked after the link was minted. The link must not
	// outlive it, or removing someone from the office would not remove them.
	var one int
	if err := s.DB.QueryRowContext(ctx, `SELECT 1 FROM memberships WHERE user_id=? AND office_id=?`,
		userID, officeID).Scan(&one); err != nil {
		return "", 0, 0, ErrAccountLinkInvalid
	}
	if len(providers) > 0 {
		linked, err := s.HasIdentityFor(ctx, userID, providers)
		if err != nil {
			return "", 0, 0, err
		}
		if linked {
			return "", 0, 0, ErrAccountLinkInvalid
		}
	}
	if _, err := s.DB.ExecContext(ctx, `DELETE FROM sessions WHERE user_id=? AND office_id=?`,
		userID, officeID); err != nil {
		return "", 0, 0, err
	}
	session, err = s.CreateSession(ctx, userID, officeID, ttl)
	return session, userID, officeID, err
}

// MemberByName finds one member of an office by the name shown in the office.
// Names are not unique, so an ambiguous one is an error rather than a guess:
// handing someone else's account link out would be the worst way to resolve a
// tie.
func (s *Store) MemberByName(ctx context.Context, officeID int64, name string) (int64, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT u.id, u.name FROM users u
		JOIN memberships m ON m.user_id = u.id AND m.office_id = ?`, officeID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var found int64
	var matches int
	want := strings.ToLower(strings.TrimSpace(name))
	for rows.Next() {
		var id int64
		var n string
		if err := rows.Scan(&id, &n); err != nil {
			return 0, err
		}
		if strings.ToLower(n) == want {
			found, matches = id, matches+1
		}
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	switch {
	case matches == 0:
		return 0, errors.New("no member of this office is called " + name)
	case matches > 1:
		return 0, errors.New("several members are called " + name + "; rename one or use -account-link-id")
	}
	return found, nil
}
