package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// ErrIdentityTaken means the identity, or the user's slot for that provider,
// already belongs to someone: one Google account is one member, and linking
// must never move an account from one person to another.
var ErrIdentityTaken = errors.New("identity already linked to another member")

// Identity is what a sign-in provider proved about a person.
type Identity struct {
	Provider string
	Subject  string
	Email    string
}

func (id Identity) valid() bool {
	return id.Provider != "" && id.Subject != "" && len(id.Subject) <= 255 && len(id.Email) <= 320
}

// UserByIdentity returns the member of the office an identity signs in as.
// An identity whose user is no longer a member is not found: removal is not a
// ban, but a removed member is admitted again like anybody new.
func (s *Store) UserByIdentity(ctx context.Context, officeID int64, provider, subject string) (int64, error) {
	var uid int64
	err := s.DB.QueryRowContext(ctx, `SELECT i.user_id FROM identities i
		JOIN memberships m ON m.user_id = i.user_id AND m.office_id = ?
		WHERE i.provider = ? AND i.subject = ?`, officeID, provider, subject).Scan(&uid)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return uid, err
}

// HasIdentityFor reports whether a user signs in through one of these providers.
func (s *Store) HasIdentityFor(ctx context.Context, userID int64, providers []string) (bool, error) {
	for _, p := range providers {
		var one int
		err := s.DB.QueryRowContext(ctx, `SELECT 1 FROM identities WHERE user_id=? AND provider=?`, userID, p).Scan(&one)
		if err == nil {
			return true, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return false, err
		}
	}
	return false, nil
}

// LinkIdentity attaches an identity to an existing member: how a member who
// joined before sign-in existed keeps their account. Linking the identity the
// user already has is a no-op; any other conflict is ErrIdentityTaken.
func (s *Store) LinkIdentity(ctx context.Context, officeID, userID int64, id Identity) error {
	if !id.valid() {
		return errors.New("invalid identity")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var one int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM memberships WHERE user_id=? AND office_id=?`, userID, officeID).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	var owner int64
	err = tx.QueryRowContext(ctx, `SELECT user_id FROM identities WHERE provider=? AND subject=?`, id.Provider, id.Subject).Scan(&owner)
	switch {
	case err == nil && owner == userID:
		return tx.Commit()
	case err == nil:
		return ErrIdentityTaken
	case !errors.Is(err, sql.ErrNoRows):
		return err
	}
	if err := insertIdentity(ctx, tx, userID, id); err != nil {
		return err
	}
	return tx.Commit()
}

func insertIdentity(ctx context.Context, tx *sql.Tx, userID int64, id Identity) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO identities(provider,subject,user_id,email,created_at) VALUES (?,?,?,?,?)`,
		id.Provider, id.Subject, userID, strings.ToLower(id.Email), time.Now().Unix())
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		return ErrIdentityTaken
	}
	return err
}

// AddMemberWithIdentity creates a member who signed in, in one transaction:
// the invite (when there is one) is spent, the user and membership created and
// the identity attached, so a failure leaves no half-made member and no spent
// invite. forceRole is used when there is no invite ("" lets the first member
// of an office become admin, as AddMember does).
func (s *Store) AddMemberWithIdentity(ctx context.Context, officeID int64, name string, avatar json.RawMessage, forceRole, invite string, id Identity) (userID int64, role string, err error) {
	if !id.valid() {
		return 0, "", errors.New("invalid identity")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, "", err
	}
	defer tx.Rollback()
	if invite != "" {
		inv, err := consumeInvite(ctx, tx, invite)
		if err != nil {
			return 0, "", err
		}
		if inv.OfficeID != officeID {
			return 0, "", ErrInviteInvalid
		}
		forceRole = inv.Role
	}
	userID, role, err = addMember(ctx, tx, officeID, name, avatar, forceRole)
	if err != nil {
		return 0, "", err
	}
	if err := insertIdentity(ctx, tx, userID, id); err != nil {
		return 0, "", err
	}
	return userID, role, tx.Commit()
}
