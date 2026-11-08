package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

var binPath string

// TestMain builds the binary once: the testbed subcommand is tested as a process, as the plugin test
// client runs it. The binary sits at a fixed, git-ignored path of the checkout (.run/go-test): Windows'
// firewall keys its rules on an executable's path, so a new temporary folder on each run would ask again.
func TestMain(m *testing.M) {
	dir, err := filepath.Abs(filepath.Join("..", "..", "..", ".run", "go-test"))
	if err == nil {
		err = os.MkdirAll(dir, 0o755)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	binPath = filepath.Join(dir, "homequarters")
	if runtime.GOOS == "windows" {
		binPath += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", binPath, ".").CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "build: %v\n%s", err, out)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

var echoPlugin = filepath.Join("..", "..", "internal", "httpapi", "testdata", "plugins", "installed", "echo")

type bedProc struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	lines  chan string // stdout, closed at its end
	stderr *syncBuf
	done   chan error
}

// syncBuf collects a child's stderr while the test reads it.
type syncBuf struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// runBed starts `homequarters testbed args...` with the given extra environment (HQ_ENV removed from
// the inherited one).
func runBed(t *testing.T, env []string, args ...string) *bedProc {
	t.Helper()
	cmd := exec.Command(binPath, append([]string{"testbed"}, args...)...)
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(kv), "HQ_ENV=") {
			cmd.Env = append(cmd.Env, kv)
		}
	}
	cmd.Env = append(cmd.Env, env...)
	p := &bedProc{cmd: cmd, lines: make(chan string, 64), stderr: &syncBuf{}, done: make(chan error, 1)}
	var err error
	if p.stdin, err = cmd.StdinPipe(); err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = p.stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		// read stdout to its end before Wait, which closes the pipe
		sc := bufio.NewScanner(out)
		for sc.Scan() {
			p.lines <- sc.Text()
		}
		close(p.lines)
		p.done <- cmd.Wait()
	}()
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
			<-p.done
		}
	})
	return p
}

// firstLine reads the first stdout line within 30 s, "" when stdout ends without one.
func (p *bedProc) firstLine(t *testing.T) string {
	t.Helper()
	select {
	case l := <-p.lines:
		return l
	case <-time.After(30 * time.Second):
		t.Fatalf("no line on stdout within 30 s; stderr: %s", p.stderr)
		return ""
	}
}

// wait waits for the process to exit within d and returns its exit code.
func (p *bedProc) wait(t *testing.T, d time.Duration) int {
	t.Helper()
	select {
	case err := <-p.done:
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode()
		}
		if err != nil {
			t.Fatal(err)
		}
		return 0
	case <-time.After(d):
		t.Fatalf("still running after %v; stderr: %s", d, p.stderr)
		return -1
	}
}

func (p *bedProc) url(t *testing.T) *url.URL {
	t.Helper()
	line := p.firstLine(t)
	var out map[string]string
	if err := json.Unmarshal([]byte(line), &out); err != nil || len(out) != 1 || out["url"] == "" {
		t.Fatalf("first stdout line %q is not {\"url\":...}; stderr: %s", line, p.stderr)
	}
	u, err := url.Parse(out["url"])
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.Path != "" {
		t.Fatalf("url %q", out["url"])
	}
	return u
}

func TestTestbedServesAndStopsOnStdinClose(t *testing.T) {
	tmp := t.TempDir()
	p := runBed(t, []string{"TMP=" + tmp, "TEMP=" + tmp, "TMPDIR=" + tmp}, "--plugin", echoPlugin)
	u := p.url(t)
	resp, err := http.Get(u.String() + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(b) != "ok" {
		t.Fatalf("/healthz: %d %q", resp.StatusCode, b)
	}
	// a temporary database exists while it runs
	if m, _ := filepath.Glob(filepath.Join(tmp, "hq-testbed-*")); len(m) != 1 {
		t.Fatalf("temporary database folders: %v", m)
	}

	// the parent closing stdin (or dying) stops it
	p.stdin.Close()
	if code := p.wait(t, 10*time.Second); code != 0 {
		t.Fatalf("exit %d; stderr: %s", code, p.stderr)
	}
	if c, err := net.DialTimeout("tcp", u.Host, time.Second); err == nil {
		c.Close()
		t.Fatalf("%s still accepts connections", u.Host)
	}
	if m, _ := filepath.Glob(filepath.Join(tmp, "hq-testbed-*")); len(m) != 0 {
		t.Fatalf("the temporary database was not removed: %v", m)
	}
	// logs are JSON on stderr
	first, _, _ := strings.Cut(p.stderr.String(), "\n")
	if !json.Valid([]byte(first)) {
		t.Fatalf("stderr is not JSON lines: %q", first)
	}
}

func TestTestbedKeepsGivenDatabase(t *testing.T) {
	db := filepath.Join(t.TempDir(), "bed.db")
	for range 2 { // a restart reopens it
		p := runBed(t, nil, "--plugin", echoPlugin, "--db", db)
		p.url(t)
		p.stdin.Close()
		if code := p.wait(t, 10*time.Second); code != 0 {
			t.Fatalf("exit %d; stderr: %s", code, p.stderr)
		}
		if _, err := os.Stat(db); err != nil {
			t.Fatalf("the given database is gone: %v", err)
		}
	}
}

// --db-temp: the client's database survives a restart ("keep" on stdin) and goes with its folder when
// stdin ends without it, as when the test process dies.
func TestTestbedTempDatabase(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "client")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	db := filepath.Join(dir, "bed.db")
	p := runBed(t, nil, "--plugin", echoPlugin, "--db", db, "--db-temp")
	p.url(t)
	io.WriteString(p.stdin, "keep\n")
	p.stdin.Close()
	if code := p.wait(t, 10*time.Second); code != 0 {
		t.Fatalf("exit %d; stderr: %s", code, p.stderr)
	}
	if _, err := os.Stat(db); err != nil {
		t.Fatalf("a kept database is gone: %v", err)
	}
	p = runBed(t, nil, "--plugin", echoPlugin, "--db", db, "--db-temp")
	p.url(t)
	p.stdin.Close()
	if code := p.wait(t, 10*time.Second); code != 0 {
		t.Fatalf("exit %d; stderr: %s", code, p.stderr)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		entries, _ := os.ReadDir(dir)
		t.Fatalf("the temporary database's folder is still there (%v): %v", err, entries)
	}
	// and --db-temp alone is a mistake
	if code := runBed(t, nil, "--plugin", echoPlugin, "--db-temp").wait(t, 30*time.Second); code != 2 {
		t.Fatalf("--db-temp without --db: exit %d", code)
	}
}

// A test process that dies closes the server's stderr as well as its stdin: the log line written at the stop
// must not kill the server (SIGPIPE on Linux) before it removes its temporary database.
func TestTestbedTempDatabaseWhenTheClientDied(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "client")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binPath, "testbed", "--plugin", echoPlugin, "--db", filepath.Join(dir, "bed.db"), "--db-temp")
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(kv), "HQ_ENV=") {
			cmd.Env = append(cmd.Env, kv)
		}
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = errW
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	errW.Close()
	if !bufio.NewScanner(out).Scan() {
		t.Fatal("no url line")
	}
	errR.Close() // the client is gone: nobody reads the logs any more
	out.Close()
	stdin.Close()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		cmd.Process.Kill()
		t.Fatal("the testbed did not stop")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		entries, _ := os.ReadDir(dir)
		t.Fatalf("the temporary database's folder is still there (%v): %v; exit: %v", err, entries, cmd.ProcessState)
	}
}

func TestTestbedStopsOnInterrupt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no SIGINT to send to a child process on Windows")
	}
	p := runBed(t, nil, "--plugin", echoPlugin)
	u := p.url(t)
	if err := p.cmd.Process.Signal(os.Interrupt); err != nil {
		t.Fatal(err)
	}
	if code := p.wait(t, 10*time.Second); code != 0 {
		t.Fatalf("exit %d; stderr: %s", code, p.stderr)
	}
	if c, err := net.DialTimeout("tcp", u.Host, time.Second); err == nil {
		c.Close()
		t.Fatalf("%s still accepts connections", u.Host)
	}
}

func TestTestbedRefusals(t *testing.T) {
	for _, tc := range []struct {
		name string
		env  []string
		args []string
		code int
	}{
		{"production", []string{"HQ_ENV=production"}, []string{"--plugin", echoPlugin}, 2},
		{"no plugin", nil, nil, 2},
		{"unknown flag", nil, []string{"--plugin", echoPlugin, "--nope"}, 2},
		{"stray argument", nil, []string{"--plugin", echoPlugin, "extra"}, 2},
		{"broken plugin", nil, []string{"--plugin", filepath.Join("..", "..", "internal", "httpapi", "testdata", "plugins", "installed", "broken")}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := runBed(t, tc.env, tc.args...)
			code := p.wait(t, 30*time.Second)
			if code != tc.code {
				t.Fatalf("exit %d, want %d; stderr: %s", code, tc.code, p.stderr)
			}
		})
	}
}

func TestTestbedProductionPrintsNothing(t *testing.T) {
	p := runBed(t, []string{"HQ_ENV=production"}, "--plugin", echoPlugin)
	if line := p.firstLine(t); line != "" {
		t.Fatalf("stdout: %q", line)
	}
	if code := p.wait(t, 10*time.Second); code != 2 {
		t.Fatalf("exit %d", code)
	}
}

// A word the binary does not know (a subcommand of a newer version, a typo) is refused: started as the
// server instead, it would open the default database wherever it was run.
func TestUnknownArgumentIsRefused(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command(binPath, "nonsense")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "HQ_ENV=dev")
	out, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 2 {
		t.Fatalf("exit %v, output %s", err, out)
	}
	if _, err := os.Stat(filepath.Join(dir, "data")); !os.IsNotExist(err) {
		t.Fatal("a database folder was created")
	}
}
