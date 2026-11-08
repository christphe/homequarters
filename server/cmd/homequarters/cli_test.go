package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"homequarters/internal/store"
)

// runCLI runs the binary with only PATH, a loopback HQ_ADDR and the given environment (nothing else
// inherited) and returns its exit
// code (-1 when it was still running after 5 s) and stdout.
func runCLI(t *testing.T, env []string, args ...string) (int, string, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binPath, args...)
	// loopback only: a binary that starts by mistake must not listen on every interface (":8080")
	cmd.Env = append([]string{"PATH=" + os.Getenv("PATH"), "SYSTEMROOT=" + os.Getenv("SYSTEMROOT"), "HQ_ADDR=127.0.0.1:0"}, env...)
	var out, errOut strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err := cmd.Run()
	if ctx.Err() != nil {
		return -1, out.String(), errOut.String()
	}
	if ee, ok := errors.AsType[*exec.ExitError](err); ok {
		return ee.ExitCode(), out.String(), errOut.String()
	}
	if err != nil {
		t.Fatal(err)
	}
	return 0, out.String(), errOut.String()
}

// httpDo sends a request with the test's context.
func httpDo(t *testing.T, method, target, contentType string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(t.Context(), method, target, body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return http.DefaultClient.Do(req)
}

// Production mode refuses to start with insecure media settings: the process exits with status 2.
func TestProductionRefusesToStart(t *testing.T) {
	db := "HQ_DB=" + filepath.Join(t.TempDir(), "prod-check.db")
	for _, tc := range []struct {
		name string
		env  []string
	}{
		{"no LiveKit keys", []string{"HQ_ENV=production"}},
		{"default dev key", []string{"HQ_ENV=production", "LIVEKIT_URL=wss://x.example", "LIVEKIT_API_KEY=devkey", "LIVEKIT_API_SECRET=secret"}},
		{"ws:// media URL", []string{"HQ_ENV=production", "LIVEKIT_URL=ws://x.example", "LIVEKIT_API_KEY=k", "LIVEKIT_API_SECRET=" + strings.Repeat("s", 40), "HQ_ALLOWED_ORIGINS=x.example"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if code, _, stderr := runCLI(t, append(tc.env, db)); code != 2 {
				t.Fatalf("exit %d, want 2; stderr: %s", code, stderr)
			}
		})
	}
}

// -invite mints a bootstrap invite and prints its path.
func TestCLIMintsABootstrapInvite(t *testing.T) {
	code, out, stderr := runCLI(t, []string{"HQ_DB=" + filepath.Join(t.TempDir(), "cli-invite.db")}, "-invite", "member")
	if code != 0 || !strings.HasPrefix(out, "/?invite=") {
		t.Fatalf("exit %d, stdout %q; stderr: %s", code, out, stderr)
	}
}

// -account-link prints the personal link of a member who has not linked a sign-in account, and refuses one who has:
// the link would bypass their sign-in (the /link/ route refuses it too: TestPersonalLinksStopAtLinkedAccounts).
func TestCLIAccountLinkStopsAtLinkedAccounts(t *testing.T) {
	db := filepath.Join(t.TempDir(), "cli-link.db")
	env := []string{"HQ_DB=" + db, "HQ_AUTH_PROVIDERS=fake-oidc", "HQ_AUTH_DOMAINS=acme.test"}
	if code, _, stderr := runCLI(t, env, "-invite", "member"); code != 0 { // creates the database and its office
		t.Fatalf("setup: exit %d; stderr: %s", code, stderr)
	}
	st, err := store.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	o, err := st.OfficeBySlug(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	olga, _, err := st.AddMember(ctx, o.ID, "Olga", json.RawMessage(`{}`), "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.AddMember(ctx, o.ID, "Pat", json.RawMessage(`{}`), "member"); err != nil {
		t.Fatal(err)
	}
	if err := st.LinkIdentity(ctx, o.ID, olga, store.Identity{Provider: "fake-oidc", Subject: "olga", Email: "olga@acme.test"}); err != nil {
		t.Fatal(err)
	}
	st.Close()
	if code, out, stderr := runCLI(t, env, "-account-link", "Pat"); code != 0 || !strings.HasPrefix(out, "/link/") {
		t.Fatalf("an unlinked member: exit %d, stdout %q; stderr: %s", code, out, stderr)
	}
	if code, out, stderr := runCLI(t, env, "-account-link", "Olga"); code != 1 || out != "" || !strings.Contains(stderr, "signs in with a provider") {
		t.Fatalf("a member who signs in: exit %d, stdout %q; stderr: %s", code, out, stderr)
	}
}

// -backup writes a copy of the database while the server that uses it is running.
func TestOnlineBackupWhileTheServerRuns(t *testing.T) {
	dir := t.TempDir()
	l, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	db := "HQ_DB=" + filepath.Join(dir, "e2e.db")
	srv := exec.CommandContext(context.Background(), binPath) // stopped by the cleanup below, gracefully first
	srv.Env = append(os.Environ(), "HQ_ENV=dev", "HQ_ADDR="+addr, db, "HQ_PLUGINS_DIR="+filepath.Join(dir, "plugins"), "HQ_STOP_ON_STDIN_CLOSE=1")
	stdin, err := srv.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- srv.Wait() }()
	t.Cleanup(func() {
		stdin.Close() // a graceful stop
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			srv.Process.Kill()
			<-done
		}
	})
	ready := false
	for i := 0; i < 100 && !ready; i++ {
		if resp, err := httpDo(t, http.MethodGet, "http://"+addr+"/readyz", "", nil); err == nil {
			resp.Body.Close()
			ready = resp.StatusCode == http.StatusOK
		}
		if !ready {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if !ready {
		t.Fatal("the server did not become ready")
	}
	resp, err := httpDo(t, http.MethodPost, "http://"+addr+"/api/join", "application/json", strings.NewReader(`{"name":"Ana","avatar":{}}`))
	if err != nil {
		t.Fatalf("join: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("join: %s", resp.Status)
	}
	bk := filepath.Join(dir, "backup.db")
	code, out, stderr := runCLI(t, []string{db}, "-backup", bk)
	if code != 0 {
		t.Fatalf("exit %d; stdout %q; stderr: %s", code, out, stderr)
	}
	if fi, err := os.Stat(bk); err != nil || fi.Size() == 0 {
		t.Fatalf("no backup written: %v", err)
	}
}
