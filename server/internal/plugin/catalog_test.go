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

// objPlugin writes a plugin with a client, a sprite, a view and the given manifest tail.
func objPlugin(t *testing.T, tail string, extra map[string]string) Info {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		"p/plugin.json":         `{"name":"p","title":"T","version":"1.0.0","description":"d","client":"client.js",` + tail + `}`,
		"p/public/client.js":    "",
		"p/public/board.png":    "png",
		"p/public/board.js":     "window.x = 1",
		"p/public/sub/other.js": "window.y = 1",
	}
	for k, v := range extra {
		files[k] = v
	}
	write(t, root, files)
	return scanOne(t, root, "p")
}

const goodObject = `{"kind":"chessboard","label":"Chess board","size":[2,2],"sprite":"board.png"}`

func TestObjectsAndViewsLoad(t *testing.T) {
	i := objPlugin(t, `"objects":[`+goodObject+`],"views":{"board":"board.js"}`, nil)
	if i.Err != "" {
		t.Fatal(i.Err)
	}
	o, ok := i.Object("chessboard")
	if !ok || o.Label != "Chess board" || o.Size != [2]int{2, 2} || o.Frame != nil {
		t.Fatalf("object: %+v %v", o, ok)
	}
	if _, ok := i.Object("nope"); ok {
		t.Fatal("unknown kind found")
	}
	c, err := i.code()
	if err != nil || len(c.views["board"]) == 0 {
		t.Fatalf("view not compiled: %v", err)
	}
	f := objPlugin(t, `"objects":[{"kind":"a","label":"A","size":[1,1],"sprite":"board.png","frame":[0,0,16,128]}]`, nil)
	if f.Err != "" {
		t.Fatal(f.Err)
	}
}

func TestObjectAndViewRules(t *testing.T) {
	obj := func(kind, label, size, sprite string) string {
		return `{"kind":"` + kind + `","label":"` + label + `","size":` + size + `,"sprite":"` + sprite + `"}`
	}
	nine := make([]string, 9)
	for k := range nine {
		nine[k] = obj("k"+string(rune('a'+k)), "L", "[1,1]", "board.png")
	}
	five := `"a":"board.js","b":"board.js","c":"board.js","d":"board.js","e":"board.js"`
	cases := []struct {
		name, tail, want string
		extra            map[string]string
	}{
		{"bad kind", `"objects":[` + obj("Bad", "L", "[1,1]", "board.png") + `]`, "kind", nil},
		{"duplicate kind", `"objects":[` + goodObject + `,` + goodObject + `]`, "twice", nil},
		{"size zero", `"objects":[` + obj("a", "L", "[0,1]", "board.png") + `]`, "size", nil},
		{"size five", `"objects":[` + obj("a", "L", "[5,1]", "board.png") + `]`, "size", nil},
		{"nine objects", `"objects":[` + strings.Join(nine, ",") + `]`, "at most 8", nil},
		{"missing sprite", `"objects":[` + obj("a", "L", "[1,1]", "gone.png") + `]`, "sprite", nil},
		{"sprite not png", `"objects":[` + obj("a", "L", "[1,1]", "board.js") + `]`, "sprite", nil},
		{"sprite outside public", `"objects":[` + obj("a", "L", "[1,1]", "../plugin.json") + `]`, "sprite", nil},
		{"long label", `"objects":[` + obj("a", strings.Repeat("x", 41), "[1,1]", "board.png") + `]`, "label", nil},
		{"empty label", `"objects":[` + obj("a", "", "[1,1]", "board.png") + `]`, "label", nil},
		{"bad frame size", `"objects":[{"kind":"a","label":"L","size":[1,1],"sprite":"board.png","frame":[0,0,0,16]}]`, "frame", nil},
		{"frame too big", `"objects":[{"kind":"a","label":"L","size":[1,1],"sprite":"board.png","frame":[0,0,129,16]}]`, "frame", nil},
		{"negative frame", `"objects":[{"kind":"a","label":"L","size":[1,1],"sprite":"board.png","frame":[-1,0,16,16]}]`, "frame", nil},
		{"view name", `"views":{"Board":"board.js"}`, "view", nil},
		{"view missing", `"views":{"board":"gone.js"}`, "view", nil},
		{"view not script", `"views":{"board":"board.png"}`, "view", nil},
		{"view outside public", `"views":{"board":"../plugin.json"}`, "view", nil},
		{"five views", `"views":{` + five + `}`, "at most 4", nil},
		{"view imports outside public", `"views":{"board":"board.js"}`, "leaves the plugin's folder",
			map[string]string{"p/public/board.js": `import "../plugin.json"`}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			i := objPlugin(t, c.tail, c.extra)
			if i.Err == "" || !strings.Contains(i.Err, c.want) {
				t.Fatalf("want an error naming %q, got %q", c.want, i.Err)
			}
		})
	}
}
