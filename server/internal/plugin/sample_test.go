package plugin

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

// The sample plugin (plugins/sample-pet) is the one authors copy: members must not be able to stop it.
func sampleHost(t *testing.T) (*Host, *fakeSink) {
	t.Helper()
	cat, err := Scan(filepath.Join("..", "..", "..", "plugins"))
	if err != nil {
		t.Fatal(err)
	}
	sink := &fakeSink{}
	h := NewHost(cat, sink, newMemKV(), quiet)
	t.Cleanup(h.Close)
	return h, sink
}

func running(t *testing.T, h *Host) {
	t.Helper()
	if st, msg := state(h, "sample-pet"); st != "running" {
		t.Fatalf("sample-pet is %s: %s", st, msg)
	}
}

func TestSampleSurvivesAFullOfficeArriving(t *testing.T) {
	h, sink := sampleHost(t)
	for i := 1; i <= 40; i++ {
		h.Presence(Player{ID: uint32(i), Name: fmt.Sprint("m", i), Role: "member"}, true)
	}
	if err := h.Start("sample-pet"); err != nil {
		t.Fatal(err)
	}
	for i := 41; i <= 80; i++ { // and 40 more all at once while it runs
		h.Presence(Player{ID: uint32(i), Name: fmt.Sprint("m", i), Role: "member"}, true)
	}
	time.Sleep(600 * time.Millisecond)
	running(t, h)
	seen := map[float64]bool{}
	for _, d := range sink.data(0) {
		if pets, ok := d["set"].([]any); ok {
			for _, p := range pets {
				seen[p.(map[string]any)["id"].(float64)] = true
			}
		}
	}
	if len(seen) != 80 {
		t.Fatalf("broadcasts announced %d of 80 creatures", len(seen))
	}
}

func TestSampleIgnoresMalformedMessages(t *testing.T) {
	h, _ := sampleHost(t)
	h.Presence(alice, true)
	if err := h.Start("sample-pet"); err != nil {
		t.Fatal(err)
	}
	msgs := []string{`null`, `"x"`, `[]`, `{"t":5}`, `{"t":{}}`, `{"t":"nope"}`, `true`, `{}`, `[1,2]`, `{"t":null}`}
	for i := 0; i < 12; i++ {
		msgs = append(msgs, `5`)
	}
	for _, m := range msgs {
		h.Message(alice, "sample-pet", []byte(m))
	}
	time.Sleep(300 * time.Millisecond)
	running(t, h)
}

func TestSampleSurvivesControlSpam(t *testing.T) {
	h, sink := sampleHost(t)
	h.Presence(alice, true)
	h.Presence(bob, true)
	if err := h.Start("sample-pet"); err != nil {
		t.Fatal(err)
	}
	spam := []string{`{"t":"variant","v":2}`, `{"t":"variant","v":9}`, `{"t":"variant","v":1.5}`, `{"t":"shown","on":false}`, `{"t":"shown","on":"x"}`,
		`{"t":"mode","m":"wander"}`, `{"t":"wander","x":10,"y":20}`, `{"t":"wander","x":"a","y":1}`, `{"t":"wander","x":1e300,"y":1}`, `{"t":"mode","m":"follow"}`}
	for i := 0; i < 30; i++ { // 10 a second each, as fast as the socket allows
		h.Message(alice, "sample-pet", []byte(spam[i%len(spam)]))
		h.Message(bob, "sample-pet", []byte(spam[(i+3)%len(spam)]))
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
