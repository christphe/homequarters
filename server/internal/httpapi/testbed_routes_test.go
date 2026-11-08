package httpapi

import (
	"net/http"
	"strings"
	"testing"
)

// The test-only endpoints are the testbed's (internal/testbed registers them on its own mux): the server people
// run has none of them, even for its administrator.
func TestServerHasNoTestbedEndpoints(t *testing.T) {
	r := newRig(t, nil)
	admin, _ := r.join("Ann", "") // the first member is the administrator
	for _, c := range []struct{ method, path, body string }{
		{"GET", "/api/testbed/errors", ""},
		{"GET", "/api/testbed/kv/echo", ""},
		{"PUT", "/api/testbed/kv/echo", `{"k":"v"}`},
		{"POST", "/api/testbed/position", `{"id":1,"x":5,"y":5}`},
	} {
		req, _ := http.NewRequest(c.method, r.ts.URL+c.path, strings.NewReader(c.body))
		req.Header.Set("content-type", "application/json")
		resp, err := admin.c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s %s: %d, want 404", c.method, c.path, resp.StatusCode)
		}
	}
}
