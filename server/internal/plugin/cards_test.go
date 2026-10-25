package plugin

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	h, sink, errs := cardsHost(t, newMemKV(), []string{cards}, players...)
	freeTable(t, h, sink, 9, 9, players...)
	for i := 1; i < 16; i++ {
		cardSend(h, alice, `{"t":"newPile","x":9,"y":9,"name":"%016d","face":"up","at":[300,170]}`, i)
	}
	for i := 0; i < 54; i++ {
		cardSend(h, players[i%8], `{"t":"place","x":9,"y":9,"from":{"k":"pile","id":"p0"},"to":{"k":"felt","at":[%d,%d]},"up":true}`, 100+i, 100+i)
		if i%4 == 3 {
			time.Sleep(50 * time.Millisecond) // a page's own budget (8 a second) spaces them out too
		}
	}
	// about 10 s on one core under the race detector: every drop saves the table and sends it to 8 pages
	slowly(t, 30*time.Second, "54 cards on the felt", func() bool {
		tb, _ := tableOf(sink, alice.ID, 9, 9)
		return tb != nil && len(tb["loose"].([]any)) == 54
	})
	if n := errs.n.Load(); n != 0 {
		t.Fatalf("%d plugin errors", n)
	}
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
	h, sink, _ := cardsHostWith(t, map[string]string{"partgame": partGame}, alice, bob)
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

// Wide characters: the 4 KB limits are bytes, and a name of 24 CJK characters is 72 of them. Nothing a
// member can do stops the plugin: every frame stays under 4096 bytes and no error is thrown.
func TestCardsWideNamesStayUnderTheLimits(t *testing.T) {
	players := []Player{}
	for i := 1; i <= 8; i++ {
		players = append(players, Player{ID: uint32(i), Name: strings.Repeat("牌", 23) + string(rune('A'+i)), Role: "member"})
	}
	kv := newMemKV()
	h, sink, errs := cardsHost(t, kv, []string{cards}, players...)
	freeTable(t, h, sink, 9, 9, players...)
	for i := 1; i < 16; i++ {
		cardSend(h, players[0], `{"t":"newPile","x":9,"y":9,"name":"%s","face":"up","at":[300,170]}`, strings.Repeat("牌", 15)+string(rune('a'+i)))
	}
	for i := 0; i < 54; i++ {
		cardSend(h, players[i%8], `{"t":"place","x":9,"y":9,"from":{"k":"pile","id":"p0"},"to":{"k":"felt","at":[%d,%d]},"up":true}`, 100+i, 100+i)
		if i%8 == 7 {
			time.Sleep(150 * time.Millisecond) // let update() send what is queued
		}
	}
	for i := 0; i < 12; i++ {
		cardSend(h, players[1], `{"t":"count","x":9,"y":9}`)
	}
	time.Sleep(500 * time.Millisecond)
	if st, msg := state(h, cards); st != "running" || errs.n.Load() != 0 {
		t.Fatalf("hq-cards is %s (%s) with %d errors", st, msg, errs.n.Load())
	}
	sink.mu.Lock()
	for _, s := range sink.sends {
		if len(s.frame) > 4096+64 {
			sink.mu.Unlock()
			t.Fatalf("a frame of %d bytes: %.120s", len(s.frame), s.frame)
		}
	}
	sink.mu.Unlock()
	kv.mu.Lock()
	defer kv.mu.Unlock()
	for k, v := range kv.m[cards] {
		if len(v) > 4096 {
			t.Fatalf("%s is %d bytes", k, len(v))
		}
	}
}

// A malformed choice is ignored, never thrown: eleven of them would stop the plugin.
func TestCardsMalformedChoiceIsIgnored(t *testing.T) {
	h, sink, errs := cardsHost(t, newMemKV(), []string{cards}, alice)
	h.Use(alice, cards, "deck", 4, 4)
	eventually(t, "the game list", func() bool { return lastOf(sink, alice.ID, "games", 4, 4) != nil })
	for i := 0; i < 12; i++ {
		cardSend(h, alice, `{"t":"choose","x":4,"y":4,"game":{"toString":1}}`)
		cardSend(h, alice, `{"t":"choose","x":4,"y":4,"game":["free"]}`)
	}
	time.Sleep(300 * time.Millisecond)
	if st, msg := state(h, cards); st != "running" || errs.n.Load() != 0 {
		t.Fatalf("hq-cards is %s (%s) with %d errors", st, msg, errs.n.Load())
	}
}

// cardsHostWith runs hq-cards and test plugins (name -> server code, started after hq-cards) on a fresh store.
func cardsHostWith(t *testing.T, extra map[string]string, online ...Player) (*Host, *fakeSink, *errCounter) {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{}
	for name, src := range extra {
		files["installed/"+name+"/plugin.json"] = `{"name":"` + name + `","title":"T","version":"1.0.0","description":"d","server":"main.js"}`
		files["installed/"+name+"/main.js"] = src
	}
	for _, b := range []string{"hq-cards", "hq-card-pouilleux", "hq-card-lastcard"} {
		src := filepath.Join("..", "..", "..", "plugins", "bundled", b)
		if err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			rel, _ := filepath.Rel(src, path)
			data, err := os.ReadFile(path)
			files["bundled/"+b+"/"+filepath.ToSlash(rel)] = string(data)
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	write(t, root, files)
	cat, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	sink, errs := &fakeSink{}, &errCounter{}
	h := NewHost(cat, sink, newMemKV(), slog.New(errs))
	t.Cleanup(h.Close)
	for _, p := range online {
		h.Presence(p, true)
	}
	names := []string{cards}
	for name := range extra {
		names = append(names, name)
	}
	for _, n := range names {
		if err := h.Start(n); err != nil {
			t.Fatal(err)
		}
	}
	return h, sink, errs
}

// answer sends {t: typ} to a test plugin and waits for its reply {t: "r"+typ, r}.
func answer(t *testing.T, h *Host, sink *fakeSink, p Player, plugin, typ string) map[string]any {
	t.Helper()
	before := 0
	for _, d := range sink.data(p.ID) {
		if d["t"] == "r"+typ {
			before++
		}
	}
	h.Message(p, plugin, []byte(`{"t":"`+typ+`"}`))
	var got map[string]any
	eventually(t, typ+" answered", func() bool {
		n := 0
		for _, d := range sink.data(p.ID) {
			if d["t"] == "r"+typ {
				n, got = n+1, d
			}
		}
		return n > before
	})
	return got
}

// A deck whose wide names pass in parts is refused at its last part: chosen, it would not fit a message.
const wideGame = `
const names = (n) => Array.from({ length: n }, () => ({ name: "漢".repeat(24) }));
const reply = (p, t) => (r) => hq.send(p.id, { t, r });
export function onMessage(p, m) {
  if (m.t === "a") hq.plugins.call("hq-cards", "register", { title: "Wide", seats: [2, 4], deck: { sheet: "shared/c.png", cell: [20, 28], back: 0, total: 100, cards: names(40) } }).then(reply(p, "ra"), reply(p, "ra"));
  if (m.t === "b") hq.plugins.call("hq-cards", "registerCards", { from: 40, cards: names(40) }).then(reply(p, "rb"), reply(p, "rb"));
  if (m.t === "c") hq.plugins.call("hq-cards", "registerCards", { from: 80, cards: names(20) }).then(reply(p, "rc"), reply(p, "rc"));
}
`

func TestCardsWideDeckRefused(t *testing.T) {
	h, sink, errs := cardsHostWith(t, map[string]string{"widegame": wideGame}, alice)
	ok := func(d map[string]any) bool { r, _ := d["r"].(map[string]any); return r != nil && r["ok"] == true }
	a := answer(t, h, sink, alice, "widegame", "a")
	b, c := map[string]any{}, map[string]any{}
	if ok(a) {
		if b = answer(t, h, sink, alice, "widegame", "b"); ok(b) {
			c = answer(t, h, sink, alice, "widegame", "c")
		}
	}
	if ok(a) && ok(b) && ok(c) {
		t.Fatal("a deck of 100 names of 72 bytes was accepted")
	}
	h.Use(alice, cards, "deck", 5, 5)
	eventually(t, "the list", func() bool { return lastOf(sink, alice.ID, "games", 5, 5) != nil })
	if l := lastOf(sink, alice.ID, "games", 5, 5)["list"].([]any); len(l) != 1 {
		t.Fatalf("only the free table is offered: %v", l)
	}
	if errs.n.Load() != 0 {
		t.Fatalf("%d plugin errors", errs.n.Load())
	}
}

// Only hq-cards plays a game: a plugin named "free" cannot register, and a game's count hook refuses other
// callers without throwing (thrown errors would stop the game).
const freeImpostor = `
export function onMessage(p, m) {
  if (m.t === "a") hq.plugins.call("hq-cards", "register", { title: "Free table", seats: [2, 8], deck: { standard: ["AS", "KS"] } }).then((r) => hq.send(p.id, { t: "ra", r }), (e) => hq.send(p.id, { t: "ra", r: { err: String(e) } }));
  if (m.t === "b") for (const g of ["hq-card-pouilleux", "hq-card-lastcard"]) hq.plugins.call(g, "count", { seats: [], hands: [], piles: [], loose: [] }).then(() => {}, () => {});
}
`

func TestCardsOthersCannotPose(t *testing.T) {
	h, sink, errs := cardsHostWith(t, map[string]string{"free": freeImpostor}, alice)
	for _, g := range []string{"hq-card-pouilleux", "hq-card-lastcard"} {
		if err := h.Start(g); err != nil {
			t.Fatal(err)
		}
	}
	if r := answer(t, h, sink, alice, "free", "a")["r"].(map[string]any); r["ok"] == true {
		t.Fatalf("a plugin named free registered: %v", r)
	}
	for i := 0; i < 12; i++ {
		h.Message(alice, "free", []byte(`{"t":"b"}`))
	}
	time.Sleep(500 * time.Millisecond)
	for _, g := range []string{"hq-card-pouilleux", "hq-card-lastcard", cards} {
		if st, msg := state(h, g); st != "running" {
			t.Fatalf("%s is %s: %s", g, st, msg)
		}
	}
	_ = errs
}

// A table reset frees its keys; looking again at the pile one already looks at writes nothing new.
func TestCardsResetFreesKeysAndLookOnce(t *testing.T) {
	kv := newMemKV()
	h, sink, _ := cardsHost(t, kv, []string{cards}, alice, bob)
	freeTable(t, h, sink, 8, 8, alice, bob)
	for i := 0; i < 5; i++ {
		cardSend(h, alice, `{"t":"look","x":8,"y":8,"pile":"p0"}`)
	}
	cardSend(h, alice, `{"t":"draw","x":8,"y":8,"pile":"p0"}`)
	eventually(t, "the draw logged", func() bool { return has(logVerbs(sink, bob.ID, 8, 8), "drew") })
	n := 0
	for _, v := range logVerbs(sink, bob.ID, 8, 8) {
		if v == "looked" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("five looks at the same pile log %d lines", n)
	}
	kv.mu.Lock()
	_, saved := kv.m[cards]["table:8,8"]
	kv.mu.Unlock()
	if !saved {
		t.Fatal("the table is saved while it plays")
	}
	cardSend(h, alice, `{"t":"reset","x":8,"y":8}`)
	eventually(t, "the keys freed", func() bool {
		kv.mu.Lock()
		defer kv.mu.Unlock()
		_, a := kv.m[cards]["table:8,8"]
		_, b := kv.m[cards]["log:8,8"]
		return !a && !b
	})
}

// slowly is eventually with a longer limit, for checks that wait on many messages under the race detector
// on a slow runner.
func slowly(t *testing.T, limit time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out: %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Round 2 through the real host: snapping for the table, cards and piles moved, cards set aside until a reset.
func TestCardsRoundTwo(t *testing.T) {
	h, sink, errs := cardsHost(t, newMemKV(), []string{cards}, alice, bob)
	freeTable(t, h, sink, 3, 7, alice, bob)
	cardSend(h, bob, `{"t":"snap","x":3,"y":7,"on":false}`)
	waitTable(t, sink, alice.ID, 3, 7, "snapping off for everybody", func(tb, _ map[string]any) bool { return tb["snap"] == false })
	eventually(t, "the switch logged", func() bool { return has(logVerbs(sink, alice.ID, 3, 7), "snap") })
	for i := 0; i < 3; i++ {
		cardSend(h, alice, `{"t":"place","x":3,"y":7,"from":{"k":"pile","id":"p0"},"to":{"k":"felt","at":[60,%d]},"up":true}`, 48+13*i)
	}
	tb := waitTable(t, sink, alice.ID, 3, 7, "a cascade of 3", func(tb, _ map[string]any) bool { return len(tb["loose"].([]any)) == 3 })
	var ids []string
	for _, l := range tb["loose"].([]any) {
		ids = append(ids, fmt.Sprint(int(l.(map[string]any)["c"].(float64))&^128))
	}
	cardSend(h, bob, `{"t":"moveCards","x":3,"y":7,"cards":[%s],"dx":100,"dy":10}`, strings.Join(ids, ","))
	waitTable(t, sink, alice.ID, 3, 7, "the cascade moved", func(tb, _ map[string]any) bool {
		at := tb["loose"].([]any)[0].(map[string]any)["at"].([]any)
		return at[0] == 160.0 && at[1] == 58.0
	})
	cardSend(h, alice, `{"t":"newPile","x":3,"y":7,"name":"Waste","face":"up","at":[20,20]}`)
	cardSend(h, alice, `{"t":"movePile","x":3,"y":7,"pile":"p1","at":[40,200]}`)
	waitTable(t, sink, bob.ID, 3, 7, "the pile moved", func(tb, _ map[string]any) bool {
		ps := tb["piles"].([]any)
		return len(ps) == 2 && ps[1].(map[string]any)["at"].([]any)[1] == 200.0
	})
	cardSend(h, alice, `{"t":"setAside","x":3,"y":7,"from":{"k":"pile","id":"p0"}}`)
	waitTable(t, sink, bob.ID, 3, 7, "a card set aside", func(tb, _ map[string]any) bool { return len(tb["out"].([]any)) == 1 })
	cardSend(h, alice, `{"t":"gather","x":3,"y":7}`)
	waitTable(t, sink, bob.ID, 3, 7, "gathered, the card still out", func(tb, _ map[string]any) bool {
		return len(tb["piles"].([]any)[0].(map[string]any)["cards"].([]any)) == 53 && len(tb["out"].([]any)) == 1
	})
	// hostile shapes: refused, never thrown
	for _, m := range []string{
		`{"t":"snap","x":3,"y":7,"on":"yes"}`, `{"t":"moveCards","x":3,"y":7,"cards":"1","dx":1,"dy":1}`,
		`{"t":"moveCards","x":3,"y":7,"cards":[1],"dx":"1","dy":1}`, `{"t":"movePile","x":3,"y":7,"pile":{},"at":[1,1]}`,
		`{"t":"movePile","x":3,"y":7,"pile":"p0","at":"1,1"}`, `{"t":"setAside","x":3,"y":7,"from":null}`,
		`{"t":"setAside","x":3,"y":7,"from":{"k":"hand","i":99}}`,
	} {
		cardSend(h, alice, "%s", m)
	}
	cardSend(h, alice, `{"t":"reset","x":3,"y":7}`)
	eventually(t, "the choice again", func() bool { tb, _ := tableOf(sink, alice.ID, 3, 7); return tb != nil && tb["game"] == nil })
	cardSend(h, alice, `{"t":"choose","x":3,"y":7,"game":"free"}`)
	waitTable(t, sink, alice.ID, 3, 7, "a new game from the whole deck", func(tb, _ map[string]any) bool {
		return tb["game"] == "free" && len(tb["piles"].([]any)[0].(map[string]any)["cards"].([]any)) == 54 && len(tb["out"].([]any)) == 0
	})
	if n := errs.n.Load(); n != 0 {
		t.Fatalf("%d plugin errors", n)
	}
}

// Last Card turned off and on while its table is open: the open window gets its table back, available.
func TestCardsSplitGameOffAndOn(t *testing.T) {
	h, sink, errs := cardsHost(t, newMemKV(), []string{cards, "hq-card-lastcard"}, alice)
	const x, y = 5, 9
	eventually(t, "Last Card listed", func() bool {
		h.Use(alice, cards, "deck", x, y)
		d := lastOf(sink, alice.ID, "games", x, y)
		return d != nil && len(d["list"].([]any)) == 2
	})
	cardSend(h, alice, `{"t":"choose","x":%d,"y":%d,"game":"hq-card-lastcard"}`, x, y)
	waitTable(t, sink, alice.ID, x, y, "Last Card chosen", func(tb, s map[string]any) bool { return tb["game"] == "hq-card-lastcard" && s["unavailable"] == false })
	h.Stop("hq-card-lastcard")
	waitTable(t, sink, alice.ID, x, y, "unavailable", func(_, s map[string]any) bool { return s["unavailable"] == true })
	cardSend(h, alice, `{"t":"close","x":%d,"y":%d}`, x, y)
	h.Use(alice, cards, "deck", x, y) // the window opened again while the game is off
	if err := h.Start("hq-card-lastcard"); err != nil {
		t.Fatal(err)
	}
	slowly(t, 5*time.Second, "available again in the open window", func() bool {
		_, s := tableOf(sink, alice.ID, x, y)
		g := lastOf(sink, alice.ID, "game", x, y)
		return s != nil && s["unavailable"] == false && g != nil
	})
	if n := errs.n.Load(); n != 0 {
		t.Fatalf("%d plugin errors", n)
	}
}

// A 32-card game from the free table: the 2s to 6s and the jokers set aside in one message, back at a reset.
func TestCardsSetAsideRanks(t *testing.T) {
	h, sink, errs := cardsHost(t, newMemKV(), []string{cards}, alice, bob)
	freeTable(t, h, sink, 8, 3, alice, bob)
	cardSend(h, bob, `{"t":"setAsideRanks","x":8,"y":3,"ranks":["2","3","4","5","6","X"]}`)
	waitTable(t, sink, alice.ID, 8, 3, "22 cards set aside", func(tb, _ map[string]any) bool {
		return len(tb["out"].([]any)) == 22 && len(tb["piles"].([]any)[0].(map[string]any)["cards"].([]any)) == 32
	})
	eventually(t, "logged", func() bool { return has(logVerbs(sink, alice.ID, 8, 3), "set aside") })
	for _, m := range []string{`{"t":"setAsideRanks","x":8,"y":3,"ranks":"2"}`, `{"t":"setAsideRanks","x":8,"y":3,"ranks":[2]}`, `{"t":"setAsideRanks","x":8,"y":3,"ranks":["22"]}`} {
		cardSend(h, bob, "%s", m)
	}
	if n := errs.n.Load(); n != 0 {
		t.Fatalf("%d plugin errors", n)
	}
}
