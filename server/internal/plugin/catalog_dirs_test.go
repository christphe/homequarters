package plugin

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadDirsSourceFromParentFolder(t *testing.T) {
	root := t.TempDir()
	write(t, root, map[string]string{
		"bundled/hq-x/plugin.json": manifest("hq-x", "main.ts", ""),
		"bundled/hq-x/main.ts":     "export function load() {}",
		"other/mine/plugin.json":   manifest("mine", "main.ts", ""),
		"other/mine/main.ts":       "export function load() {}",
		"other/hq-y/plugin.json":   manifest("hq-y", "main.ts", ""),
		"other/hq-y/main.ts":       "export function load() {}",
	})
	list := LoadDirs([]string{
		filepath.Join(root, "other", "mine"),
		filepath.Join(root, "bundled", "hq-x"),
		filepath.Join(root, "other", "hq-y"),
	})
	if len(list) != 3 {
		t.Fatalf("want 3 plugins, got %+v", list)
	}
	// bundled first, then installed, each in name order, as Scan lists them
	if list[0].Name != "hq-x" || list[0].Source != Bundled || list[0].Err != "" {
		t.Fatalf("hq-x: %+v", list[0])
	}
	if list[1].Name != "hq-y" || list[1].Source != Installed || !list[1].NameRefused {
		t.Fatalf("an hq- plugin outside bundled/ is installed, and refused for its name: %+v", list[1])
	}
	if list[2].Name != "mine" || list[2].Source != Installed || list[2].Err != "" {
		t.Fatalf("mine: %+v", list[2])
	}
	if !filepath.IsAbs(list[2].Dir) {
		t.Fatalf("Dir %q is not absolute", list[2].Dir)
	}
}

func TestLoadDirsRefusesTwins(t *testing.T) {
	root := t.TempDir()
	write(t, root, map[string]string{
		"a/twin/plugin.json": manifest("twin", "main.ts", ""),
		"a/twin/main.ts":     "export function load() {}",
		"b/twin/plugin.json": manifest("twin", "main.ts", ""),
		"b/twin/main.ts":     "export function load() {}",
	})
	list := LoadDirs([]string{filepath.Join(root, "a", "twin"), filepath.Join(root, "b", "twin")})
	if len(list) != 2 {
		t.Fatalf("want 2 entries, got %+v", list)
	}
	for _, i := range list {
		if !i.NameRefused || !strings.Contains(i.Err, "same name") {
			t.Fatalf("twin not refused: %+v", i)
		}
	}
}

func TestLoadDirsMissingFolderIsBroken(t *testing.T) {
	list := LoadDirs([]string{filepath.Join(t.TempDir(), "nothing")})
	if len(list) != 1 || list[0].Err == "" {
		t.Fatalf("a folder without plugin.json must be listed broken: %+v", list)
	}
}
