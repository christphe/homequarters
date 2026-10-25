package plugin

import (
	"fmt"
	"strings"
	"testing"
)

// The bundled Old Maid game (plugins/bundled/hq-card-pouilleux) through the real host, registered with the
// card table (hq-cards) in either start order. Helpers are in cards_test.go.

const oldMaid = "hq-card-pouilleux"

// listsOldMaid tells whether a "games" message about (x, y) sent to the member after their from-th message
// lists Old Maid; and whether the last such message does.
func listsOldMaid(sink *fakeSink, id uint32, x, y, from int) bool {
	data := sink.data(id)
	if from > len(data) {
		return false
	}
	found := false
	for _, d := range data[from:] {
		if d["t"] != "games" || d["x"] != float64(x) || d["y"] != float64(y) {
			continue
		}
		found = false
		for _, g := range d["list"].([]any) {
			m := g.(map[string]any)
			if m["name"] == oldMaid && m["title"] == "Old Maid" {
				found = true
			}
		}
	}
	return found
}

// stateSince is the table and state of the last open or state message about (x, y) after the from-th one.
func stateSince(sink *fakeSink, id uint32, x, y, from int) (map[string]any, map[string]any) {
	data := sink.data(id)
	if from > len(data) {
		return nil, nil
	}
	var last map[string]any
	for _, d := range data[from:] {
		if (d["t"] == "open" || d["t"] == "state") && d["x"] == float64(x) && d["y"] == float64(y) {
			last = d["s"].(map[string]any)
		}
	}
	if last == nil {
		return nil, nil
	}
	return last["t"].(map[string]any), last
}

// oldMaidTable opens the deck at (x, y) for each player, waits for Old Maid in the list, chooses it and
// seats the players in order.
func oldMaidTable(t *testing.T, h *Host, sink *fakeSink, x, y int, players ...Player) {
	t.Helper()
	from := len(sink.data(players[0].ID))
	for _, p := range players {
		h.Use(p, cards, "deck", x, y)
	}
	eventually(t, "Old Maid in the list", func() bool { return listsOldMaid(sink, players[0].ID, x, y, from) })
	cardSend(h, players[0], `{"t":"choose","x":%d,"y":%d,"game":"%s"}`, x, y, oldMaid)
	for i, p := range players {
		waitTable(t, sink, p.ID, x, y, p.Name+" sees Old Maid", func(tb, _ map[string]any) bool { return tb["game"] == oldMaid })
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

func TestOldMaidRegisters(t *testing.T) {
	for _, order := range [][]string{{cards, oldMaid}, {oldMaid, cards}} {
		t.Run(strings.Join(order, " then "), func(t *testing.T) {
			h, sink, errs := cardsHost(t, newMemKV(), order, alice, bob)
			h.Use(alice, cards, "deck", 1, 2)
			eventually(t, "Old Maid listed", func() bool { return listsOldMaid(sink, alice.ID, 1, 2, 0) })

			// the table restarted: its games are gone with it until Old Maid registers again
			h.Stop(cards)
			if err := h.Start(cards); err != nil {
				t.Fatal(err)
			}
			from := len(sink.data(alice.ID))
			h.Use(alice, cards, "deck", 1, 2)
			eventually(t, "Old Maid listed after hq-cards restarted", func() bool { return listsOldMaid(sink, alice.ID, 1, 2, from) })

			// a game in progress while Old Maid is off: unavailable, only reset acts; back intact when it returns
			oldMaidTable(t, h, sink, 3, 4, alice, bob)
			cardSend(h, alice, `{"t":"dealAll","x":3,"y":4,"pile":"p0"}`)
			dealt := waitTable(t, sink, alice.ID, 3, 4, "the deal", func(tb, _ map[string]any) bool { return handSizes(tb)[0] > 0 })
			hands := fmt.Sprint(dealt["hands"])
			h.Stop(oldMaid)
			waitTable(t, sink, alice.ID, 3, 4, "the table unavailable", func(_, s map[string]any) bool { return s["unavailable"] == true })
			for _, msg := range []string{`{"t":"place","x":3,"y":4,"from":{"k":"hand","i":0},"to":{"k":"pile","id":"p1"},"up":true}`, `{"t":"offer","x":3,"y":4,"to":1}`, `{"t":"gather","x":3,"y":4}`} {
				from := len(sink.data(alice.ID))
				h.Message(alice, cards, []byte(msg))
				var tb, s map[string]any
				eventually(t, "the state again after "+msg, func() bool { tb, s = stateSince(sink, alice.ID, 3, 4, from); return tb != nil })
				if fmt.Sprint(tb["hands"]) != hands || tb["offer"] != nil || s["unavailable"] != true {
					t.Fatalf("%s acted on an unavailable table: hands %v, offer %v", msg, tb["hands"], tb["offer"])
				}
			}
			if err := h.Start(oldMaid); err != nil {
				t.Fatal(err)
			}
			back := waitTable(t, sink, alice.ID, 3, 4, "the table available again", func(_, s map[string]any) bool { return s["unavailable"] == false })
			if fmt.Sprint(back["hands"]) != hands || back["game"] != oldMaid {
				t.Fatalf("the table comes back intact: game %v, hands %v, was %s", back["game"], back["hands"], hands)
			}
			// the same place now acts, so the refusals above were not about its shape
			cardSend(h, alice, `{"t":"place","x":3,"y":4,"from":{"k":"hand","i":0},"to":{"k":"pile","id":"p1"},"up":true}`)
			waitTable(t, sink, alice.ID, 3, 4, "a card on Pairs", func(tb, _ map[string]any) bool {
				return len(tb["piles"].([]any)[1].(map[string]any)["cards"].([]any)) == 1
			})

			// reset still works on an unavailable table, for a present seated player
			h.Stop(oldMaid)
			waitTable(t, sink, alice.ID, 3, 4, "unavailable again", func(_, s map[string]any) bool { return s["unavailable"] == true })
			cardSend(h, bob, `{"t":"reset","x":3,"y":4}`)
			waitTable(t, sink, alice.ID, 3, 4, "the table reset", func(tb, s map[string]any) bool { return tb["game"] == nil && s["unavailable"] == false })
			if n := errs.n.Load(); n != 0 {
				t.Fatalf("%d plugin errors", n)
			}
		})
	}
}

func TestOldMaidGame(t *testing.T) {
	h, sink, errs := cardsHost(t, newMemKV(), []string{cards, oldMaid}, alice, bob, carol)
	oldMaidTable(t, h, sink, 5, 6, alice, bob, carol)
	if g := lastOf(sink, alice.ID, "game", 5, 6); g == nil || g["g"].(map[string]any)["title"] != "Old Maid" ||
		len(g["g"].(map[string]any)["deck"].(map[string]any)["standard"].([]any)) != 49 {
		t.Fatalf("the page is told Old Maid and its 49 cards: %v", g)
	}

	// actions Old Maid leaves out change nothing
	tb, _ := tableOf(sink, alice.ID, 5, 6)
	before := fmt.Sprint(tb)
	for _, msg := range []string{`{"t":"draw","x":5,"y":6,"pile":"p0"}`, `{"t":"newPile","x":5,"y":6,"name":"Mine","face":"up","at":[20,20]}`, `{"t":"deal","x":5,"y":6,"pile":"p0","n":1}`} {
		from := len(sink.data(alice.ID))
		h.Message(alice, cards, []byte(msg))
		var now map[string]any
		eventually(t, "the state again after "+msg, func() bool { now, _ = stateSince(sink, alice.ID, 5, 6, from); return now != nil })
		if fmt.Sprint(now) != before {
			t.Fatalf("%s changed the table:\n%v\nwas\n%v", msg, now, before)
		}
	}

	// Alice deals from seat 0. hq-cards deals one card at a time round the seated players starting after the
	// dealer (seats 1, 2, then 0): 16 full rounds give 48 cards, the 49th goes to seat 1. Seats 3 to 5 of the
	// six are empty.
	cardSend(h, alice, `{"t":"dealAll","x":5,"y":6,"pile":"p0"}`)
	tb = waitTable(t, sink, alice.ID, 5, 6, "the deal", func(tb, _ map[string]any) bool { return handSizes(tb)[1] > 0 })
	if s := fmt.Sprint(handSizes(tb)); s != "[16 17 16 0 0 0]" {
		t.Fatalf("hands after dealing all: %s", s)
	}

	cardSend(h, bob, `{"t":"count","x":5,"y":6}`)
	tb = waitTable(t, sink, carol.ID, 5, 6, "the count", func(tb, _ map[string]any) bool { return tb["count"] != "" })
	if tb["count"] != "49 cards left: Alice 16, Bob 17, Carol 16" {
		t.Fatalf("the count comes from Old Maid's hook: %q", tb["count"])
	}
	eventually(t, "the count logged", func() bool { return has(logVerbs(sink, carol.ID, 5, 6), "counted") })

	if n := errs.n.Load(); n != 0 {
		t.Fatalf("%d plugin errors", n)
	}
}
