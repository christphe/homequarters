package plugin

import (
	"strings"
	"testing"
)

func settingsManifest(name, settings string) string {
	return `{"name":"` + name + `","title":"T","version":"1.0.0","server":"main.ts","settings":` + settings + `}`
}

func TestManifestSettings(t *testing.T) {
	root := t.TempDir()
	ok := `[{"key":"limit","label":"Pets per member","type":"number","min":0,"max":8,"default":3}]`
	write(t, root, map[string]string{
		"good/plugin.json": settingsManifest("good", ok),
		"good/main.ts":     "export function load() {}",
	})
	for name, s := range map[string]string{
		"badkey":   `[{"key":"no spaces","label":"L","type":"number","min":0,"max":1,"default":0}]`,
		"badtype":  `[{"key":"k","label":"L","type":"colour","min":0,"max":1,"default":0}]`,
		"outside":  `[{"key":"k","label":"L","type":"number","min":0,"max":8,"default":9}]`,
		"reversed": `[{"key":"k","label":"L","type":"number","min":5,"max":1,"default":3}]`,
		"fraction": `[{"key":"k","label":"L","type":"number","min":0,"max":8,"default":1.5}]`,
		"nolabel":  `[{"key":"k","label":"","type":"number","min":0,"max":1,"default":0}]`,
		"longhelp": `[{"key":"k","label":"L","type":"number","min":0,"max":1,"default":0,"help":"` + strings.Repeat("x", 201) + `"}]`,
		"twice":    `[{"key":"k","label":"L","type":"number","min":0,"max":1,"default":0},{"key":"k","label":"M","type":"number","min":0,"max":1,"default":0}]`,
		"toomany":  "[" + strings.Repeat(`{"key":"k","label":"L","type":"number","min":0,"max":1,"default":0},`, 16) + `{"key":"z","label":"L","type":"number","min":0,"max":1,"default":0}]`,
	} {
		write(t, root, map[string]string{name + "/plugin.json": settingsManifest(name, s), name + "/main.ts": "export function load() {}"})
	}
	list, err := scanDir(root, Installed)
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range list {
		if i.Name == "good" {
			if i.Err != "" || len(i.Settings) != 1 || i.Settings[0].Key != "limit" || i.Settings[0].Default != 3 {
				t.Fatalf("good: %+v", i)
			}
			continue
		}
		if i.Err == "" || !strings.Contains(i.Err, "setting") {
			t.Errorf("%s: want a settings error, got %q", i.Name, i.Err)
		}
	}
}

func TestDescriptionsAreShort(t *testing.T) {
	root := t.TempDir()
	write(t, root, map[string]string{
		"long/plugin.json":  `{"name":"long","title":"T","server":"main.ts","description":"` + strings.Repeat("x", 161) + `"}`,
		"long/main.ts":      "",
		"about/plugin.json": `{"name":"about","title":"T","server":"main.ts","description":"Short.","longDescription":"` + strings.Repeat("y", 2001) + `"}`,
		"about/main.ts":     "",
		"good/plugin.json":  `{"name":"good","title":"T","server":"main.ts","description":"Short.","longDescription":"More.\n\nAnd more."}`,
		"good/main.ts":      "export function load() {}",
	})
	list, err := scanDir(root, Installed)
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range list {
		want := map[string]string{"long": "description", "about": "longDescription", "good": ""}[i.Name]
		if (want == "") != (i.Err == "") || !strings.Contains(i.Err, want) {
			t.Errorf("%s: want %q, got %q", i.Name, want, i.Err)
		}
	}
}

func TestExternalHosts(t *testing.T) {
	root := t.TempDir()
	for name, hosts := range map[string]string{
		"good":   `["raw.githubusercontent.com","cdn.example.org"]`,
		"scheme": `["https://example.com"]`,
		"port":   `["example.com:8080"]`,
		"upper":  `["Example.com"]`,
		"bare":   `["localhost"]`,
		"many":   `["a.io","b.io","c.io","d.io","e.io","f.io","g.io","h.io","i.io"]`,
	} {
		write(t, root, map[string]string{
			name + "/plugin.json": `{"name":"` + name + `","title":"T","client":"c.js","externalHosts":` + hosts + `}`,
			name + "/public/c.js": "",
		})
	}
	list, err := scanDir(root, Installed)
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range list {
		if (i.Name == "good") != (i.Err == "") {
			t.Errorf("%s: %q", i.Name, i.Err)
		}
		if i.Name == "good" && len(i.ExternalHosts) != 2 {
			t.Errorf("good: %v", i.ExternalHosts)
		}
	}
}

func TestSettingValues(t *testing.T) {
	i := Info{Manifest: Manifest{Settings: []Setting{
		{Key: "limit", Label: "L", Type: "number", Min: 0, Max: 8, Default: 3},
		{Key: "speed", Label: "S", Type: "number", Min: 10, Max: 80, Default: 30},
	}}}
	got := i.SettingValues(map[string]float64{"limit": 12, "gone": 1})
	if len(got) != 2 || got["limit"] != 8 || got["speed"] != 30 {
		t.Fatalf("stored values are clamped to the manifest, missing ones get their default, unknown ones are dropped: %v", got)
	}
	if err := i.CheckSetting("limit", 4); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []struct {
		k string
		v float64
	}{{"limit", 9}, {"limit", -1}, {"limit", 2.5}, {"nope", 1}} {
		if i.CheckSetting(bad.k, bad.v) == nil {
			t.Errorf("%s=%v accepted", bad.k, bad.v)
		}
	}
}

func TestSettingsReachThePlugin(t *testing.T) {
	root := t.TempDir()
	write(t, root, map[string]string{
		"s/plugin.json": settingsManifest("s", `[{"key":"limit","label":"L","type":"number","min":0,"max":8,"default":3}]`),
		"s/main.ts": `
export function onJoin() { hq.broadcast({ at: "load", limit: hq.settings().limit }); }
export function onSettings() { hq.broadcast({ at: "change", limit: hq.settings().limit }); }`,
	})
	cat, err := scanDir(root, Installed)
	if err != nil || cat[0].Err != "" {
		t.Fatal(err, cat)
	}
	sink := &fakeSink{}
	h := NewHost(cat, sink, newMemKV(), quiet)
	t.Cleanup(h.Close)
	h.SetSettings("s", map[string]float64{"limit": 5}) // stored before the plugin starts
	h.Presence(alice, true)
	if err := h.Start("s"); err != nil {
		t.Fatal(err)
	}
	eventually(t, "load sees the stored value", func() bool { return sink.find(0, "limit", 5.0) })
	h.SetSettings("s", map[string]float64{"limit": 1})
	eventually(t, "onSettings sees the new value", func() bool {
		for _, d := range sink.data(0) {
			if d["at"] == "change" && d["limit"] == 1.0 {
				return true
			}
		}
		return false
	})
	if st, msg := state(h, "s"); st != "running" {
		t.Fatalf("%s %s", st, msg)
	}
}
