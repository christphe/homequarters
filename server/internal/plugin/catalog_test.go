package plugin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// write creates files under root; keys are slash paths.
func write(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func manifest(name, server, client string) string {
	return `{"name":"` + name + `","title":"T","version":"1.0.0","description":"d","server":"` + server + `","client":"` + client + `"}`
}

func scanOne(t *testing.T, root, name string) Info {
	t.Helper()
	list, err := scanDir(root, Installed)
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range list {
		if i.Name == name || filepath.Base(i.Dir) == name {
			return i
		}
	}
	t.Fatalf("%s not listed in %+v", name, list)
	return Info{}
}

func TestScanValidPlugin(t *testing.T) {
	root := t.TempDir()
	write(t, root, map[string]string{
		"good/plugin.json":      manifest("good", "main.ts", "client.js"),
		"good/main.ts":          "export function load() {}",
		"good/public/client.js": "hq.onLoad(function(){})",
		"notaplugin/readme.txt": "ignored: no plugin.json",
	})
	list, err := scanDir(root, Installed)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("want 1 plugin, got %+v", list)
	}
	g := list[0]
	if g.Err != "" || g.Name != "good" || g.Title != "T" || g.Version != "1.0.0" || g.Server != "main.ts" || g.Client != "client.js" {
		t.Fatalf("unexpected %+v", g)
	}
}

func TestScanBrokenPlugins(t *testing.T) {
	root := t.TempDir()
	write(t, root, map[string]string{
		"mismatch/plugin.json":  manifest("other", "main.ts", ""),
		"mismatch/main.ts":      "",
		"Bad_Name/plugin.json":  manifest("Bad_Name", "main.ts", ""),
		"Bad_Name/main.ts":      "",
		"empty/plugin.json":     manifest("empty", "", ""),
		"nolua/plugin.json":     manifest("nolua", "main.ts", ""),
		"noclient/plugin.json":  manifest("noclient", "", "client.js"),
		"syntax/plugin.json":    manifest("syntax", "main.ts", ""),
		"syntax/main.ts":        "const a = 1;\nexport function (",
		"badjson/plugin.json":   "{",
		"escape/plugin.json":    manifest("escape", "../x.ts", ""),
		"clientesc/plugin.json": manifest("clientesc", "", "../main.ts"),
	})
	for name, want := range map[string]string{
		"mismatch":  "folder",
		"Bad_Name":  "name",
		"empty":     "server or client",
		"nolua":     "main.ts",
		"noclient":  "client.js",
		"syntax":    "main.ts:2",
		"badjson":   "plugin.json",
		"escape":    "server",
		"clientesc": "client",
	} {
		i := scanOne(t, root, name)
		if i.Err == "" || !strings.Contains(i.Err, want) {
			t.Errorf("%s: want error containing %q, got %q", name, want, i.Err)
		}
	}
}

func TestAssetConfinedToPublic(t *testing.T) {
	root := t.TempDir()
	write(t, root, map[string]string{
		"p/plugin.json":          manifest("p", "main.ts", "client.js"),
		"p/main.ts":              "",
		"p/public/client.js":     "",
		"p/public/creatures.png": "png",
		"p/public/sub/a.json":    "{}",
		"p/public/.secret.png":   "x",
		"p/public/x.ts":          "x",
		"outside.png":            "x",
	})
	big := filepath.Join(root, "p", "public", "big.png")
	if err := os.WriteFile(big, make([]byte, MaxAssetBytes+1), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "p", "public", "link.png")
	symlinked := os.Symlink(filepath.Join(root, "outside.png"), link) == nil
	i := scanOne(t, root, "p")
	for rel, ok := range map[string]bool{
		"creatures.png":        true,
		"client.js":            true,
		"sub/a.json":           true,
		"../main.ts":           false,
		"main.ts":              false,
		".secret.png":          false,
		"x.ts":                 false,
		"sub/../../main.ts":    false,
		"/etc/passwd":          false,
		"big.png":              false,
		"missing.png":          false,
		"sub":                  false,
		"sub\\..\\..\\main.ts": false,
	} {
		if _, got := i.Asset(rel); got != ok {
			t.Errorf("Asset(%q) = %v, want %v", rel, got, ok)
		}
	}
	if symlinked {
		if _, got := i.Asset("link.png"); got {
			t.Error("a symlink leaving public/ must be refused")
		}
	}
}
