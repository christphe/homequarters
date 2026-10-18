package httpapi

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTheClientPageIsRevalidatedAndHashedAssetsAreCachedForever(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html>"), 0o644)
	os.MkdirAll(filepath.Join(dir, "assets"), 0o755)
	os.WriteFile(filepath.Join(dir, "assets", "index-abc.js"), []byte("1"), 0o644)
	h := spa(dir, "v1")
	for path, want := range map[string]string{
		"/":                    "no-cache", // after a deploy the next load gets the new client
		"/index.html":          "no-cache",
		"/some/route":          "no-cache", // the SPA fallback is the same page
		"/assets/index-abc.js": "public, max-age=31536000, immutable",
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if got := rec.Header().Get("Cache-Control"); got != want {
			t.Errorf("%s: Cache-Control %q, want %q", path, got, want)
		}
	}
}

// The page names the version of the server that served it, so a client can tell when the server it
// talks to has moved on (a deploy) and reload.
func TestThePageCarriesTheServerVersion(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html><html><head><title>x</title></head><body></body></html>"), 0o644)
	h := spa(dir, "abc1234")
	for _, path := range []string{"/", "/index.html", "/some/route"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		body := rec.Body.String()
		if !strings.Contains(body, `<meta name="hq-version" content="abc1234"></head>`) {
			t.Errorf("%s: the page must carry the version in its head: %q", path, body)
		}
		if rec.Header().Get("Cache-Control") != "no-cache" || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
			t.Errorf("%s: still an uncached HTML page: %v", path, rec.Header())
		}
	}
}

func TestTheVersionIsTheDeployCommitOrAHashOfThePage(t *testing.T) {
	if got := resolveVersion(" 9fc44ab ", ""); got != "9fc44ab" {
		t.Fatalf("HQ_VERSION wins: %q", got)
	}
	if got := resolveVersion("", ""); got != "dev" {
		t.Fatalf("no version and no page: %q", got)
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<script src=/assets/a.js>"), 0o644)
	a := resolveVersion("", dir)
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<script src=/assets/b.js>"), 0o644)
	b := resolveVersion("", dir)
	if len(a) != 12 || a == b {
		t.Fatalf("without a commit, a new build of the page is a new version: %q -> %q", a, b)
	}
}
