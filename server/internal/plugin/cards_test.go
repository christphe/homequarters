package plugin

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

// The bundled card table (plugins/bundled/hq-cards) through the real host: Use is X next to a deck,
// Message is what the page's code sends.

const cards = "hq-cards"

var dan = Player{ID: 4, Name: "Dan", Role: "member"}

func cardsHost(t *testing.T, kv *memKV, start []string, online ...Player) (*Host, *fakeSink, *errCounter) {
	t.Helper()
	cat, err := Scan(filepath.Join("..", "..", "..", "plugins"))
	if err != nil {
		t.Fatal(err)
	}
	sink, errs := &fakeSink{}, &errCounter{}
	h := NewHost(cat, sink, kv, slog.New(errs))
	t.Cleanup(h.Close)
	for _, p := range online {
		h.Presence(p, true)
	}
	for _, name := range start {
		if err := h.Start(name); err != nil {
			t.Fatal(err)
		}
		if st, msg := state(h, name); st != "running" {
			t.Fatalf("%s is %s: %s", name, st, msg)
		}
	}
	return h, sink, errs
}

func cardSend(h *Host, p Player, format string, a ...any) {
	h.Message(p, cards, []byte(fmt.Sprintf(format, a...)))
}

// lastOf is the last message of type typ a member got about the table at (x, y).
func lastOf(sink *fakeSink, id uint32, typ string, x, y int) map[string]any {
	var last map[string]any
	for _, d := range sink.data(id) {
		if d["t"] == typ && d["x"] == float64(x) && d["y"] == float64(y) {
			last = d
		}
	}
	return last
}

// tableOf is the table (s.t) of the last open or state message a member got for (x, y), and the whole state.
func tableOf(sink *fakeSink, id uint32, x, y int) (map[string]any, map[string]any) {
	var last map[string]any
	for _, d := range sink.data(id) {
		if (d["t"] == "open" || d["t"] == "state") && d["x"] == float64(x) && d["y"] == float64(y) {
			last = d["s"].(map[string]any)
		}
	}
	if last == nil {
		return nil, nil
	}
	return last["t"].(map[string]any), last
}

func waitTable(t *testing.T, sink *fakeSink, id uint32, x, y int, what string, ok func(tb, s map[string]any) bool) map[string]any {
	t.Helper()
	var tb map[string]any
	eventually(t, what, func() bool {
		var s map[string]any
		tb, s = tableOf(sink, id, x, y)
		return tb != nil && ok(tb, s)
	})
	return tb
}

func handSizes(tb map[string]any) []int {
	var out []int
	for _, h := range tb["hands"].([]any) {
		out = append(out, len(h.([]any)))
	}
	return out
}

func logVerbs(sink *fakeSink, id uint32, x, y int) []string {
	d := lastOf(sink, id, "log", x, y)
	if d == nil {
		return nil
	}
	var out []string
	for _, e := range d["log"].([]any) {
		out = append(out, e.(map[string]any)["v"].(string))
	}
	return out
}

func has(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// freeTable opens the deck at (x, y) for each player, chooses the free table and seats them in order.
func freeTable(t *testing.T, h *Host, sink *fakeSink, x, y int, players ...Player) {
	t.Helper()
	for _, p := range players {
		h.Use(p, cards, "deck", x, y)
	}
	eventually(t, "the game list", func() bool { return lastOf(sink, players[0].ID, "games", x, y) != nil })
	cardSend(h, players[0], `{"t":"choose","x":%d,"y":%d,"game":"free"}`, x, y)
	for i, p := range players {
		waitTable(t, sink, p.ID, x, y, p.Name+" sees the free table", func(tb, _ map[string]any) bool { return tb["game"] == "free" })
		cardSend(h, p, `{"t":"seat","x":%d,"y":%d,"seat":%d}`, x, y, i)
	}
	waitTable(t, sink, players[0].ID, x, y, "everybody seated", func(tb, _ map[string]any) bool {
		n := 0
		for _, s := range tb["seats"].([]any) {
			if s != nil {
				n++
			}
		}
		return n == len(players)
	})
}

func TestCardsFreeTable(t *testing.T) {
	h, sink, errs := cardsHost(t, newMemKV(), []string{cards}, alice, bob)
	h.Use(alice, cards, "deck", 4, 5)
	eventually(t, "the game list", func() bool { return lastOf(sink, alice.ID, "games", 4, 5) != nil })
	list := lastOf(sink, alice.ID, "games", 4, 5)["list"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["name"] != "free" || list[0].(map[string]any)["title"] != "Free table" {
		t.Fatalf("a new table offers the free table: %v", list)
	}
	freeTable(t, h, sink, 4, 5, alice, bob)
	if g := lastOf(sink, alice.ID, "game", 4, 5); g == nil || g["g"].(map[string]any)["name"] != "free" {
		t.Fatalf("the page is told the game: %v", g)
	}
	cardSend(h, alice, `{"t":"dealAll","x":4,"y":5,"pile":"p0"}`)
	for _, p := range []Player{alice, bob} {
		tb := waitTable(t, sink, p.ID, 4, 5, p.Name+" sees the deal", func(tb, _ map[string]any) bool { return handSizes(tb)[0] == 27 })
		if s := handSizes(tb); s[0] != 27 || s[1] != 27 {
			t.Fatalf("27 each: %v", s)
		}
	}
	eventually(t, "the deal logged", func() bool { return has(logVerbs(sink, bob.ID, 4, 5), "dealt") })
	if n := errs.n.Load(); n != 0 {
		t.Fatalf("%d plugin errors", n)
	}
}

func TestCardsOnlyViewersAct(t *testing.T) {
	h, sink, _ := cardsHost(t, newMemKV(), []string{cards}, alice, bob, carol)
	freeTable(t, h, sink, 1, 1, alice, bob)
	cardSend(h, carol, `{"t":"seat","x":1,"y":1,"seat":2}`) // never opened the deck
	cardSend(h, bob, `{"t":"close","x":1,"y":1}`)
	cardSend(h, bob, `{"t":"draw","x":1,"y":1,"pile":"p0"}`) // window closed
	cardSend(h, alice, `{"t":"draw","x":1,"y":1,"pile":"p0"}`)
	tb := waitTable(t, sink, alice.ID, 1, 1, "Alice's draw", func(tb, _ map[string]any) bool { return handSizes(tb)[0] == 1 })
	if s := handSizes(tb); s[1] != 0 || tb["seats"].([]any)[2] != nil {
		t.Fatalf("only members with the window open act: hands %v, seats %v", s, tb["seats"])
	}
}

func TestCardsStaleDrop(t *testing.T) {
	h, sink, _ := cardsHost(t, newMemKV(), []string{cards}, alice, bob)
	freeTable(t, h, sink, 2, 2, alice, bob)
	cardSend(h, alice, `{"t":"flip","x":2,"y":2,"from":{"k":"pile","id":"p0"}}`)
	tb := waitTable(t, sink, alice.ID, 2, 2, "the top turned up", func(tb, _ map[string]any) bool {
		c := tb["piles"].([]any)[0].(map[string]any)["cards"].([]any)
		return c[len(c)-1].(float64) >= 128
	})
	c := tb["piles"].([]any)[0].(map[string]any)["cards"].([]any)
	top := int(c[len(c)-1].(float64)) - 128
	cardSend(h, alice, `{"t":"place","x":2,"y":2,"from":{"k":"pile","id":"p0"},"to":{"k":"felt","at":[10,10]},"up":true}`)
	cardSend(h, bob, `{"t":"place","x":2,"y":2,"from":{"k":"loose","c":%d},"to":{"k":"hand","seat":1},"up":false}`, top)
	cardSend(h, alice, `{"t":"place","x":2,"y":2,"from":{"k":"loose","c":%d},"to":{"k":"felt","at":[50,50]},"up":true}`, top)
	tb = waitTable(t, sink, alice.ID, 2, 2, "the card in Bob's hand", func(tb, _ map[string]any) bool { return handSizes(tb)[1] == 1 })
	if len(tb["loose"].([]any)) != 0 {
		t.Fatalf("the second move of a card already taken is refused: %v", tb["loose"])
	}
}

func TestCardsSurvivesRestart(t *testing.T) {
	kv := newMemKV()
	h, sink, _ := cardsHost(t, kv, []string{cards}, alice, bob)
	freeTable(t, h, sink, 3, 3, alice, bob)
	cardSend(h, alice, `{"t":"deal","x":3,"y":3,"pile":"p0","n":5}`)
	waitTable(t, sink, alice.ID, 3, 3, "the deal", func(tb, _ map[string]any) bool { return handSizes(tb)[0] == 5 })
	h.Close()

	h2, sink2, _ := cardsHost(t, kv, []string{cards}, alice)
	h2.Use(alice, cards, "deck", 3, 3)
	tb := waitTable(t, sink2, alice.ID, 3, 3, "the table after a restart", func(tb, _ map[string]any) bool { return tb["game"] == "free" })
	if s := handSizes(tb); s[0] != 5 || s[1] != 5 {
		t.Fatalf("hands kept: %v", s)
	}
	eventually(t, "the log after a restart", func() bool { return has(logVerbs(sink2, alice.ID, 3, 3), "dealt") })
}

func TestCardsLookingClears(t *testing.T) {
	h, sink, _ := cardsHost(t, newMemKV(), []string{cards}, alice, bob)
	freeTable(t, h, sink, 6, 6, alice, bob)
	cardSend(h, alice, `{"t":"deal","x":6,"y":6,"pile":"p0","n":3}`)
	waitTable(t, sink, bob.ID, 6, 6, "the deal", func(tb, _ map[string]any) bool { return handSizes(tb)[0] == 3 })
	cardSend(h, alice, `{"t":"look","x":6,"y":6,"pile":"p0"}`)
	cardSend(h, alice, `{"t":"offer","x":6,"y":6,"to":1}`)
	waitTable(t, sink, bob.ID, 6, 6, "Alice looking and offering", func(tb, s map[string]any) bool {
		l, _ := s["looking"].([]any)
		return len(l) == 1 && l[0].(map[string]any)["pile"] == "p0" && tb["offer"] != nil
	})
	eventually(t, "the look logged", func() bool { return has(logVerbs(sink, bob.ID, 6, 6), "looked") })
	h.Presence(alice, false)
	waitTable(t, sink, bob.ID, 6, 6, "Alice gone: no longer looking, offer kept", func(tb, s map[string]any) bool {
		l, _ := s["looking"].([]any)
		return len(l) == 0 && tb["offer"] != nil
	})
	cardSend(h, bob, `{"t":"pick","x":6,"y":6,"i":0}`)
	waitTable(t, sink, bob.ID, 6, 6, "Bob picked from the absent Alice", func(tb, _ map[string]any) bool { return handSizes(tb)[1] == 4 })
}

func TestCardsReset(t *testing.T) {
	h, sink, _ := cardsHost(t, newMemKV(), []string{cards}, alice, bob, carol)
	freeTable(t, h, sink, 7, 7, alice, bob)
	h.Use(carol, cards, "deck", 7, 7)
	cardSend(h, carol, `{"t":"reset","x":7,"y":7}`) // a spectator while seated players are here
	cardSend(h, alice, `{"t":"draw","x":7,"y":7,"pile":"p0"}`)
	tb := waitTable(t, sink, carol.ID, 7, 7, "Alice's draw", func(tb, _ map[string]any) bool { return handSizes(tb)[0] == 1 })
	if tb["game"] != "free" {
		t.Fatal("a spectator cannot reset while a seated player is here")
	}
	cardSend(h, alice, `{"t":"close","x":7,"y":7}`)
	cardSend(h, bob, `{"t":"close","x":7,"y":7}`)
	cardSend(h, carol, `{"t":"reset","x":7,"y":7}`)
	eventually(t, "the choice again", func() bool {
		tb, _ := tableOf(sink, carol.ID, 7, 7)
		return tb != nil && tb["game"] == nil && lastOf(sink, carol.ID, "games", 7, 7) != nil
	})
}

func TestCardsMessageSizes(t *testing.T) {
	players := []Player{alice, bob, carol, dan}
	for i := 5; i <= 8; i++ {
		players = append(players, Player{ID: uint32(i), Name: fmt.Sprintf("%024d", i), Role: "member"})
	}
	h, sink, _ := cardsHost(t, newMemKV(), []string{cards}, players...)
	freeTable(t, h, sink, 9, 9, players...)
	for i := 1; i < 16; i++ {
		cardSend(h, alice, `{"t":"newPile","x":9,"y":9,"name":"%016d","face":"up","at":[300,170]}`, i)
	}
	for i := 0; i < 54; i++ {
		cardSend(h, players[i%8], `{"t":"place","x":9,"y":9,"from":{"k":"pile","id":"p0"},"to":{"k":"felt","at":[%d,%d]},"up":true}`, 100+i, 100+i)
		if i%4 == 3 {
			// the page's own budget (8 a second) would space them out; the test only needs them applied
			waitTable(t, sink, alice.ID, 9, 9, "drops applied", func(tb, _ map[string]any) bool { return len(tb["loose"].([]any)) >= i-2 })
		}
	}
	waitTable(t, sink, alice.ID, 9, 9, "54 cards on the felt", func(tb, _ map[string]any) bool { return len(tb["loose"].([]any)) == 54 })
	sink.mu.Lock()
	defer sink.mu.Unlock()
	for _, s := range sink.sends {
		if len(s.frame) > 4096 {
			var f struct{ D json.RawMessage }
			_ = json.Unmarshal([]byte(s.frame), &f)
			t.Fatalf("a frame of %d bytes: %.200s", len(s.frame), s.frame)
		}
	}
}

// A game registering again (games do whenever another plugin starts or stops) never makes its tables
// unavailable while its split deck arrives: the table keeps the complete definition it had.
const partGame = `
const def = (title) => ({ title, seats: [2, 4], deck: { sheet: "shared/c.png", cell: [20, 28], back: 4, total: 4, cards: [{ name: "One" }, { name: "Two" }] } });
export function onMessage(p, m) {
  if (m.t === "part1") hq.plugins.call("hq-cards", "register", def(m.title)).then((r) => hq.send(p.id, { t: "r1", r }));
  if (m.t === "part2") hq.plugins.call("hq-cards", "registerCards", { from: 2, cards: [{ name: "Three" }, { name: "Four" }] }).then((r) => hq.send(p.id, { t: "r2", r }));
}
`

func TestCardsReRegisterKeepsTables(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"installed/partgame/plugin.json": `{"name":"partgame","title":"Part game","version":"1.0.0","description":"d","server":"main.js"}`,
		"installed/partgame/main.js":     partGame,
	}
	src := filepath.Join("..", "..", "..", "plugins", "bundled", "hq-cards")
	if err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		b, err := os.ReadFile(path)
		files["bundled/hq-cards/"+filepath.ToSlash(rel)] = string(b)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	write(t, root, files)
	cat, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	sink := &fakeSink{}
	h := NewHost(cat, sink, newMemKV(), slog.New(&errCounter{}))
	t.Cleanup(h.Close)
	h.Presence(alice, true)
	h.Presence(bob, true)
	for _, n := range []string{cards, "partgame"} {
		if err := h.Start(n); err != nil {
			t.Fatal(err)
		}
	}
	part := func(n int) {
		t.Helper()
		typ := fmt.Sprintf("r%d", n)
		before := 0
		for _, d := range sink.data(alice.ID) {
			if d["t"] == typ {
				before++
			}
		}
		h.Message(alice, "partgame", []byte(fmt.Sprintf(`{"t":"part%d","title":"Part game"}`, n)))
		eventually(t, typ+" answered", func() bool {
			c := 0
			var last map[string]any
			for _, d := range sink.data(alice.ID) {
				if d["t"] == typ {
					c, last = c+1, d
				}
			}
			if c > before && last["r"].(map[string]any)["ok"] != true {
				t.Fatalf("%s refused: %v", typ, last)
			}
			return c > before
		})
	}
	part(1)
	part(2)
	const x, y = 2, 3
	h.Use(alice, cards, "deck", x, y)
	h.Use(bob, cards, "deck", x, y)
	eventually(t, "the part game listed", func() bool {
		d := lastOf(sink, alice.ID, "games", x, y)
		return d != nil && len(d["list"].([]any)) == 2
	})
	cardSend(h, alice, `{"t":"choose","x":%d,"y":%d,"game":"partgame"}`, x, y)
	waitTable(t, sink, alice.ID, x, y, "the part game chosen", func(tb, s map[string]any) bool { return tb["game"] == "partgame" && s["unavailable"] == false })
	part(1) // registering again: only the first part has arrived
	cardSend(h, bob, `{"t":"seat","x":%d,"y":%d,"seat":1}`, x, y)
	_, s := tableOf(sink, alice.ID, x, y)
	eventually(t, "Bob's seat", func() bool {
		var tb map[string]any
		tb, s = tableOf(sink, alice.ID, x, y)
		return tb["seats"].([]any)[1] != nil
	})
	if s["unavailable"] != false {
		t.Fatalf("the table went unavailable while its game registered again: %v", s)
	}
	part(2)
}
