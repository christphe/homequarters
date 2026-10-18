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

// AppTokenPrefix starts every app token, so a leaked one is recognisable.
const AppTokenPrefix = "hqp_"

var ErrAppTokenInvalid = errors.New("app token invalid")

// AppTokenOwner is who a valid app token acts for.
type AppTokenOwner struct {
	OfficeID int64
	UserID   int64
	Plugin   string
	Name     string
	Role     string
}

// CreateAppToken mints a member's token for one plugin, replacing any previous one, and returns it;
// only its hash is stored.
func (s *Store) CreateAppToken(ctx context.Context, officeID, userID int64, plugin string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	tok := AppTokenPrefix + base64.RawURLEncoding.EncodeToString(raw)
	_, err := s.DB.ExecContext(ctx, `INSERT INTO app_tokens(office_id,user_id,plugin,token_hash,created_at) VALUES (?,?,?,?,?)
		ON CONFLICT(office_id,user_id,plugin) DO UPDATE SET token_hash=excluded.token_hash, created_at=excluded.created_at, last_used_at=NULL`,
		officeID, userID, plugin, hashToken(tok), time.Now().Unix())
	return tok, err
}

// AppTokenInfo says whether a member has a token for a plugin, and when it was created (unix seconds).
func (s *Store) AppTokenInfo(ctx context.Context, officeID, userID int64, plugin string) (createdAt int64, ok bool, err error) {
	err = s.DB.QueryRowContext(ctx, `SELECT created_at FROM app_tokens WHERE office_id=? AND user_id=? AND plugin=?`,
		officeID, userID, plugin).Scan(&createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return createdAt, err == nil, err
}

func (s *Store) DeleteAppToken(ctx context.Context, officeID, userID int64, plugin string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM app_tokens WHERE office_id=? AND user_id=? AND plugin=?`, officeID, userID, plugin)
	return err
}

// LookupAppToken returns who a token acts for. The member must still belong to the office.
func (s *Store) LookupAppToken(ctx context.Context, tok string) (AppTokenOwner, error) {
	var o AppTokenOwner
	if !strings.HasPrefix(tok, AppTokenPrefix) || len(tok) < len(AppTokenPrefix)+40 || len(tok) > 128 {
		return o, ErrAppTokenInvalid
	}
	err := s.DB.QueryRowContext(ctx, `SELECT t.office_id, t.user_id, t.plugin, u.name, m.role FROM app_tokens t
		JOIN memberships m ON m.office_id = t.office_id AND m.user_id = t.user_id
		JOIN users u ON u.id = t.user_id
		WHERE t.token_hash=?`, hashToken(tok)).Scan(&o.OfficeID, &o.UserID, &o.Plugin, &o.Name, &o.Role)
	if errors.Is(err, sql.ErrNoRows) {
		return o, ErrAppTokenInvalid
	}
	return o, err
}

// TouchAppToken records that a token was used now.
func (s *Store) TouchAppToken(ctx context.Context, tok string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE app_tokens SET last_used_at=? WHERE token_hash=?`, time.Now().Unix(), hashToken(tok))
	return err
}
