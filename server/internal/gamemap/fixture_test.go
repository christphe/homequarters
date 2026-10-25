package gamemap

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The server-free art preview (web/dev) bakes web/dev/<template>-map.json (the Loft as default-map.json),
// and site/assets/map*.png come from them: they must stay the templates. HQ_UPDATE_FIXTURE=1 rewrites them.
func TestArtPreviewFixturesAreTheTemplates(t *testing.T) {
	for _, tp := range Templates {
		name := tp.ID + "-map.json"
		if tp.ID == "loft" {
			name = "default-map.json"
		}
		path := filepath.Join("..", "..", "..", "web", "dev", name)
		want, err := json.Marshal(tp.Build())
		if err != nil {
			t.Fatal(err)
		}
		if os.Getenv("HQ_UPDATE_FIXTURE") == "1" {
			if err := os.WriteFile(path, want, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(bytes.TrimSpace(got), want) {
			t.Errorf("%s is not the %s template; regenerate it with HQ_UPDATE_FIXTURE=1 go test ./internal/gamemap", path, tp.Name)
		}
	}
}
