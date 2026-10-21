// Package media isolates everything that talks to the LiveKit SFU: short-lived
// scoped access tokens (HS256 JWT, LiveKit access-token format) and the
// server-side revocation API (Twirp RoomService over HTTP/JSON).
// The application never handles RTP: the SFU does. Keeping this tiny avoids
// pulling the whole LiveKit SDK into the game server binary.
package media

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"
)

type Config struct {
	PublicURL string // ws(s):// URL that browsers use to reach LiveKit
	APIURL    string // http(s):// URL the app server uses for admin calls
	Key       string
	Secret    string
	TokenTTL  time.Duration // validity of a join token (connection window)
}

// Grants describes what a participant may do in exactly one room.
type Grants struct {
	Room       string
	Identity   string
	Name       string
	CanPublish bool
}

type revokeJob struct {
	room, identity string
	attempt        int
}

// muteJob asks to mute one kind of track ("mic", "cam", "scr") of one participant.
type muteJob struct{ room, identity, kind string }

type Client struct {
	cfg          Config
	http         *http.Client
	queue        chan revokeJob
	mutes        chan muteJob // its own queue and worker: a flood of mutes never delays a revocation
	log          *slog.Logger
	Issued       atomic.Int64
	Revoked      atomic.Int64
	RevokeErrors atomic.Int64
	Muted        atomic.Int64 // tracks muted on request of another participant
	MuteErrors   atomic.Int64
}

func New(cfg Config, log *slog.Logger) *Client {
	if cfg.TokenTTL <= 0 {
		cfg.TokenTTL = 5 * time.Minute
	}
	return &Client{cfg: cfg, http: &http.Client{Timeout: 5 * time.Second}, queue: make(chan revokeJob, 4096), mutes: make(chan muteJob, 256), log: log}
}

func (c *Client) Enabled() bool {
	return c != nil && c.cfg.Key != "" && c.cfg.Secret != "" && c.cfg.PublicURL != ""
}
func (c *Client) PublicURL() string { return c.cfg.PublicURL }

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func (c *Client) sign(claims map[string]any) (string, error) {
	hdr := b64([]byte(`{"alg":"HS256","typ":"JWT"}`))
	pl, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	unsigned := hdr + "." + b64(pl)
	m := hmac.New(sha256.New, []byte(c.cfg.Secret))
	m.Write([]byte(unsigned))
	return unsigned + "." + b64(m.Sum(nil)), nil
}

// Token returns a join token scoped to one room and one identity, valid for a
// few minutes (only the connection window; revocation happens server side).
func (c *Client) Token(g Grants) (string, error) {
	if !c.Enabled() {
		return "", errors.New("media disabled")
	}
	now := time.Now()
	video := map[string]any{
		"room":           g.Room,
		"roomJoin":       true,
		"canSubscribe":   true,
		"canPublish":     g.CanPublish,
		"canPublishData": false,
	}
	if g.CanPublish {
		video["canPublishSources"] = []string{"microphone", "camera", "screen_share", "screen_share_audio"}
	}
	t, err := c.sign(map[string]any{
		"iss":   c.cfg.Key,
		"sub":   g.Identity,
		"name":  g.Name,
		"nbf":   now.Add(-10 * time.Second).Unix(),
		"exp":   now.Add(c.cfg.TokenTTL).Unix(),
		"video": video,
	})
	if err == nil {
		c.Issued.Add(1)
	}
	return t, err
}

func (c *Client) adminToken(room string) (string, error) {
	now := time.Now()
	return c.sign(map[string]any{
		"iss":   c.cfg.Key,
		"nbf":   now.Add(-10 * time.Second).Unix(),
		"exp":   now.Add(time.Minute).Unix(),
		"video": map[string]any{"roomAdmin": true, "room": room},
	})
}

// Revoke asks the SFU to disconnect the identity from the room. It is
// asynchronous, bounded and retried; it never blocks the world loop.
func (c *Client) Revoke(room, identity string) {
	if !c.Enabled() {
		return
	}
	select {
	case c.queue <- revokeJob{room: room, identity: identity}:
	default:
		c.RevokeErrors.Add(1)
		c.log.Error("media revoke queue full", "room", room)
	}
}

// Run drains the revocation queue (and, on a second goroutine, the mute queue) until ctx is cancelled.
func (c *Client) Run(ctx context.Context) {
	go c.runMutes(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case j := <-c.queue:
			if err := c.removeParticipant(ctx, j.room, j.identity); err != nil {
				j.attempt++
				if j.attempt < 5 {
					go func(j revokeJob) {
						select {
						case <-time.After(time.Duration(j.attempt) * 500 * time.Millisecond):
							select {
							case c.queue <- j:
							default:
							}
						case <-ctx.Done():
						}
					}(j)
				} else {
					c.RevokeErrors.Add(1)
					c.log.Error("media revoke failed", "room", j.room, "err", err)
				}
			} else {
				c.Revoked.Add(1)
			}
		}
	}
}

// muteSources maps a mute kind to LiveKit's TrackSource values (names and numbers, see muteTracks).
var muteSources = map[string][]string{
	"mic": {"MICROPHONE", "2"},
	"cam": {"CAMERA", "1"},
	"scr": {"SCREEN_SHARE", "3", "SCREEN_SHARE_AUDIO", "4"},
}

// Mute asks the SFU to mute the identity's published tracks of one kind in room: "mic", "cam" or "scr"
// (the screen and its audio). It is asynchronous and bounded like Revoke and never blocks the world loop.
// There is no way to unmute: a track only comes back when its owner turns it on.
func (c *Client) Mute(room, identity, kind string) {
	if !c.Enabled() || muteSources[kind] == nil {
		return
	}
	select {
	case c.mutes <- muteJob{room: room, identity: identity, kind: kind}:
	default:
		c.MuteErrors.Add(1) // counted, not logged: a client can cause it
	}
}

func (c *Client) runMutes(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case j := <-c.mutes:
			// Not retried: the person may turn the track back on meanwhile, and a late mute would turn it
			// off again. Their own client releases the device on the server's message anyway.
			if err := c.muteTracks(ctx, j.room, j.identity, j.kind); err != nil {
				c.MuteErrors.Add(1)
				c.log.Error("media mute failed", "room", j.room, "err", err)
			}
		}
	}
}

// muteTracks looks the participant's tracks up on the SFU (the client never names a track) and mutes the
// ones of that kind that are not muted yet.
func (c *Client) muteTracks(ctx context.Context, room, identity, kind string) error {
	var info struct {
		Tracks []struct {
			Sid    string          `json:"sid"`
			Source json.RawMessage `json:"source"`
			Muted  bool            `json:"muted"`
		} `json:"tracks"`
	}
	if err := c.twirp(ctx, "GetParticipant", room, map[string]any{"room": room, "identity": identity}, &info); err != nil {
		return err
	}
	for _, t := range info.Tracks {
		if t.Muted || t.Sid == "" || !hasSource(muteSources[kind], t.Source) {
			continue
		}
		var out struct{}
		if err := c.twirp(ctx, "MutePublishedTrack", room, map[string]any{"room": room, "identity": identity, "track_sid": t.Sid, "muted": true}, &out); err != nil {
			return err
		}
		c.Muted.Add(1)
	}
	return nil
}

// hasSource reports whether a TrackSource, as LiveKit's JSON writes it (a name or a number), is one of want.
func hasSource(want []string, raw json.RawMessage) bool {
	var name string
	if json.Unmarshal(raw, &name) != nil {
		name = string(raw) // a number
	}
	for _, w := range want {
		if w == name {
			return true
		}
	}
	return false
}

func (c *Client) removeParticipant(ctx context.Context, room, identity string) error {
	tok, err := c.adminToken(room)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"room": room, "identity": identity})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.APIURL+"/twirp/livekit.RoomService/RemoveParticipant", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil // room or participant already gone: revoked
	}
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		// twirp "not_found" arrives as 404; anything else is a real error
		return fmt.Errorf("livekit status %d: %s", resp.StatusCode, b)
	}
	return nil
}

// signRaw returns the HS256 signature of an already assembled header.payload string (used by tests).
func signRaw(c *Client, unsigned string) string {
	m := hmac.New(sha256.New, []byte(c.cfg.Secret))
	m.Write([]byte(unsigned))
	return b64(m.Sum(nil))
}
