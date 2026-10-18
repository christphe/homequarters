package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestAppTokens(t *testing.T) {
	s, o := open(t)
	ctx := context.Background()
	ana, _, _ := s.AddMember(ctx, o.ID, "Ana", json.RawMessage("{}"), "")
	bia, _, _ := s.AddMember(ctx, o.ID, "Bia", json.RawMessage("{}"), "")

	if _, ok, err := s.AppTokenInfo(ctx, o.ID, ana, "pet"); err != nil || ok {
		t.Fatalf("no token yet: %v %v", ok, err)
	}
	tok, err := s.CreateAppToken(ctx, o.ID, ana, "pet")
	if err != nil || !strings.HasPrefix(tok, "hqp_") || len(tok) < 40 {
		t.Fatalf("token %q %v", tok, err)
	}
	if at, ok, _ := s.AppTokenInfo(ctx, o.ID, ana, "pet"); !ok || at == 0 {
		t.Fatal("info after create")
	}
	m, err := s.LookupAppToken(ctx, tok)
	if err != nil || m.UserID != ana || m.OfficeID != o.ID || m.Plugin != "pet" || m.Name != "Ana" || m.Role != "admin" {
		t.Fatalf("lookup: %+v %v", m, err)
	}
	// a new token replaces the old one
	tok2, _ := s.CreateAppToken(ctx, o.ID, ana, "pet")
	if _, err := s.LookupAppToken(ctx, tok); err != ErrAppTokenInvalid {
		t.Fatalf("replaced token still works: %v", err)
	}
	if _, err := s.LookupAppToken(ctx, tok2); err != nil {
		t.Fatal(err)
	}
	// per plugin and per member
	other, _ := s.CreateAppToken(ctx, o.ID, ana, "other")
	bias, _ := s.CreateAppToken(ctx, o.ID, bia, "pet")
	if m, _ := s.LookupAppToken(ctx, other); m.Plugin != "other" {
		t.Fatalf("other plugin: %+v", m)
	}
	// revoke
	if err := s.DeleteAppToken(ctx, o.ID, ana, "pet"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.LookupAppToken(ctx, tok2); err != ErrAppTokenInvalid {
		t.Fatalf("revoked token: %v", err)
	}
	// removing a member removes their tokens
	if _, err := s.RemoveMember(ctx, o.ID, bia); err != nil {
		t.Fatal(err)
	}
	if _, err := s.LookupAppToken(ctx, bias); err != ErrAppTokenInvalid {
		t.Fatalf("removed member's token: %v", err)
	}
	for _, bad := range []string{"", "hqp_", "nope", strings.Repeat("x", 300)} {
		if _, err := s.LookupAppToken(ctx, bad); err != ErrAppTokenInvalid {
			t.Fatalf("lookup %q: %v", bad, err)
		}
	}
	if err := s.TouchAppToken(ctx, other); err != nil {
		t.Fatal(err)
	}
}
