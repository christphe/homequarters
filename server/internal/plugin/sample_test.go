package plugin

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The sample plugin (plugins/bundled/hq-pets) is the one authors copy: members must not be able to stop it.
func sampleHost(t *testing.T) (*Host, *fakeSink) {
	t.Helper()
	return sampleHostKV(t, newMemKV())
}

func sampleHostKV(t *testing.T, kv *memKV) (*Host, *fakeSink) {
	t.Helper()
	cat, err := Scan(filepath.Join("..", "..", "..", "plugins"))
	if err != nil {
		t.Fatal(err)
	}
	sink := &fakeSink{}
	h := NewHost(cat, sink, kv, quiet)
	t.Cleanup(h.Close)
	return h, sink
}

func running(t *testing.T, h *Host) {
	t.Helper()
	if st, msg := state(h, pets); st != "running" {
		t.Fatalf("hq-pets is %s: %s", st, msg)
	}
}

const pets = "hq-pets"

// petsOf collects what the broadcasts last said about each member's pets.
func petsOf(sink *fakeSink) map[float64][]any {
	out := map[float64][]any{}
	for _, d := range sink.data(0) {
		if set, ok := d["set"].([]any); ok {
			for _, m := range set {
				mm := m.(map[string]any)
				out[mm["id"].(float64)] = mm["pets"].([]any)
			}
		}
	}
	return out
}

// youOf is the last "you" message a member got.
func youOf(sink *fakeSink, id uint32) map[string]any {
	var last map[string]any
	for _, d := range sink.data(id) {
		if d["t"] == "you" {
			last = d
		}
	}
	return last
}

func say(h *Host, p Player, msgs ...string) {
	for _, m := range msgs {
		h.Message(p, pets, []byte(m))
		time.Sleep(210 * time.Millisecond) // under the plugin's 5 changes a second
	}
}

func TestSampleSurvivesAFullOfficeArriving(t *testing.T) {
	kv := newMemKV()
	three := `[[0,"","a1"],[3,"ff8800","b2"],[8,"","c3"]]`
	for i := 1; i <= 80; i++ {
		kv.Set(pets, fmt.Sprint("p:", i), three)
	}
	h, sink := sampleHostKV(t, kv)
	for i := 1; i <= 40; i++ {
		h.Presence(Player{ID: uint32(i), Name: fmt.Sprint("m", i), Role: "member"}, true)
	}
	if err := h.Start(pets); err != nil {
		t.Fatal(err)
	}
	for i := 41; i <= 80; i++ { // and 40 more all at once while it runs
		h.Presence(Player{ID: uint32(i), Name: fmt.Sprint("m", i), Role: "member"}, true)
	}
	time.Sleep(1500 * time.Millisecond)
	running(t, h)
	seen := petsOf(sink)
	if len(seen) != 80 {
		t.Fatalf("broadcasts announced the pets of %d of 80 members", len(seen))
	}
	for id, p := range seen {
		if len(p) != 3 {
			t.Fatalf("member %v: %v", id, p)
		}
	}
	sink.mu.Lock()
	defer sink.mu.Unlock()
	for _, x := range sink.sends {
		if len(x.frame) > 4096 {
			t.Fatalf("a %d-byte message: the office's pets must be cut into pieces", len(x.frame))
		}
	}
}

func TestSampleAddsColoursAndRemoves(t *testing.T) {
	h, sink := sampleHost(t)
	h.Presence(bob, true)
	if err := h.Start(pets); err != nil {
		t.Fatal(err)
	}
	say(h, bob, `{"t":"add","k":0}`, `{"t":"add","k":0}`, `{"t":"add","k":8}`, `{"t":"add","k":4}`, `{"t":"add","k":9}`)
	time.Sleep(200 * time.Millisecond)
	got := petsOf(sink)[2]
	if len(got) != 3 || got[0].([]any)[0] != 0.0 || got[1].([]any)[0] != 0.0 || got[2].([]any)[0] != 8.0 {
		t.Fatalf("two cats and a seedling, the fourth refused at the default limit of 3: %v", got)
	}
	first := got[0].([]any)[2]
	say(h, bob, `{"t":"colour","i":1,"c":"3fa7d6"}`, `{"t":"colour","i":2,"c":"red"}`, `{"t":"remove","i":0}`)
	time.Sleep(200 * time.Millisecond)
	got = petsOf(sink)[2]
	if len(got) != 2 || got[0].([]any)[1] != "3fa7d6" || got[1].([]any)[1] != "" || got[0].([]any)[2] == first {
		t.Fatalf("after recolouring the second cat and removing the first: %v", got)
	}
	if y := youOf(sink, 2); y == nil || y["limit"] != 3.0 {
		t.Fatalf("a member is told the limit: %v", y)
	}
	running(t, h)
}

func TestSampleNamesPets(t *testing.T) {
	h, sink := sampleHost(t)
	h.Presence(bob, true)
	if err := h.Start(pets); err != nil {
		t.Fatal(err)
	}
	say(h, bob, `{"t":"add","k":3}`, `{"t":"add","k":0}`, `{"t":"name","i":0,"n":"  Foxy  "}`, `{"t":"name","i":1,"n":"Line\nbreak and a name far longer than twenty-four"}`, `{"t":"name","i":5,"n":"x"}`, `{"t":"name","i":0,"n":7}`)
	time.Sleep(200 * time.Millisecond)
	got := petsOf(sink)[2]
	if len(got) != 2 || got[0].([]any)[3] != "Foxy" || got[1].([]any)[3] != "Linebreak and a name far" {
		t.Fatalf("names are trimmed, one line and at most 24 characters: %v", got)
	}
	say(h, bob, `{"t":"mode","m":"wander"}`, `{"t":"wander","g":[[100,200,30],"9:abc"]}`, `{"t":"wander","g":[[1,2,500],null]}`, `{"t":"wander","g":["nope",null]}`)
	time.Sleep(200 * time.Millisecond)
	relayed := false
	for _, d := range sink.data(0) {
		if g, ok := d["go"].([]any); ok && len(g) == 1 {
			goals := g[0].(map[string]any)["g"].([]any)
			relayed = len(goals) == 2 && goals[1] == "9:abc"
		}
	}
	if !relayed {
		t.Fatal("a wander goal with its speed, and another pet to go along with, are relayed; a bad speed or pet id is not")
	}
	running(t, h)
}

func TestSampleLimitFollowsTheOfficeSetting(t *testing.T) {
	kv := newMemKV()
	h, sink := sampleHostKV(t, kv)
	h.Presence(alice, true)
	h.Presence(bob, true)
	if err := h.Start(pets); err != nil {
		t.Fatal(err)
	}
	say(h, bob, `{"t":"add","k":1}`, `{"t":"add","k":2}`, `{"t":"add","k":3}`, `{"t":"limit","n":8}`, `{"t":"add","k":4}`)
	time.Sleep(200 * time.Millisecond)
	if y := youOf(sink, 2); y["limit"] != 3.0 || len(petsOf(sink)[2]) != 3 {
		t.Fatalf("3 by default, and a page cannot change it: %v %v", y, petsOf(sink)[2])
	}
	h.SetSettings(pets, map[string]float64{"limit": 1}) // what Administration > Plugins does
	time.Sleep(300 * time.Millisecond)
	if y := youOf(sink, 2); y["limit"] != 1.0 {
		t.Fatalf("members are told the new limit: %v", y)
	}
	if got := petsOf(sink)[2]; len(got) != 1 {
		t.Fatalf("a lower limit shows only the first pet: %v", got)
	}
	h.SetSettings(pets, map[string]float64{"limit": 4})
	time.Sleep(300 * time.Millisecond)
	if got := petsOf(sink)[2]; len(got) != 3 || youOf(sink, 1)["limit"] != 4.0 {
		t.Fatalf("raised again before Bob changed anything, his three pets come back: %v %v", got, youOf(sink, 1))
	}
	running(t, h)
}

// Names in any script, the most pets, a crowd leaving and long wander goals all at once: no message
// may go over the 4 KB a plugin message carries (counted in UTF-8 bytes), or the plugin would crash.
func TestSampleMessagesStayUnderTheLimitInAnyScript(t *testing.T) {
	kv := newMemKV()
	name := strings.Repeat("猫", 24)
	var eight []string
	for k := 0; k < 8; k++ {
		eight = append(eight, fmt.Sprintf(`[%d,"ff8800","p%d","%s"]`, k, k, name))
	}
	for i := 1; i <= 60; i++ {
		kv.Set(pets, fmt.Sprint("p:", i), "["+strings.Join(eight, ",")+"]")
	}
	h, sink := sampleHostKV(t, kv)
	h.SetSettings(pets, map[string]float64{"limit": 8})
	for i := 1; i <= 60; i++ {
		h.Presence(Player{ID: uint32(i), Name: fmt.Sprint("m", i), Role: "member"}, true)
	}
	if err := h.Start(pets); err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond)
	for i := 1; i <= 30; i++ { // half the office leaves at once
		h.Presence(Player{ID: uint32(i), Name: fmt.Sprint("m", i), Role: "member"}, false)
	}
	for i := 31; i <= 60; i++ {
		p := Player{ID: uint32(i), Name: fmt.Sprint("m", i), Role: "member"}
		h.Message(p, pets, []byte(`{"t":"mode","m":"wander"}`))
		h.Message(p, pets, []byte(`{"t":"wander","g":[[12345.678901234,-9876.54321987,33.333333333],[1.000000001,2.0000003,10.5],null,"7:p1",[0,0,80],[5,5,40],[6,6,40],[7,7,40]]}`))
	}
	time.Sleep(2500 * time.Millisecond)
	running(t, h)
	got := petsOf(sink)
	for i := 31; i <= 60; i++ {
		if len(got[float64(i)]) != 8 || got[float64(i)][0].([]any)[3] != name {
			t.Fatalf("member %d: %v", i, got[float64(i)])
		}
	}
	sink.mu.Lock()
	defer sink.mu.Unlock()
	for _, x := range sink.sends {
		if len(x.frame) > 4096 {
			t.Fatalf("a %d-byte message", len(x.frame))
		}
	}
}

func TestSampleNamesAreNeverCutInsideACharacter(t *testing.T) {
	h, sink := sampleHost(t)
	h.Presence(bob, true)
	if err := h.Start(pets); err != nil {
		t.Fatal(err)
	}
	say(h, bob, `{"t":"add","k":0}`, `{"t":"name","i":0,"n":"`+strings.Repeat("🐈", 30)+`"}`)
	time.Sleep(200 * time.Millisecond)
	got := petsOf(sink)[2]
	if len(got) != 1 || got[0].([]any)[3] != strings.Repeat("🐈", 24) {
		t.Fatalf("24 whole characters: %v", got)
	}
}

func TestSampleIgnoresMalformedMessages(t *testing.T) {
	h, _ := sampleHost(t)
	h.Presence(alice, true)
	if err := h.Start(pets); err != nil {
		t.Fatal(err)
	}
	msgs := []string{`null`, `"x"`, `[]`, `{"t":5}`, `{"t":{}}`, `{"t":"nope"}`, `true`, `{}`, `[1,2]`, `{"t":null}`,
		`{"t":"add"}`, `{"t":"remove","i":"0"}`, `{"t":"colour","i":0}`, `{"t":"wander","g":"x"}`, `{"t":"wander","g":[[1]]}`, `{"t":"limit"}`}
	for i := 0; i < 12; i++ {
		msgs = append(msgs, `5`)
	}
	for _, m := range msgs {
		h.Message(alice, pets, []byte(m))
	}
	time.Sleep(300 * time.Millisecond)
	running(t, h)
}

func TestSampleSurvivesControlSpam(t *testing.T) {
	h, sink := sampleHost(t)
	h.Presence(alice, true)
	h.Presence(bob, true)
	if err := h.Start(pets); err != nil {
		t.Fatal(err)
	}
	spam := []string{`{"t":"add","k":2}`, `{"t":"add","k":99}`, `{"t":"colour","i":0,"c":"00ff00"}`, `{"t":"colour","i":7,"c":"00ff00"}`, `{"t":"remove","i":0}`,
		`{"t":"mode","m":"wander"}`, `{"t":"wander","g":[[10,20],[30,40]]}`, `{"t":"wander","g":[["a",1]]}`, `{"t":"wander","g":[[1e300,1]]}`, `{"t":"mode","m":"follow"}`, `{"t":"limit","n":5}`}
	for i := 0; i < 30; i++ { // 10 a second each, as fast as the socket allows
		h.Message(alice, pets, []byte(spam[i%len(spam)]))
		h.Message(bob, pets, []byte(spam[(i+3)%len(spam)]))
		time.Sleep(100 * time.Millisecond)
	}
	running(t, h)
	for i := 0; i < 30; i++ {
		h.Presence(bob, i%2 == 1)
	}
	time.Sleep(300 * time.Millisecond)
	running(t, h)
	if len(sink.data(0)) == 0 {
		t.Fatal("no broadcast at all")
	}
}

// Another plugin puts its own pets with members through the setPet hook: only with the member whose
// message it handles, at most 4, from its shared/ folder, apart from the member's own pets and limit.
func TestSampleGuestPetsThroughHooks(t *testing.T) {
	cat, err := Scan(filepath.Join("..", "..", "..", "plugins"))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	write(t, root, map[string]string{
		"caller/plugin.json": manifest("caller", "main.ts", ""),
		"caller/main.ts": `
export async function onMessage(p: HQ.Player, m: { hook: string; args: unknown }) {
  hq.broadcast({ hook: m.hook, r: await hq.plugins.call("hq-pets", m.hook, m.args) });
}
export async function update() {
  if (!(globalThis as any).once) { (globalThis as any).once = true; hq.broadcast({ hook: "alone", r: await hq.plugins.call("hq-pets", "setPet", { id: "a", sheet: "shared/a.png", cell: [24, 24] }) }); }
}`,
	})
	extra, err := scanDir(root, Installed)
	if err != nil {
		t.Fatal(err)
	}
	sink := &fakeSink{}
	h := NewHost(append(cat, extra...), sink, newMemKV(), quiet)
	t.Cleanup(h.Close)
	h.Presence(bob, true)
	for _, p := range []string{pets, "caller"} {
		if err := h.Start(p); err != nil {
			t.Fatal(p, err)
		}
	}
	answer := func(hook string) map[string]any {
		var got map[string]any
		eventually(t, hook, func() bool {
			for _, d := range sink.data(0) {
				if d["hook"] == hook {
					got = d["r"].(map[string]any)
				}
			}
			return got != nil
		})
		return got
	}
	if r := answer("alone"); r["ok"] != false {
		t.Fatalf("a call made on its own (no member's action) gives nobody a pet: %v", r)
	}
	say := func(hook, args string) map[string]any {
		before := 0
		for _, d := range sink.data(0) {
			if d["hook"] == hook {
				before++
			}
		}
		h.Message(bob, "caller", []byte(`{"hook":"`+hook+`","args":`+args+`}`))
		var got map[string]any
		eventually(t, hook, func() bool {
			n := 0
			for _, d := range sink.data(0) {
				if d["hook"] == hook {
					n++
					got = d["r"].(map[string]any)
				}
			}
			return n > before
		})
		time.Sleep(210 * time.Millisecond)
		return got
	}
	if r := say("setPet", `{"id":"x","sheet":"../main.ts","cell":[24,24]}`); r["ok"] != false {
		t.Fatalf("only a PNG of the caller's shared/ folder: %v", r)
	}
	for _, args := range []string{
		`{"id":"x","metadata":{"kind":25},"sheet":"shared/critter.png","cell":[24,24]}`, // a sheet or metadata, not both
		`{"id":"x","metadata":{"kind":25},"cell":[24,24]}`,                              // a drawn sheet carries its own size
		`{"id":"x","metadata":"` + strings.Repeat("m", 300) + `"}`,                      // at most 256 bytes
	} {
		if r := say("setPet", args); r["ok"] != false {
			t.Fatalf("refused: %s -> %v", args, r)
		}
	}
	for i := 0; i < 4; i++ {
		if r := say("setPet", fmt.Sprintf(`{"id":"p%d","sheet":"shared/critter.png","cell":[24,24],"name":"C%d"}`, i, i)); r["ok"] != true {
			t.Fatalf("guest %d: %v", i, r)
		}
	}
	if r := say("setPet", `{"id":"p9","sheet":"shared/critter.png","cell":[24,24]}`); r["ok"] != false || r["error"] != "full" {
		t.Fatalf("at most 4 guests: %v", r)
	}
	if r := say("setPet", `{"id":"p0","metadata":{"kind":25,"alt":true},"name":"Again"}`); r["ok"] != true {
		t.Fatalf("the same id replaces its pet, here with one the caller draws itself (metadata): %v", r)
	}
	if r := say("removePet", `{"id":"p1"}`); r["removed"] != true {
		t.Fatalf("remove: %v", r)
	}
	time.Sleep(200 * time.Millisecond)
	var guests []any
	for _, d := range sink.data(0) {
		if set, ok := d["set"].([]any); ok {
			for _, m := range set {
				if mm := m.(map[string]any); mm["id"] == float64(bob.ID) {
					guests = mm["guests"].([]any)
					if len(mm["pets"].([]any)) != 0 {
						t.Fatalf("guests are not the member's own pets: %v", mm)
					}
				}
			}
		}
	}
	if len(guests) != 3 || guests[0].(map[string]any)["from"] != "caller" {
		t.Fatalf("three guests left, from caller: %v", guests)
	}
	drawn := guests[2].(map[string]any)
	if md, _ := drawn["metadata"].(map[string]any); md["kind"] != float64(25) || md["alt"] != true || drawn["sheet"] != nil || drawn["cell"] != nil {
		t.Fatalf("a guest drawn by its plugin goes to the pages with its metadata, without a sheet: %v", drawn)
	}
	// the plugin stops: its guests go and their places are given back; running again, it puts them again
	h.Stop("caller")
	eventually(t, "guests gone with their plugin", func() bool {
		left := -1
		for _, d := range sink.data(0) {
			if set, ok := d["set"].([]any); ok {
				for _, m := range set {
					if mm := m.(map[string]any); mm["id"] == float64(bob.ID) {
						left = len(mm["guests"].([]any))
					}
				}
			}
		}
		return left == 0
	})
	if err := h.Start("caller"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		if r := say("setPet", fmt.Sprintf(`{"id":"q%d","sheet":"shared/critter.png","cell":[24,24]}`, i)); r["ok"] != true {
			t.Fatalf("the places of a stopped plugin's guests are free again (guest %d): %v", i, r)
		}
	}
	running(t, h)
}
