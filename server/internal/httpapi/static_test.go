package httpapi

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestTheClientPageIsRevalidatedAndHashedAssetsAreCachedForever(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html>"), 0o644)
	os.MkdirAll(filepath.Join(dir, "assets"), 0o755)
	os.WriteFile(filepath.Join(dir, "assets", "index-abc.js"), []byte("1"), 0o644)
	h := spa(dir)
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
