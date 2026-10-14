package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"testing"

	"github.com/coder/websocket"

	"tilework/internal/world"
)

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

func TestOnlyAbnormalDisconnectsHaveAReason(t *testing.T) {
	closed := func(code websocket.StatusCode) error { return websocket.CloseError{Code: code} }
	for _, c := range []struct {
		name   string
		err    error
		kicked world.KickReason
		ping   bool
		want   string
	}{
		{"page closed", closed(websocket.StatusNormalClosure), 0, false, ""},
		{"navigated away", closed(websocket.StatusGoingAway), 0, false, ""},
		{"second tab", closed(4001), world.KickReplaced, false, ""},
		{"evicted by an admin", context.Canceled, world.KickEvicted, false, ""},
		{"server shutdown", fmt.Errorf("read: %w", context.Canceled), 0, false, ""},
		{"slow client", context.Canceled, world.KickSlow, false, "client too slow (reliable queue overflow)"},
		{"ping lost", context.Canceled, 0, true, "no answer to ping"},
		{"odd close code", closed(websocket.StatusProtocolError), 0, false, "closed by the client with status 1002"},
		{"network cut", fmt.Errorf("read: %w", io.ErrUnexpectedEOF), 0, false, "connection lost without a close frame"},
		{"timeout", fmt.Errorf("read: %w", timeoutErr{}), 0, false, "network timeout"},
		{"other", errors.New("boom"), 0, false, "connection error"},
	} {
		if got := dropReason(c.err, c.kicked, c.ping); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestClientDiagnosticsAreAllowListedAndBounded(t *testing.T) {
	for _, c := range []struct {
		kind string
		code int
		ms   int64
		ok   bool
	}{
		{"media-drop", 2, 0, true},
		{"media-join", 0, 0, true},
		{"ws-drop", 1006, 4200, true},
		{"ws-drop", 999, 0, false},
		{"media-drop", 500, 0, false},
		{"anything", 0, 0, false},
		{"ws-drop", 1006, -1, false},
		{"ws-drop", 1006, 1 << 40, false},
	} {
		if validDiag(c.kind, c.code, c.ms) != c.ok {
			t.Errorf("validDiag(%q, %d, %d) != %v", c.kind, c.code, c.ms, c.ok)
		}
	}
}
