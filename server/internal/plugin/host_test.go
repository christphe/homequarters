package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type sent struct {
	to    uint32
	frame string
}

type fakeSink struct {
	mu    sync.Mutex
	sends []sent
}

func (s *fakeSink) Deliver(to uint32, frame []byte) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sends = append(s.sends, sent{to, string(frame)})
	return true
}

// data returns the decoded "d" of every frame sent to to (0 = broadcasts) by plugin.
func (s *fakeSink) data(to uint32) []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []map[string]any
	for _, x := range s.sends {
		if x.to != to {
			continue
		}
		var f struct {
			T  string         `json:"t"`
			PL string         `json:"pl"`
			D  map[string]any `json:"d"`
		}
		if json.Unmarshal([]byte(x.frame), &f) == nil && f.T == "plg" {
			out = append(out, f.D)
		}
	}
	return out
}

func (s *fakeSink) find(to uint32, key string, val any) bool {
	for _, d := range s.data(to) {
		if v, ok := d[key]; ok && (val == nil || v == val) {
			return true
		}
	}
	return false
}

type memKV struct {
	mu sync.Mutex
	m  map[string]map[string]string
}

func newMemKV() *memKV { return &memKV{m: map[string]map[string]string{}} }

func (k *memKV) Load(p string) (map[string]string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	out := map[string]string{}
	for a, b := range k.m[p] {
		out[a] = b
	}
	return out, nil
}

func (k *memKV) Set(p, key, v string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.m[p] == nil {
		k.m[p] = map[string]string{}
	}
	k.m[p][key] = v
	return nil
}

func (k *memKV) Delete(p, key string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.m[p], key)
	return nil
}

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

// newHost installs one TypeScript plugin per entry (name → main.ts source) and returns a host over them.
func newHost(t *testing.T, plugins map[string]string) (*Host, *fakeSink, *memKV) {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{}
	for name, src := range plugins {
		files[name+"/plugin.json"] = manifest(name, "main.ts", "")
		files[name+"/main.ts"] = src
	}
	write(t, root, files)
	cat, err := scanDir(root, Installed)
	if err != nil {
		t.Fatal(err)
	}
	sink, kv := &fakeSink{}, newMemKV()
	h := NewHost(cat, sink, kv, quiet)
	t.Cleanup(h.Close)
	return h, sink, kv
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func state(h *Host, name string) (string, string) {
	for _, s := range h.Status() {
		if s.Name == name {
			return s.State, s.Error
		}
	}
	return "", ""
}

var alice = Player{ID: 1, Name: "Alice", Role: "admin"}
var bob = Player{ID: 2, Name: "Bob", Role: "member"}

const echoPlugin = `
type Player = { id: number; name: string; role: string };
export function onJoin(p: Player) { hq.broadcast({ joined: p.id, name: p.name, role: p.role }); }
export function onLeave(p: Player) { hq.broadcast({ left: p.id }); }
export function onMessage(p: Player, m: { v: string }) { hq.send(p.id, { echo: m.v, n: hq.players().length }); }
`

func TestJoinReplayedForPlayersOnlineAtStart(t *testing.T) {
	h, sink, _ := newHost(t, map[string]string{"echo": echoPlugin})
	h.Presence(alice, true)
	if err := h.Start("echo"); err != nil {
		t.Fatal(err)
	}
	eventually(t, "replayed join", func() bool { return sink.find(0, "joined", float64(1)) })
	h.Presence(bob, true)
	eventually(t, "live join", func() bool { return sink.find(0, "joined", float64(2)) })
	d := sink.data(0)
	if d[0]["name"] != "Alice" || d[0]["role"] != "admin" {
		t.Fatalf("player object: %+v", d[0])
	}
	h.Presence(bob, false)
	eventually(t, "leave", func() bool { return sink.find(0, "left", float64(2)) })
	h.Message(alice, "echo", []byte(`{"v":"hi"}`))
	eventually(t, "echo", func() bool { return sink.find(1, "echo", "hi") })
	if got := sink.data(1)[0]["n"]; got != float64(1) {
		t.Fatalf("hq.players() after bob left: %v", got)
	}
	if st, _ := state(h, "echo"); st != "running" {
		t.Fatalf("state %s", st)
	}
}

func TestSendToOfflineReturnsFalse(t *testing.T) {
	h, sink, _ := newHost(t, map[string]string{"p": `
export function onMessage(p: { id: number }) { hq.send(p.id, { ok: hq.send(99, { x: 1 }) }); }`})
	h.Presence(alice, true)
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	h.Message(alice, "p", []byte(`{}`))
	eventually(t, "reply", func() bool { return sink.find(1, "ok", false) })
	if len(sink.data(99)) != 0 {
		t.Fatal("delivered to an offline player")
	}
}

func TestSandboxHasNoEscapes(t *testing.T) {
	for _, g := range []string{"std", "os", "require", "process", "fetch", "XMLHttpRequest", "setTimeout", "WebSocket", "__tw_send", "__tw_kv_set"} {
		h, _, _ := newHost(t, map[string]string{"p": "declare const globalThis: any;\nif (typeof globalThis[" + strconv.Quote(g) + "] !== \"undefined\") throw new Error(" + strconv.Quote(g+" is reachable") + ");"})
		if err := h.Start("p"); err != nil {
			t.Errorf("%s: %v", g, err)
		}
	}
	h, _, _ := newHost(t, map[string]string{"p": "declare const std: any;\nexport function load() { std.exit(1); }"})
	if err := h.Start("p"); err == nil {
		t.Fatal("load using std must fail")
	}
	if st, msg := state(h, "p"); st != "crashed" || msg == "" {
		t.Fatalf("state %s %q", st, msg)
	}
}

func TestImportsStayInsideThePluginFolder(t *testing.T) {
	root := t.TempDir()
	write(t, root, map[string]string{
		"ok/plugin.json":  manifest("ok", "main.ts", ""),
		"ok/main.ts":      `import { greet } from "./lib/greet"; export function load() { hq.log(greet("x")); }`,
		"ok/lib/greet.ts": `export const greet = (s: string): string => "hello " + s;`,
		"out/plugin.json": manifest("out", "main.ts", ""),
		"out/main.ts":     `import { x } from "../secret"; export function load() { hq.log(x); }`,
		"secret.ts":       `export const x = "leak";`,
		"pkg/plugin.json": manifest("pkg", "main.ts", ""),
		"pkg/main.ts":     `import fs from "fs"; export function load() { hq.log(String(fs)); }`,
	})
	if i := scanOne(t, root, "ok"); i.Err != "" {
		t.Fatalf("an import inside the folder: %s", i.Err)
	}
	for _, name := range []string{"out", "pkg"} {
		if i := scanOne(t, root, name); !strings.Contains(i.Err, "import") {
			t.Errorf("%s: want an import error, got %q", name, i.Err)
		}
	}
}

func TestInfiniteLoopCrashesOnlyThatPlugin(t *testing.T) {
	h, sink, _ := newHost(t, map[string]string{
		"spin": "export function update(dt: number) { for (;;) {} }",
		"tick": "export function update(dt: number) { hq.broadcast({ dt }); }",
	})
	changed := make(chan struct{}, 4)
	h.OnChange = func() { changed <- struct{}{} }
	h.Presence(alice, true)
	if err := h.Start("spin"); err != nil {
		t.Fatal(err)
	}
	if err := h.Start("tick"); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	eventually(t, "spin crashed", func() bool { st, _ := state(h, "spin"); return st == "crashed" })
	if time.Since(start) > 10*callBudget {
		t.Fatalf("crash took %v", time.Since(start))
	}
	select {
	case <-changed:
	case <-time.After(time.Second):
		t.Fatal("OnChange not called on crash")
	}
	if _, msg := state(h, "spin"); !strings.Contains(msg, "budget") {
		t.Fatalf("error %q", msg)
	}
	n := len(sink.data(0))
	eventually(t, "tick keeps updating", func() bool { return len(sink.data(0)) > n+2 })
	if h.Running("spin") || !h.Running("tick") {
		t.Fatal("running flags")
	}
	// enabling a crashed plugin restarts it
	if err := h.Start("spin"); err != nil {
		t.Fatal(err)
	}
	if st, _ := state(h, "spin"); st != "running" {
		t.Fatalf("restart state %s", st)
	}
}

func TestMemoryCapStopsThePlugin(t *testing.T) {
	h, _, _ := newHost(t, map[string]string{"hog": `
const keep: ArrayBuffer[] = [];
export function onMessage() { for (;;) keep.push(new ArrayBuffer(1 << 20)); }`})
	h.Presence(alice, true)
	if err := h.Start("hog"); err != nil {
		t.Fatal(err)
	}
	h.Message(alice, "hog", []byte(`{}`))
	eventually(t, "hog crashed", func() bool { st, _ := state(h, "hog"); return st == "crashed" })
	if _, msg := state(h, "hog"); !strings.Contains(msg, "memory") {
		t.Fatalf("error %q", msg)
	}
}

func TestErrorRateCrash(t *testing.T) {
	h, _, _ := newHost(t, map[string]string{"p": "export function onMessage() { throw new Error('boom'); }"})
	h.Presence(alice, true)
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		h.Message(alice, "p", []byte(`{}`))
	}
	time.Sleep(200 * time.Millisecond)
	if st, _ := state(h, "p"); st != "running" {
		t.Fatalf("10 errors: %s", st)
	}
	h.Message(alice, "p", []byte(`{}`))
	eventually(t, "11th error crashes", func() bool { st, _ := state(h, "p"); return st == "crashed" })
	if _, msg := state(h, "p"); !strings.Contains(msg, "boom") {
		t.Fatalf("error %q", msg)
	}
}

func TestSendBudgetAndSize(t *testing.T) {
	h, sink, _ := newHost(t, map[string]string{"p": `
let sent: number | null = null;
export function onMessage(p: { id: number }, m: { big?: boolean }) {
  if (m.big) {
    let ok = true;
    try { hq.send(p.id, { s: "x".repeat(4100) }); } catch { ok = false; }
    hq.send(p.id, { bigok: ok });
    return;
  }
  sent = 0;
  for (let i = 1; i <= 30; i++) if (hq.send(p.id, { i })) sent++;
}
export function update() { if (sent !== null && hq.broadcast({ sent })) sent = null; } // refused (budget just spent): retried next update`})
	h.Presence(alice, true)
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	h.Message(alice, "p", []byte(`{}`))
	eventually(t, "burst result", func() bool {
		st, msg := state(h, "p")
		if st != "running" {
			t.Fatalf("plugin %s: %s", st, msg)
		}
		return len(sink.data(0)) > 0
	})
	if got := sink.data(0)[0]["sent"]; got != float64(20) {
		t.Fatalf("burst allowed %v messages, want 20", got)
	}
	time.Sleep(300 * time.Millisecond) // refill a few tokens
	h.Message(alice, "p", []byte(`{"big":true}`))
	eventually(t, "size result", func() bool { return sink.find(1, "bigok", nil) })
	if !sink.find(1, "bigok", false) {
		t.Fatal("a message over 4 KB must throw")
	}
}

func TestKV(t *testing.T) {
	src := `
const fails = (f: () => void) => { try { f(); return false; } catch { return true; } };
export function load() {
  if (hq.kv.get("missing") !== null) throw new Error("missing key");
  const n = Number(hq.kv.get("n") ?? "0");
  hq.kv.set("n", String(n + 1));
  hq.kv.set("gone", "x"); hq.kv.delete("gone");
  if (hq.kv.get("gone") !== null) throw new Error("delete");
  if (!fails(() => hq.kv.set("k".repeat(129), "v"))) throw new Error("long key");
  if (!fails(() => hq.kv.set("k", "v".repeat(4097)))) throw new Error("long value");
  if (!fails(() => hq.kv.set("k", 5 as any))) throw new Error("non-string value");
}
export function onMessage(p: { id: number }) {
  let ok = true;
  for (let i = 1; i <= 1000; i++) ok = !fails(() => hq.kv.set("k" + i, "v")) && ok;
  hq.send(p.id, { fill: ok, over: !fails(() => hq.kv.set("k1001", "v")), rewrite: !fails(() => hq.kv.set("k5", "w")) });
}`
	h, sink, kv := newHost(t, map[string]string{"p": src})
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	h.Stop("p")
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	if v, _ := kv.Load("p"); v["n"] != "2" {
		t.Fatalf("kv after two starts: %+v", v)
	}
	h.Presence(alice, true)
	h.Message(alice, "p", []byte(`{}`))
	eventually(t, "fill", func() bool { return sink.find(1, "fill", nil) })
	d := sink.data(1)[0]
	// "n" already holds one key, so 999 of the 1000 fit
	if d["fill"] != false || d["over"] != false || d["rewrite"] != true {
		t.Fatalf("limits: %+v", d)
	}
}

func TestRoutes(t *testing.T) {
	h, _, _ := newHost(t, map[string]string{"p": `
export function load() {
  hq.route("GET", "/mine", (req) => ({ body: { id: req.player.id, q: req.query.k } }));
  hq.route("POST", "/text", (req) => ({ status: 201, body: "got " + req.body }));
  hq.route("GET", "/empty", () => {});
  hq.route("GET", "/spin", () => { for (;;) {} });
}`})
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	r, err := h.Route(ctx, "p", "GET", "/mine", RouteReq{Player: alice, Query: map[string][]string{"k": {"v"}}})
	if err != nil || r.Status != 200 || r.ContentType != "application/json" || string(r.Body) != `{"id":1,"q":"v"}` {
		t.Fatalf("GET: %+v %s %v", r, r.Body, err)
	}
	r, err = h.Route(ctx, "p", "POST", "/text", RouteReq{Player: alice, Body: []byte("abc")})
	if err != nil || r.Status != 201 || !strings.HasPrefix(r.ContentType, "text/plain") || string(r.Body) != "got abc" {
		t.Fatalf("POST: %+v %v", r, err)
	}
	if r, err := h.Route(ctx, "p", "GET", "/empty", RouteReq{Player: alice}); err != nil || r.Status != 200 || len(r.Body) != 0 {
		t.Fatalf("empty: %+v %v", r, err)
	}
	if _, err := h.Route(ctx, "p", "GET", "/nope", RouteReq{Player: alice}); !errors.Is(err, ErrNoRoute) {
		t.Fatalf("unknown route: %v", err)
	}
	if _, err := h.Route(ctx, "p", "POST", "/mine", RouteReq{Player: alice}); !errors.Is(err, ErrNoRoute) {
		t.Fatalf("wrong method: %v", err)
	}
	start := time.Now()
	if _, err := h.Route(ctx, "p", "GET", "/spin", RouteReq{Player: alice}); err == nil || time.Since(start) > 1100*time.Millisecond {
		t.Fatalf("spinning route: %v after %v", err, time.Since(start))
	}
	h.Stop("p")
	if _, err := h.Route(ctx, "p", "GET", "/mine", RouteReq{Player: alice}); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("after stop: %v", err)
	}
}

func TestRouteOutsideLoadThrows(t *testing.T) {
	h, sink, _ := newHost(t, map[string]string{"p": `
export function onMessage(p: { id: number }) {
  let late = true;
  try { hq.route("GET", "/x", () => {}); } catch { late = false; }
  hq.send(p.id, { late });
}`})
	h.Presence(alice, true)
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	h.Message(alice, "p", []byte(`{}`))
	eventually(t, "reply", func() bool { return sink.find(1, "late", false) })
}

func TestStopCallsUnload(t *testing.T) {
	h, _, kv := newHost(t, map[string]string{"p": `export function unload() { hq.kv.set("bye", "1"); }`})
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	h.Stop("p")
	if v, _ := kv.Load("p"); v["bye"] != "1" {
		t.Fatal("unload not called")
	}
	if st, _ := state(h, "p"); st != "disabled" {
		t.Fatalf("state %s", st)
	}
}

func TestJSONRoundTrip(t *testing.T) {
	h, sink, _ := newHost(t, map[string]string{"p": `
export function onMessage(p: { id: number }, m: unknown) {
  hq.send(p.id, { back: m, arr: [1, 2, 3], big: 1000000, frac: 0.5, s: JSON.stringify({ a: true }), empty: [], obj: {} });
}`})
	h.Presence(alice, true)
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	h.Message(alice, "p", []byte(`{"list":[1,"a",{"x":null}],"nested":{"k":[]}}`))
	eventually(t, "reply", func() bool { return sink.find(1, "back", nil) })
	sink.mu.Lock()
	frame := sink.sends[len(sink.sends)-1].frame
	sink.mu.Unlock()
	for _, want := range []string{`"t":"plg"`, `"pl":"p"`, `"arr":[1,2,3]`, `"big":1000000`, `"frac":0.5`, `"s":"{\"a\":true}"`, `"list":[1,"a",{"x":null}]`, `"empty":[]`, `"obj":{}`} {
		if !strings.Contains(frame, want) {
			t.Errorf("frame %s lacks %s", frame, want)
		}
	}
}

func TestBrokenPluginCannotStart(t *testing.T) {
	h, _, _ := newHost(t, map[string]string{"p": "export function ("})
	if err := h.Start("p"); err == nil {
		t.Fatal("broken plugin started")
	}
	if st, msg := state(h, "p"); st != "broken" || !strings.Contains(msg, "main.ts") {
		t.Fatalf("state %s %q", st, msg)
	}
	if err := h.Start("nope"); !errors.Is(err, ErrUnknown) {
		t.Fatalf("unknown: %v", err)
	}
}

func TestPresenceNeverWaitsForLoad(t *testing.T) {
	h, sink, _ := newHost(t, map[string]string{"slow": `
export function load() { const t0 = hq.now(); while (hq.now() - t0 < 0.04) {} }
export function onJoin(p: { id: number }) { hq.broadcast({ joined: p.id }); }`})
	go h.Start("slow")
	time.Sleep(10 * time.Millisecond)
	start := time.Now()
	h.Presence(alice, true)
	if d := time.Since(start); d > 5*time.Millisecond {
		t.Fatalf("Presence waited %v for load()", d)
	}
	eventually(t, "join seen after load", func() bool { return sink.find(0, "joined", float64(1)) })
}

func TestPresenceQueueIsCoalescedPerMember(t *testing.T) {
	h, sink, _ := newHost(t, map[string]string{"slow": `
export function onJoin(p: { id: number }) { const t0 = hq.now(); while (hq.now() - t0 < 0.03) {} hq.broadcast({ j: p.id }); }
export function onLeave(p: { id: number }) { hq.broadcast({ l: p.id }); }`})
	if err := h.Start("slow"); err != nil {
		t.Fatal(err)
	}
	h.Presence(alice, true)
	for i := 0; i < 10000; i++ {
		h.Presence(bob, i%2 == 0)
	}
	h.mu.Lock()
	in := h.inst["slow"]
	h.mu.Unlock()
	in.pmu.Lock()
	n := len(in.pres)
	in.pmu.Unlock()
	if n > 2 {
		t.Fatalf("%d presence events pending for 2 members", n)
	}
	eventually(t, "alice joined", func() bool { return sink.find(0, "j", float64(1)) })
	time.Sleep(100 * time.Millisecond)
	ps := 0
	for _, d := range sink.data(0) {
		if d["j"] == float64(2) {
			ps++
		}
	}
	if ps > 2 {
		t.Fatalf("bob joined %d times", ps)
	}
}

func TestCrashErrorIsTheMessage(t *testing.T) {
	h, _, _ := newHost(t, map[string]string{"p": "const x = 1;\nexport function load() { throw new Error('boom'); }"})
	if err := h.Start("p"); err == nil {
		t.Fatal("load throwing must fail")
	}
	if _, msg := state(h, "p"); !strings.Contains(msg, "Error: boom") || strings.Contains(msg, "\n") {
		t.Fatalf("error %q", msg)
	}
}

func TestTokenRoutesNeedTheManifestFlag(t *testing.T) {
	root := t.TempDir()
	write(t, root, map[string]string{
		"tok/plugin.json":  `{"name":"tok","title":"T","version":"1","server":"main.ts","appTokens":true}`,
		"tok/main.ts":      `export function load() { hq.route("POST", "/state", () => ({ body: "ok" }), { token: true }); hq.route("GET", "/mine", () => ({ body: "m" })); }`,
		"flag/plugin.json": `{"name":"flag","title":"T","version":"1","server":"main.ts"}`,
		"flag/main.ts":     `export function load() { hq.route("POST", "/state", () => ({ body: "ok" }), { token: true }); }`,
	})
	cat, err := scanDir(root, Installed)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHost(cat, &fakeSink{}, newMemKV(), quiet)
	t.Cleanup(h.Close)
	if i, _ := h.Info("tok"); !i.AppTokens {
		t.Fatal("manifest appTokens not read")
	}
	if err := h.Start("tok"); err != nil {
		t.Fatal(err)
	}
	if found, token := h.RouteAuth("tok", "POST", "/state"); !found || !token {
		t.Fatalf("token route: %v %v", found, token)
	}
	if found, token := h.RouteAuth("tok", "GET", "/mine"); !found || token {
		t.Fatalf("session route: %v %v", found, token)
	}
	if found, _ := h.RouteAuth("tok", "GET", "/nope"); found {
		t.Fatal("unknown route found")
	}
	if err := h.Start("flag"); err == nil || !strings.Contains(err.Error(), "appTokens") {
		t.Fatalf("a token route without appTokens in the manifest must fail to load: %v", err)
	}
}

// objHost installs plugin "p" declaring the object kind "thing", with the given server source.
func objHost(t *testing.T, src string) (*Host, *fakeSink) {
	t.Helper()
	root := t.TempDir()
	write(t, root, map[string]string{
		"p/plugin.json":      `{"name":"p","title":"T","version":"1.0.0","description":"d","server":"main.ts","client":"client.js","objects":[{"kind":"thing","label":"Thing","size":[1,1],"sprite":"thing.png"}]}`,
		"p/main.ts":          src,
		"p/public/client.js": "",
		"p/public/thing.png": "png",
	})
	cat, err := scanDir(root, Installed)
	if err != nil {
		t.Fatal(err)
	}
	sink := &fakeSink{}
	h := NewHost(cat, sink, newMemKV(), quiet)
	t.Cleanup(h.Close)
	return h, sink
}

func TestUseCallsOnUse(t *testing.T) {
	h, sink := objHost(t, `
export function onUse(p: { id: number }, o: { kind: string; x: number; y: number }) { hq.send(p.id, { k: o.kind, x: o.x, y: o.y }); }`)
	h.Use(alice, "p", "thing", 3, 4) // not running yet: nothing
	h.Presence(alice, true)
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	h.Use(alice, "p", "other", 1, 1) // kind the manifest does not declare
	h.Use(alice, "p", "thing", 3, 4)
	eventually(t, "onUse answered", func() bool { return len(sink.data(alice.ID)) == 1 })
	got := sink.data(alice.ID)[0]
	if got["k"] != "thing" || got["x"] != float64(3) || got["y"] != float64(4) {
		t.Fatalf("onUse got %v", got)
	}
	time.Sleep(100 * time.Millisecond)
	if n := len(sink.data(alice.ID)); n != 1 {
		t.Fatalf("an undeclared kind or a stopped plugin must reach nothing, got %d frames", n)
	}
	h.Stop("p")
	h.Use(alice, "p", "thing", 3, 4)
	time.Sleep(100 * time.Millisecond)
	if n := len(sink.data(alice.ID)); n != 1 {
		t.Fatalf("a stopped plugin must not be called, got %d frames", n)
	}
}

func TestUseErrorsCountLikeAnyExport(t *testing.T) {
	h, _ := objHost(t, "export function onUse() { throw new Error('boom'); }")
	h.Presence(alice, true)
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 11; i++ {
		h.Use(alice, "p", "thing", 1, 1)
	}
	eventually(t, "11th error crashes", func() bool { st, _ := state(h, "p"); return st == "crashed" })
	if _, msg := state(h, "p"); !strings.Contains(msg, "boom") {
		t.Fatalf("error %q", msg)
	}
}
