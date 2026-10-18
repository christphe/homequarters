package store

import (
	"context"
	"testing"
)

func TestPluginFlags(t *testing.T) {
	s, o := open(t)
	ctx := context.Background()
	if f, err := s.PluginFlags(ctx, o.ID); err != nil || len(f) != 0 {
		t.Fatalf("a fresh office enables no plugin: %v %v", f, err)
	}
	if err := s.SetPluginEnabled(ctx, o.ID, "pet", true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPluginEnabled(ctx, o.ID, "other", true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPluginEnabled(ctx, o.ID, "other", false); err != nil {
		t.Fatal(err)
	}
	f, err := s.PluginFlags(ctx, o.ID)
	if err != nil || !f["pet"] || f["other"] || len(f) != 2 {
		t.Fatalf("flags: %v %v", f, err)
	}
}

func TestPluginKV(t *testing.T) {
	s, o := open(t)
	ctx := context.Background()
	o2, err := s.EnsureOffice(ctx, "second", "S", "{}")
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range []struct {
		office    int64
		plugin, k string
		v         string
	}{{o.ID, "pet", "a", "1"}, {o.ID, "pet", "b", "2"}, {o.ID, "other", "a", "x"}, {o2.ID, "pet", "a", "y"}, {o.ID, "pet", "a", "3"}} {
		if err := s.PutPluginKV(ctx, w.office, w.plugin, w.k, w.v); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.DeletePluginKV(ctx, o.ID, "pet", "b"); err != nil {
		t.Fatal(err)
	}
	m, err := s.PluginKV(ctx, o.ID, "pet")
	if err != nil || len(m) != 1 || m["a"] != "3" {
		t.Fatalf("pet kv: %v %v", m, err)
	}
	if m, _ := s.PluginKV(ctx, o2.ID, "pet"); m["a"] != "y" {
		t.Fatalf("offices are isolated: %v", m)
	}
	if m, _ := s.PluginKV(ctx, o.ID, "other"); m["a"] != "x" {
		t.Fatalf("plugins are isolated: %v", m)
	}
}

func TestPluginSettings(t *testing.T) {
	s, o := open(t)
	ctx := context.Background()
	if v, err := s.PluginSettings(ctx, o.ID); err != nil || len(v) != 0 {
		t.Fatalf("a fresh office has no settings: %v %v", v, err)
	}
	for _, x := range []struct {
		p, k string
		v    float64
	}{{"pets", "limit", 5}, {"pets", "limit", 2}, {"pets", "speed", 40}, {"other", "limit", 1}} {
		if err := s.SetPluginSetting(ctx, o.ID, x.p, x.k, x.v); err != nil {
			t.Fatal(err)
		}
	}
	v, err := s.PluginSettings(ctx, o.ID)
	if err != nil || v["pets"]["limit"] != 2 || v["pets"]["speed"] != 40 || v["other"]["limit"] != 1 || len(v) != 2 {
		t.Fatalf("the last value of each setting, by plugin: %v %v", v, err)
	}
}
