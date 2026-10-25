package plugin

import (
	"strconv"
	"strings"
	"testing"
)

// The bundled Last Card game (plugins/bundled/hq-card-lastcard) on the card table, through the real host.
// It registers its 108 cards in two parts (64, then 44) and counts the points left in each hand.

const lastCard = "hq-card-lastcard"

func TestLastCardRegistersInParts(t *testing.T) {
	h, sink, errs := cardsHost(t, newMemKV(), []string{cards, lastCard}, alice, bob, carol)
	const x, y = 9, 4
	listed := func() bool {
		d := lastOf(sink, alice.ID, "games", x, y)
		if d == nil {
			return false
		}
		for _, g := range d["list"].([]any) {
			m := g.(map[string]any)
			if m["name"] == lastCard && m["title"] == "Last Card" {
				return true
			}
		}
		return false
	}
	h.Use(alice, cards, "deck", x, y)
	eventually(t, "Last Card in the game list", func() bool {
		if !listed() {
			h.Use(alice, cards, "deck", x, y) // registration is asynchronous: open the deck again
			return false
		}
		return true
	})

	for _, p := range []Player{bob, carol} {
		h.Use(p, cards, "deck", x, y)
	}
	cardSend(h, alice, `{"t":"choose","x":%d,"y":%d,"game":"hq-card-lastcard"}`, x, y)
	eventually(t, "the game message", func() bool { return lastOf(sink, alice.ID, "game", x, y) != nil })
	g := lastOf(sink, alice.ID, "game", x, y)["g"].(map[string]any)
	deck := g["deck"].(map[string]any)
	if names := deck["names"].([]any); len(names) != 108 || names[0] != "Red 0" || names[107] != "Wild Draw Four" {
		t.Fatalf("108 names, from Red 0 to Wild Draw Four: %d %v", len(names), names)
	}
	if deck["plugin"] != lastCard || deck["sheet"] != "shared/cards.png" || deck["back"] != float64(108) {
		t.Fatalf("the deck is the game's own sheet: %v", deck)
	}
	for _, n := range deck["names"].([]any) {
		if strings.Contains(strings.ToLower(n.(string)), "uno") {
			t.Fatalf("a card named after the trademarked game: %v", n)
		}
	}

	for i, p := range []Player{alice, bob, carol} {
		waitTable(t, sink, p.ID, x, y, p.Name+" sees Last Card", func(tb, _ map[string]any) bool { return tb["game"] == lastCard })
		cardSend(h, p, `{"t":"seat","x":%d,"y":%d,"seat":%d}`, x, y, i)
	}
	waitTable(t, sink, alice.ID, x, y, "three seated", func(tb, _ map[string]any) bool {
		n := 0
		for _, s := range tb["seats"].([]any) {
			if s != nil {
				n++
			}
		}
		return n == 3
	})
	tb, _ := tableOf(sink, alice.ID, x, y)
	if piles := tb["piles"].([]any); len(piles) != 2 || piles[0].(map[string]any)["name"] != "Draw" || piles[1].(map[string]any)["name"] != "Discard" {
		t.Fatalf("the starting piles are Draw and Discard: %v", piles)
	}

	cardSend(h, alice, `{"t":"deal","x":%d,"y":%d,"pile":"p0","n":7}`, x, y)
	tb = waitTable(t, sink, alice.ID, x, y, "seven each", func(tb, _ map[string]any) bool { return handSizes(tb)[2] == 7 })
	if s := handSizes(tb); s[0] != 7 || s[1] != 7 || s[2] != 7 {
		t.Fatalf("7 each: %v", s)
	}
	want := expectedCount(tb)

	cardSend(h, bob, `{"t":"count","x":%d,"y":%d}`, x, y)
	tb = waitTable(t, sink, alice.ID, x, y, "the count", func(tb, _ map[string]any) bool { return tb["count"] != "" })
	if tb["count"] != want {
		t.Fatalf("the count comes from the game's hook: %q, want %q", tb["count"], want)
	}

	// dealAll is not among Last Card's actions: nothing changes
	before := handSizes(tb)
	cardSend(h, alice, `{"t":"dealAll","x":%d,"y":%d,"pile":"p0"}`, x, y)
	cardSend(h, alice, `{"t":"draw","x":%d,"y":%d,"pile":"p0"}`, x, y) // allowed: proves the dealAll was handled first
	tb = waitTable(t, sink, alice.ID, x, y, "Alice's draw", func(tb, _ map[string]any) bool { return handSizes(tb)[0] == before[0]+1 })
	if s := handSizes(tb); s[1] != before[1] || s[2] != before[2] {
		t.Fatalf("dealAll is refused: before %v, after %v", before, s)
	}
	if n := errs.n.Load(); n != 0 {
		t.Fatalf("%d plugin errors", n)
	}
}

// expectedCount is the count text Last Card should give for a table: numbers their face value, Skip,
// Reverse and Draw Two 20, both wilds 50 (cards 100-107); card n of a colour is at n % 25.
func expectedCount(tb map[string]any) string {
	value := func(n int) int {
		if n >= 100 {
			return 50
		}
		switch i := n % 25; {
		case i == 0:
			return 0
		case i <= 18:
			return (i + 1) / 2
		default:
			return 20
		}
	}
	var parts []string
	hands := tb["hands"].([]any)
	for i, s := range tb["seats"].([]any) {
		if s == nil {
			continue
		}
		sum := 0
		for _, c := range hands[i].([]any) {
			sum += value(int(c.(float64)) &^ 128)
		}
		parts = append(parts, s.(map[string]any)["name"].(string)+" "+strconv.Itoa(sum))
	}
	return strings.Join(parts, ", ")
}
