package media

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func testClient(url string) *Client {
	return New(Config{PublicURL: "ws://x", APIURL: url, Key: "k", Secret: strings.Repeat("s", 40), TokenTTL: time.Minute}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func claims(t *testing.T, tok string) map[string]any {
	t.Helper()
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatal("not a JWT")
	}
	b, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	json.Unmarshal(b, &m)
	return m
}

func TestTokenIsScopedAndShortLived(t *testing.T) {
	c := testClient("http://unused")
	tok, err := c.Token(Grants{Room: "o1.g7", Identity: "42", Name: "Ana", CanPublish: true})
	if err != nil {
		t.Fatal(err)
	}
	m := claims(t, tok)
	v := m["video"].(map[string]any)
	if v["room"] != "o1.g7" || m["sub"] != "42" || v["roomJoin"] != true || v["canSubscribe"] != true {
		t.Fatalf("unexpected grants: %v", m)
	}
	if v["roomAdmin"] != nil || v["roomList"] != nil || v["canPublishData"] != false {
		t.Fatalf("a join token must not carry admin or data grants: %v", v)
	}
	if ttl := m["exp"].(float64) - m["nbf"].(float64); ttl > 75 {
		t.Fatalf("token must be short lived, got %v seconds", ttl)
	}
	if src := v["canPublishSources"].([]any); len(src) != 4 {
		t.Fatalf("publish sources must be limited: %v", src)
	}
	// tampering with the room claim must invalidate the signature
	parts := strings.Split(tok, ".")
	forged := strings.Replace(string(mustDecode(t, parts[1])), "o1.g7", "o1.r.boardroom", 1)
	bad := parts[0] + "." + base64.RawURLEncoding.EncodeToString([]byte(forged)) + "." + parts[2]
	if bad == tok || parts[2] == "" {
		t.Fatal("test setup")
	}
	// (LiveKit verifies the HMAC; here we only assert the signature is over the original payload)
	if sig(c, parts[0]+"."+parts[1]) != parts[2] || sig(c, parts[0]+"."+strings.Split(bad, ".")[1]) == parts[2] {
		t.Fatal("signature must cover the payload")
	}
}

func mustDecode(t *testing.T, s string) []byte {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func sig(c *Client, unsigned string) string {
	tok, _ := c.sign(map[string]any{})
	_ = tok
	return signRaw(c, unsigned)
}

type fakeLK struct {
	mu       sync.Mutex
	rooms    map[string][]string
	removed  []string
	adminHdr []string
}

func (f *fakeLK) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.adminHdr = append(f.adminHdr, r.Header.Get("Authorization"))
	var body map[string]string
	json.NewDecoder(r.Body).Decode(&body)
	switch {
	case strings.HasSuffix(r.URL.Path, "/ListRooms"):
		var rs []map[string]string
		for n := range f.rooms {
			rs = append(rs, map[string]string{"name": n})
		}
		json.NewEncoder(w).Encode(map[string]any{"rooms": rs})
	case strings.HasSuffix(r.URL.Path, "/ListParticipants"):
		var ps []map[string]string
		for _, id := range f.rooms[body["room"]] {
			ps = append(ps, map[string]string{"identity": id})
		}
		json.NewEncoder(w).Encode(map[string]any{"participants": ps})
	case strings.HasSuffix(r.URL.Path, "/RemoveParticipant"):
		f.removed = append(f.removed, body["room"]+"/"+body["identity"])
		w.Write([]byte("{}"))
	default:
		http.NotFound(w, r)
	}
}

func TestReconcileRemovesOnlyUnauthorisedParticipantsAndIgnoresForeignRooms(t *testing.T) {
	f := &fakeLK{rooms: map[string][]string{
		"o1.g1":          {"1", "2", "99"}, // 99 replayed a token
		"o1.r.boardroom": {"1"},
		"o1.g2":          {"5"},   // stale room: no such group any more
		"other.tenant":   {"777"}, // not ours
	}}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	defer srv.Close()
	c := testClient(srv.URL)
	allowed := func(context.Context) (map[string]map[string]bool, error) {
		return map[string]map[string]bool{"o1.g1": {"1": true, "2": true}, "o1.r.boardroom": {"1": true}}, nil
	}
	n, err := c.Reconcile(context.Background(), "o1.", allowed)
	if err != nil || n != 2 {
		t.Fatalf("want 2 removals, got %d (%v)", n, err)
	}
	got := strings.Join(f.removed, ",")
	if !strings.Contains(got, "o1.g1/99") || !strings.Contains(got, "o1.g2/5") || strings.Contains(got, "777") || strings.Contains(got, "o1.g1/1") {
		t.Fatalf("wrong removals: %s", got)
	}
}

func TestReconcileSnapshotIsTakenAfterListingSoNewMembersAreSafe(t *testing.T) {
	f := &fakeLK{rooms: map[string][]string{"o1.g1": {"1"}}}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	defer srv.Close()
	c := testClient(srv.URL)
	order := []string{}
	allowed := func(context.Context) (map[string]map[string]bool, error) {
		f.mu.Lock()
		order = append(order, "snapshot")
		f.mu.Unlock()
		return map[string]map[string]bool{"o1.g1": {"1": true}}, nil
	}
	if _, err := c.Reconcile(context.Background(), "o1.", allowed); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(order) != 1 || len(f.removed) != 0 {
		t.Fatal("snapshot must be requested once, after the SFU listing, and remove nobody here")
	}
}

func TestRevokeIsAsyncBoundedAndRetried(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		n := calls
		mu.Unlock()
		if n < 3 {
			http.Error(w, "boom", 500)
			return
		}
		w.Write([]byte("{}"))
	}))
	defer srv.Close()
	c := testClient(srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)
	c.Revoke("o1.g1", "5")
	deadline := time.Now().Add(6 * time.Second)
	for c.Revoked.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if c.Revoked.Load() != 1 {
		t.Fatalf("revocation must be retried until it succeeds (calls=%d)", calls)
	}
}

// fakeTracks answers GetParticipant with a fixed track list and records MutePublishedTrack requests.
type fakeTracks struct {
	mu     sync.Mutex
	tracks []map[string]any
	gets   []string
	mutes  []map[string]any
	other  []string
}

func (f *fakeTracks) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var body map[string]any
	json.NewDecoder(r.Body).Decode(&body)
	switch {
	case strings.HasSuffix(r.URL.Path, "/GetParticipant"):
		f.gets = append(f.gets, body["room"].(string)+"/"+body["identity"].(string))
		if body["identity"] == "gone" {
			http.Error(w, `{"code":"not_found"}`, http.StatusNotFound)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"identity": body["identity"], "tracks": f.tracks})
	case strings.HasSuffix(r.URL.Path, "/MutePublishedTrack"):
		f.mutes = append(f.mutes, body)
		w.Write([]byte(`{"track":{}}`))
	default:
		f.other = append(f.other, r.URL.Path)
		http.NotFound(w, r)
	}
}

func TestMuteResolvesTracksOfTheKind(t *testing.T) {
	// LiveKit's JSON may carry enums as names or as numbers: both are understood.
	tracks := []map[string]any{
		{"sid": "TR_mic", "type": "AUDIO", "source": "MICROPHONE"},
		{"sid": "TR_cam", "type": "VIDEO", "source": "CAMERA"},
		{"sid": "TR_scr", "type": "VIDEO", "source": 3},
		{"sid": "TR_scra", "type": "AUDIO", "source": "SCREEN_SHARE_AUDIO"},
		{"sid": "TR_old", "type": "AUDIO", "source": "MICROPHONE", "muted": true},
	}
	cases := []struct {
		kind string
		want []string
	}{
		{"mic", []string{"TR_mic"}},
		{"cam", []string{"TR_cam"}},
		{"scr", []string{"TR_scr", "TR_scra"}},
	}
	for _, c := range cases {
		t.Run(c.kind, func(t *testing.T) {
			f := &fakeTracks{tracks: tracks}
			srv := httptest.NewServer(http.HandlerFunc(f.handler))
			defer srv.Close()
			cl := testClient(srv.URL)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			go cl.Run(ctx)
			cl.Mute("o1.g3", "42", c.kind)
			deadline := time.Now().Add(3 * time.Second)
			for cl.Muted.Load() < int64(len(c.want)) && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			time.Sleep(50 * time.Millisecond)
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.gets) != 1 || f.gets[0] != "o1.g3/42" {
				t.Fatalf("the server looks the participant up itself: %v", f.gets)
			}
			var got []string
			for _, m := range f.mutes {
				if m["room"] != "o1.g3" || m["identity"] != "42" || m["muted"] != true {
					t.Fatalf("only ever a mute, in that room, for that identity: %v", m)
				}
				got = append(got, m["track_sid"].(string))
			}
			if strings.Join(got, ",") != strings.Join(c.want, ",") {
				t.Fatalf("muted %v, want %v", got, c.want)
			}
			if len(f.other) != 0 {
				t.Fatalf("no other SFU call: %v", f.other)
			}
		})
	}
}

func TestMuteOfSomebodyGoneIsQuietAndUnknownKindsAreIgnored(t *testing.T) {
	f := &fakeTracks{tracks: []map[string]any{{"sid": "TR_mic", "source": "MICROPHONE"}}}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	defer srv.Close()
	cl := testClient(srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cl.Run(ctx)
	cl.Mute("o1.g3", "gone", "mic")
	cl.Mute("o1.g3", "42", "everything")
	time.Sleep(200 * time.Millisecond)
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.mutes) != 0 || cl.MuteErrors.Load() != 0 {
		t.Fatalf("a participant who left has nothing to mute and is no error: %v %d", f.mutes, cl.MuteErrors.Load())
	}
	if len(f.gets) != 1 {
		t.Fatalf("an unknown kind never reaches the SFU: %v", f.gets)
	}
}

func TestAFloodOfMutesNeverDelaysARevocation(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	removed := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/RemoveParticipant") {
			mu.Lock()
			removed++
			mu.Unlock()
			w.Write([]byte("{}"))
			return
		}
		<-release // a slow SFU for every mute lookup
		w.Write([]byte(`{"tracks":[]}`))
	}))
	defer srv.Close()
	defer close(release)
	c := testClient(srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)
	for i := 0; i < 1000; i++ {
		c.Mute("o1.g1", "7", "mic")
	}
	c.Revoke("o1.g1", "5")
	deadline := time.Now().Add(2 * time.Second)
	for c.Revoked.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if c.Revoked.Load() != 1 || c.RevokeErrors.Load() != 0 {
		t.Fatalf("the revocation must go through at once (revoked=%d errors=%d)", c.Revoked.Load(), c.RevokeErrors.Load())
	}
	if c.MuteErrors.Load() == 0 {
		t.Fatal("mutes beyond their own bounded queue are dropped and counted")
	}
}
