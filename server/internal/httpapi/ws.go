package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"homequarters/internal/plugin"
	"homequarters/internal/store"
	"homequarters/internal/world"
)

type inMsg struct {
	T     string `json:"t"`
	S     uint32 `json:"s"`
	X     int    `json:"x"`
	Y     int    `json:"y"`
	V     string `json:"v"`
	B     bool   `json:"b"`
	ID    uint32 `json:"id"`
	Scope string `json:"sc"`
	Text  string `json:"text"`
	C     int64  `json:"c"`
	N     int    `json:"n"`
}

const maxFrame = 2048

func (s *Server) ws(w http.ResponseWriter, r *http.Request) {
	se, err := s.session(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	office, err := s.st.OfficeBySlug(r.Context(), s.cfg.OfficeSlug)
	if err != nil || office.ID != se.OfficeID {
		// single-office deployment for now: the session must belong to it
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	wd, err := s.worldFor(office)
	if err != nil {
		s.log.Error("world", "err", err)
		http.Error(w, "unavailable", http.StatusInternalServerError)
		return
	}
	opts := &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled}
	if len(s.cfg.AllowedOrigins) > 0 {
		opts.OriginPatterns = s.cfg.AllowedOrigins
	}
	c, err := websocket.Accept(w, r, opts)
	if err != nil {
		return // Accept already replied
	}
	c.SetReadLimit(maxFrame)
	ctx, cancel := context.WithCancel(s.ctx)
	defer cancel()

	role := se.Role
	started := time.Now()
	var pingFailed atomic.Bool
	// Only abnormal endings are logged (Warn), never a normal leave: ids, a reason and a duration,
	// no names, no content, no addresses.
	warn := func(msg string, args ...any) {
		s.log.Warn(msg, append([]any{"user", se.UserID, "office", office.ID, "after_s", int(time.Since(started).Seconds())}, args...)...)
	}
	// The world calls this synchronously, right before it closes the outbound channel, so the writer
	// below always knows the reason when it sees the channel close. It must stay non-blocking.
	var closeReason atomic.Uint32
	conn, err := wd.Join(ctx, world.UserInfo{ID: uint32(se.UserID), Name: se.Name, Avatar: se.Avatar, Role: role,
		LastX: se.LastX, LastY: se.LastY}, func(reason world.KickReason) { closeReason.Store(uint32(reason)) })
	if err != nil {
		c.Close(websocket.StatusTryAgainLater, "office unavailable")
		return
	}
	defer func() {
		dctx, dc := context.WithTimeout(s.ctx, time.Second)
		conn.Detach(dctx)
		dc()
	}()

	// writer
	go func() {
		defer cancel()
		for {
			select {
			case b, ok := <-conn.Out:
				if !ok {
					switch world.KickReason(closeReason.Load()) {
					case world.KickReplaced:
						c.Close(websocket.StatusCode(4001), "replaced by a newer connection")
					case world.KickEvicted:
						c.Close(websocket.StatusCode(4003), "removed by an administrator or role changed")
					case world.KickSlow:
						c.Close(websocket.StatusCode(4002), "client too slow")
					default:
						c.Close(websocket.StatusTryAgainLater, "closed by server")
					}
					return
				}
				wctx, wc := context.WithTimeout(ctx, 5*time.Second)
				err := c.Write(wctx, websocket.MessageText, b)
				wc()
				if err != nil {
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// keepalive
	go func() {
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				pctx, pc := context.WithTimeout(ctx, 10*time.Second)
				err := c.Ping(pctx)
				pc()
				if err != nil {
					pingFailed.Store(ctx.Err() == nil) // a ping lost while the session was still open
					cancel()
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	inputRL := newConnBucket(40, 80)
	ctrlRL := newConnBucket(10, 30)
	chatRL := newConnBucket(3, 8)
	boardRL := newConnBucket(60, 120)
	pluginRL := newConnBucket(10, 20)
	s.mu.Lock()
	host := s.hosts[office.ID]
	s.mu.Unlock()
	strikes := 0
	diags := 0
	var m inMsg
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			if why := dropReason(err, world.KickReason(closeReason.Load()), pingFailed.Load()); why != "" {
				warn("websocket dropped", "reason", why)
			}
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		now := time.Now()
		m = inMsg{}
		if err := json.Unmarshal(data, &m); err != nil {
			strikes++
			if strikes > 20 {
				warn("websocket closed by the server", "reason", "invalid messages")
				c.Close(websocket.StatusPolicyViolation, "invalid messages")
				return
			}
			continue
		}
		rl := ctrlRL
		switch m.T {
		case "in":
			rl = inputRL
		case "chat":
			rl = chatRL
		case "wb":
			rl = boardRL
		case "plg":
			rl = pluginRL
		}
		if !rl.allow(now) {
			strikes++
			if strikes > 200 {
				warn("websocket closed by the server", "reason", "rate limit")
				c.Close(websocket.StatusPolicyViolation, "rate limit")
				return
			}
			continue
		}
		switch m.T {
		case "in":
			if m.X < -1 || m.X > 1 || m.Y < -1 || m.Y > 1 {
				continue
			}
			conn.Input(ctx, m.S, int8(m.X), int8(m.Y), m.B)
		case "go":
			conn.GoTo(ctx, m.X, m.Y, m.ID)
		case "st":
			conn.SetStatus(ctx, m.V)
		case "consent":
			conn.SetConsent(ctx, m.B)
		case "chat":
			if len(m.Text) > 4*world.DefaultConfig().MaxChatRune {
				continue
			}
			conn.Chat(ctx, m.Scope, m.ID, m.Text)
		case "loc":
			conn.Locate(ctx, m.ID)
		case "emo":
			conn.Emote(ctx, m.N)
		case "view":
			conn.View(ctx, m.N)
		case "hand":
			conn.Hand(ctx, m.B)
		case "note":
			if len(m.Text) > 400 {
				continue
			}
			conn.Note(ctx, m.Text)
		case "wave":
			conn.Wave(ctx, m.ID)
		case "use":
			conn.Use(ctx, m.X, m.Y)
		case "fol":
			conn.Follow(ctx, m.ID)
		case "lead":
			conn.Lead(ctx, m.ID)
		case "lock":
			conn.Lock(ctx, m.B)
		case "knock":
			conn.Knock(ctx, m.N)
		case "force":
			conn.Force(ctx, m.N)
		case "diag":
			// A client reporting a problem it saw (a media drop, a failed media join, a lost socket).
			// Allow-listed kinds and bounded numbers only, a few per session: nothing free-form is logged.
			if diags < maxDiags && validDiag(m.V, m.N, m.C) {
				diags++
				warn("client reported a problem", "kind", m.V, "code", m.N, "ms", m.C)
			}
		case "kans":
			conn.KnockAnswer(ctx, m.ID, m.B)
		case "wb":
			var wb world.BoardMsg
			if json.Unmarshal(data, &wb) == nil {
				conn.Board(ctx, &wb)
			}
		case "plg":
			var pm struct {
				PL string          `json:"pl"`
				D  json.RawMessage `json:"d"`
			}
			if host != nil && json.Unmarshal(data, &pm) == nil && len(pm.D) > 0 && len(pm.D) <= maxPluginMsg {
				host.Message(plugin.Player{ID: uint32(se.UserID), Name: se.Name, Role: role}, pm.PL, pm.D)
			}
		case "sync":
			conn.Sync(ctx)
		case "tok":
			conn.RequestToken(ctx)
		case "ping":
			wctx, wc := context.WithTimeout(ctx, 2*time.Second)
			c.Write(wctx, websocket.MessageText, []byte(`{"t":"pong","c":`+strconv.FormatInt(m.C, 10)+`}`))
			wc()
		}
	}
}

var _ = store.ErrNotFound

const maxDiags = 20

// validDiag accepts the problems a client may report: an unexpected media disconnect (LiveKit's
// DisconnectReason), a failed media join, and a WebSocket that dropped (its close code and how long
// the client was offline, reported once reconnected).
func validDiag(kind string, code int, ms int64) bool {
	if ms < 0 || ms > 24*3600*1000 {
		return false
	}
	switch kind {
	case "media-drop":
		return code >= 0 && code <= 64
	case "media-join":
		return code == 0
	case "ws-drop":
		return code >= 1000 && code <= 4999
	}
	return false
}

// dropReason says why a session's read ended when that is not a normal leave, or "" when it is: the
// client closed the page (1000, 1001), a newer tab took over, an admin evicted the member (audited
// already), or the server is shutting down.
func dropReason(err error, kicked world.KickReason, pingFailed bool) string {
	switch kicked {
	case world.KickSlow:
		return "client too slow (reliable queue overflow)"
	case world.KickReplaced, world.KickEvicted:
		return ""
	}
	if pingFailed {
		return "no answer to ping"
	}
	switch websocket.CloseStatus(err) {
	case websocket.StatusNormalClosure, websocket.StatusGoingAway:
		return ""
	case -1:
	default:
		return "closed by the client with status " + strconv.Itoa(int(websocket.CloseStatus(err)))
	}
	var ne net.Error
	switch {
	case errors.Is(err, context.Canceled):
		return "" // the server ended the session (shutdown, or the writer stopped after a kick)
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "connection lost without a close frame"
	case errors.As(err, &ne) && ne.Timeout():
		return "network timeout"
	}
	return "connection error"
}
