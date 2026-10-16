package store

import (
	"context"
	"testing"
)

func TestRenamedOfficeKeepsItsNameAcrossRestarts(t *testing.T) {
	s, o := open(t)
	ctx := context.Background()
	if old, err := s.RenameOffice(ctx, o.ID, "Harbour HQ"); err != nil || old != "T" {
		t.Fatalf("the rename answers the name it replaced: %q %v", old, err)
	}
	// a restart runs EnsureOffice again with the configured name: the stored one wins
	again, err := s.EnsureOffice(ctx, "default", "T", "{}")
	if err != nil || again.ID != o.ID || again.Name != "Harbour HQ" {
		t.Fatalf("the rename must survive a restart: %+v %v", again, err)
	}
	if _, err := s.RenameOffice(ctx, 999, "Nowhere"); err != ErrNotFound {
		t.Fatalf("renaming an unknown office: %v", err)
	}
}
