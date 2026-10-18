package plugin

import (
	"crypto/sha256"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func names(list []Info) string {
	var out []string
	for _, i := range list {
		out = append(out, i.Source+"/"+i.Name)
	}
	return strings.Join(out, ",")
}

func TestScanLayouts(t *testing.T) {
	plug := func(name string) map[string]string {
		return map[string]string{name + "/plugin.json": manifest(name, "main.ts", ""), name + "/main.ts": "export function load() {}"}
	}
	for _, tc := range []struct {
		what      string
		bundled   map[string]string // nil: no bundled/ folder
		installed map[string]string
		want      string // "off": Scan returns a nil catalog
	}{
		{"both missing", nil, nil, "off"},
		{"both empty", map[string]string{}, map[string]string{}, ""},
		{"bundled only", plug("hq-one"), nil, "bundled/hq-one"},
		{"installed only", nil, plug("mine"), "installed/mine"},
		{"both", plug("hq-one"), plug("mine"), "bundled/hq-one,installed/mine"},
		{"installed empty", plug("hq-one"), map[string]string{}, "bundled/hq-one"},
	} {
		t.Run(tc.what, func(t *testing.T) {
			root := t.TempDir()
			for side, files := range map[string]map[string]string{Bundled: tc.bundled, Installed: tc.installed} {
				if files == nil {
					continue
				}
				if err := os.MkdirAll(filepath.Join(root, side), 0o755); err != nil {
					t.Fatal(err)
				}
				write(t, filepath.Join(root, side), files)
			}
			list, err := Scan(root)
			if err != nil {
				t.Fatal(err)
			}
			if tc.want == "off" {
				if list != nil {
					t.Fatalf("want plugins off, got %s", names(list))
				}
				return
			}
			if list == nil {
				t.Fatal("plugins are off although a plugins folder exists")
			}
			if got := names(list); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
			for _, i := range list {
				if i.Err != "" {
					t.Fatalf("%s: %s", i.Name, i.Err)
				}
			}
		})
	}
	if list, err := Scan(filepath.Join(t.TempDir(), "absent")); err != nil || list != nil {
		t.Fatalf("a missing root: %v %v", list, err)
	}
}

func TestFlatLayoutIsNoticed(t *testing.T) {
	flat := t.TempDir()
	write(t, flat, map[string]string{"mine/plugin.json": manifest("mine", "main.ts", ""), "mine/main.ts": ""})
	if list, _ := Scan(flat); list != nil || !FlatLayout(flat) {
		t.Fatalf("a plugin folder directly in the root is not read, and is noticed: %v", list)
	}
	split := t.TempDir()
	write(t, split, map[string]string{"installed/mine/plugin.json": manifest("mine", "main.ts", ""), "installed/mine/main.ts": "", "sdk/client.d.ts": ""})
	if FlatLayout(split) {
		t.Fatal("bundled/ and installed/ are the layout, and other folders without plugin.json are fine")
	}
}

func TestReservedPrefix(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, Bundled), map[string]string{
		"hq-good/plugin.json": manifest("hq-good", "main.ts", ""),
		"hq-good/main.ts":     "export function load() {}",
		"plain/plugin.json":   manifest("plain", "main.ts", ""), // bundled without the prefix
		"plain/main.ts":       "",
		"hq-/plugin.json":     manifest("hq-", "main.ts", ""), // the prefix alone
		"hq-/main.ts":         "",
	})
	write(t, filepath.Join(root, Installed), map[string]string{
		"mine/plugin.json":    manifest("mine", "main.ts", ""),
		"mine/main.ts":        "export function load() {}",
		"hq-good/plugin.json": manifest("hq-good", "main.ts", ""), // installed with the prefix, twin of a bundled one
		"hq-good/main.ts":     "export function load() {}",
		"sneaky/plugin.json":  manifest("hq-sneaky", "main.ts", ""), // folder fine, manifest reserved
		"sneaky/main.ts":      "",
		"HQ-up/plugin.json":   manifest("hq-up", "main.ts", ""), // upper-case folder
		"HQ-up/main.ts":       "",
	})
	list, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	find := func(side, folder string) Info {
		for _, i := range list {
			if i.Source == side && filepath.Base(i.Dir) == folder {
				return i
			}
		}
		t.Fatalf("%s/%s not listed: %s", side, folder, names(list))
		return Info{}
	}
	for _, ok := range [][2]string{{Bundled, "hq-good"}, {Installed, "mine"}} {
		if i := find(ok[0], ok[1]); i.Err != "" || i.NameRefused {
			t.Errorf("%s/%s refused: %s", ok[0], ok[1], i.Err)
		}
	}
	for _, bad := range []struct{ side, folder, want string }{
		{Bundled, "plain", "must start with hq-"},
		{Bundled, "hq-", "must start with hq-"},
		{Installed, "hq-good", "reserved"},
		{Installed, "sneaky", "reserved"},
		{Installed, "HQ-up", "reserved"},
	} {
		i := find(bad.side, bad.folder)
		if !i.NameRefused || !strings.Contains(i.Err, bad.want) {
			t.Errorf("%s/%s: want a name refusal containing %q, got refused=%v %q", bad.side, bad.folder, bad.want, i.NameRefused, i.Err)
		}
	}

	// the refused installed twin never stands in for the bundled plugin of the same name
	h := NewHost(list, &fakeSink{}, newMemKV(), quiet)
	t.Cleanup(h.Close)
	if i, ok := h.Info("hq-good"); !ok || i.Source != Bundled {
		t.Fatalf("hq-good resolves to %+v", i)
	}
	if err := h.Start("hq-good"); err != nil {
		t.Fatal(err)
	}
	if err := h.Start("hq-sneaky"); err == nil {
		t.Fatal("a plugin refused for its name started")
	}
	rows := 0
	for _, st := range h.Status() {
		if st.Name == "hq-good" {
			rows++
		}
	}
	if rows != 2 {
		t.Fatalf("the admin list must show both hq-good folders, got %d", rows)
	}
}

func TestDuplicateNames(t *testing.T) {
	// The folder must equal the manifest name, so one side of a disk cannot hold two plugins of one
	// name; the check guards the catalog against it all the same, with no silent winner.
	in := []Info{
		{Manifest: Manifest{Name: "hq-a"}, Source: Bundled, Dir: "x/bundled/hq-a"},
		{Manifest: Manifest{Name: "hq-a"}, Source: Bundled, Dir: "y/bundled/hq-a"},
		{Manifest: Manifest{Name: "b"}, Source: Installed, Dir: "x/installed/b"},
		{Manifest: Manifest{Name: "b"}, Source: Installed, Dir: "y/installed/b"},
		{Manifest: Manifest{Name: "c"}, Source: Installed, Dir: "x/installed/c"},
	}
	out := dedupe(in)
	for _, i := range out {
		dup := i.Name != "c"
		if dup != i.NameRefused || dup != strings.Contains(i.Err, "same name") {
			t.Errorf("%s/%s: refused=%v err=%q", i.Source, i.Dir, i.NameRefused, i.Err)
		}
	}
}

// snapshot records every path under root with its mode, size and content hash.
func snapshot(t *testing.T, root string) string {
	t.Helper()
	var lines []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		st, err := d.Info()
		if err != nil {
			return err
		}
		line := fmt.Sprintf("%s %v %d", p, st.Mode(), st.Size())
		if st.Mode().IsRegular() {
			b, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			line += fmt.Sprintf(" %x %d", sha256.Sum256(b), st.ModTime().UnixNano())
		}
		lines = append(lines, line)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

func TestInstalledReadOnly(t *testing.T) {
	root := t.TempDir()
	inst := filepath.Join(root, Installed)
	write(t, inst, map[string]string{
		"mine/plugin.json":      manifest("mine", "main.ts", "client.ts"),
		"mine/main.ts":          `import { greet } from "./lib"; export function onJoin(p: HQ.Player) { hq.send(p.id, greet(p.name)); }`,
		"mine/lib.ts":           `export const greet = (n: string) => "hi " + n;`,
		"mine/public/client.ts": `hq.onMessage(() => {});`,
	})
	// read-only like a Kubernetes volume: where the OS honours modes, any write would fail
	var dirs []string
	filepath.WalkDir(inst, func(p string, d fs.DirEntry, _ error) error {
		if d.IsDir() {
			dirs = append(dirs, p)
			return nil
		}
		return os.Chmod(p, 0o444)
	})
	for i := len(dirs) - 1; i >= 0; i-- {
		os.Chmod(dirs[i], 0o555)
	}
	t.Cleanup(func() {
		filepath.WalkDir(inst, func(p string, d fs.DirEntry, _ error) error {
			if d.IsDir() {
				return os.Chmod(p, 0o755)
			}
			return os.Chmod(p, 0o644)
		})
	})
	before := snapshot(t, root)

	list, err := Scan(root)
	if err != nil || len(list) != 1 || list[0].Err != "" {
		t.Fatalf("scan: %v %+v", err, list)
	}
	sink := &fakeSink{}
	h := NewHost(list, sink, newMemKV(), quiet)
	if err := h.Start("mine"); err != nil {
		t.Fatal(err)
	}
	h.Presence(Player{ID: 1, Name: "Ana", Role: "member"}, true)
	if _, err := list[0].code(); err != nil {
		t.Fatal(err)
	}
	h.Close()
	if after := snapshot(t, root); after != before {
		t.Fatalf("the plugin folder changed:\nbefore:\n%s\nafter:\n%s", before, after)
	}
}
