package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

// The bundled chess plugin (plugins/bundled/hq-chess) through the real host: its server code is what
// these tests drive, with Use (X next to a board) and Message (the page's code).

const chess = "hq-chess"
const startPos = "rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR"

var carol = Player{ID: 3, Name: "Carol", Role: "member"}

// errCounter counts the "plugin error" lines the host logs: every error a plugin's code throws.
type errCounter struct{ n atomic.Int64 }

func (c *errCounter) Enabled(context.Context, slog.Level) bool { return true }
func (c *errCounter) Handle(_ context.Context, r slog.Record) error {
	if r.Message == "plugin error" {
		c.n.Add(1)
	}
	return nil
}
func (c *errCounter) WithAttrs([]slog.Attr) slog.Handler { return c }
func (c *errCounter) WithGroup(string) slog.Handler      { return c }

func chessHost(t *testing.T, kv *memKV, online ...Player) (*Host, *fakeSink, *errCounter) {
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
	if err := h.Start(chess); err != nil {
		t.Fatal(err)
	}
	if st, msg := state(h, chess); st != "running" {
		t.Fatalf("hq-chess is %s: %s", st, msg)
	}
	return h, sink, errs
}

func send(h *Host, p Player, msg string) { h.Message(p, chess, []byte(msg)) }

// boardOf is the last open or state message a member got for the board at (x, y), and how many they got.
func boardOf(sink *fakeSink, id uint32, x, y int) (map[string]any, int) {
	var last map[string]any
	n := 0
	for _, d := range sink.data(id) {
		if (d["t"] == "open" || d["t"] == "state") && d["x"] == float64(x) && d["y"] == float64(y) {
			last, n = d["s"].(map[string]any), n+1
		}
	}
	return last, n
}

// waitBoard waits for a member's view of a board to satisfy ok.
func waitBoard(t *testing.T, sink *fakeSink, id uint32, x, y int, what string, ok func(s map[string]any) bool) map[string]any {
	t.Helper()
	var s map[string]any
	eventually(t, what, func() bool {
		s, _ = boardOf(sink, id, x, y)
		return s != nil && ok(s)
	})
	return s
}

// seat describes a seat of a state: "" when free, else "<name>" or "<name> (away)".
func seat(s map[string]any, side string) string {
	v, _ := s[side].(map[string]any)
	if v == nil {
		return ""
	}
	if v["here"] == true {
		return v["name"].(string)
	}
	return v["name"].(string) + " (away)"
}

// playingOf is the last playing list a member got, as "id:side" strings.
func playingOf(sink *fakeSink, id uint32) ([]string, bool) {
	var out []string
	seen := false
	for _, d := range sink.data(id) {
		if d["t"] != "playing" {
			continue
		}
		seen, out = true, []string{}
		for _, e := range d["list"].([]any) {
			m := e.(map[string]any)
			out = append(out, fmt.Sprintf("%v:%v", m["id"], m["side"]))
		}
	}
	return out, seen
}

func TestChessOpensOnUse(t *testing.T) {
	h, sink, errs := chessHost(t, newMemKV(), alice)
	h.Use(alice, chess, "chessboard", 5, 7)
	s := waitBoard(t, sink, alice.ID, 5, 7, "open", func(map[string]any) bool { return true })
	if s["p"] != startPos || s["w"] != nil || s["b"] != nil {
		t.Fatalf("a new board opens on the start position with both seats free: %v", s)
	}
	opened := false
	for _, d := range sink.data(alice.ID) {
		opened = opened || d["t"] == "open"
	}
	if !opened {
		t.Fatal("the first message is open")
	}
	if n := errs.n.Load(); n != 0 {
		t.Fatalf("%d errors", n)
	}
}

func TestChessSeatsMovesAndPresence(t *testing.T) {
	h, sink, errs := chessHost(t, newMemKV(), alice, bob, carol)
	for _, p := range []Player{alice, bob, carol} {
		h.Use(p, chess, "chessboard", 2, 3)
	}
	waitBoard(t, sink, carol.ID, 2, 3, "carol opens", func(map[string]any) bool { return true })
	send(h, alice, `{"t":"seat","x":2,"y":3,"side":"w"}`)
	send(h, bob, `{"t":"seat","x":2,"y":3,"side":"b"}`)
	send(h, alice, `{"t":"move","x":2,"y":3,"from":52,"to":36}`)
	for _, id := range []uint32{alice.ID, bob.ID, carol.ID} {
		s := waitBoard(t, sink, id, 2, 3, "e2-e4 seen by everybody", func(s map[string]any) bool { return s["p"].(string)[36] == 'P' })
		if seat(s, "w") != "Alice" || seat(s, "b") != "Bob" || s["p"].(string)[52] != '.' {
			t.Fatalf("member %d sees %v", id, s)
		}
	}
	// refused: a seated player changing side, a taken seat, black pieces moved by White, a spectator moving
	send(h, alice, `{"t":"seat","x":2,"y":3,"side":"b"}`)
	send(h, carol, `{"t":"seat","x":2,"y":3,"side":"w"}`)
	send(h, alice, `{"t":"move","x":2,"y":3,"from":12,"to":28}`)
	send(h, carol, `{"t":"move","x":2,"y":3,"from":51,"to":35}`)
	send(h, bob, `{"t":"close","x":2,"y":3}`)
	s := waitBoard(t, sink, alice.ID, 2, 3, "Bob away", func(s map[string]any) bool { return seat(s, "b") == "Bob (away)" })
	if seat(s, "w") != "Alice" || s["p"].(string)[28] != '.' || s["p"].(string)[35] != '.' || s["p"].(string)[12] != 'p' {
		t.Fatalf("refused messages changed the board: %v", s)
	}
	send(h, carol, `{"t":"reset","x":2,"y":3}`) // Alice is still here: refused
	send(h, alice, `{"t":"close","x":2,"y":3}`)
	s = waitBoard(t, sink, carol.ID, 2, 3, "both away", func(s map[string]any) bool {
		return seat(s, "w") == "Alice (away)" && seat(s, "b") == "Bob (away)"
	})
	if s["p"].(string)[36] != 'P' {
		t.Fatalf("Carol's reset while Alice was here must be refused: %v", s)
	}
	send(h, carol, `{"t":"reset","x":2,"y":3}`) // nobody seated is here: allowed
	s = waitBoard(t, sink, carol.ID, 2, 3, "reset", func(s map[string]any) bool { return s["w"] == nil })
	if s["p"] != startPos || s["b"] != nil {
		t.Fatalf("a reset puts the start position back and frees both seats: %v", s)
	}
	send(h, carol, `{"t":"seat","x":2,"y":3,"side":"w"}`)
	waitBoard(t, sink, carol.ID, 2, 3, "anyone may sit after a reset", func(s map[string]any) bool { return seat(s, "w") == "Carol" })
	if n := errs.n.Load(); n != 0 {
		t.Fatalf("%d errors", n)
	}
}

func TestChessPresentSeatedPlayerResets(t *testing.T) {
	h, sink, _ := chessHost(t, newMemKV(), alice, bob)
	h.Use(alice, chess, "chessboard", 1, 1)
	h.Use(bob, chess, "chessboard", 1, 1)
	send(h, alice, `{"t":"seat","x":1,"y":1,"side":"w"}`)
	send(h, bob, `{"t":"seat","x":1,"y":1,"side":"b"}`)
	send(h, bob, `{"t":"move","x":1,"y":1,"from":12,"to":28}`)
	waitBoard(t, sink, alice.ID, 1, 1, "black moved", func(s map[string]any) bool { return s["p"].(string)[28] == 'p' })
	send(h, bob, `{"t":"reset","x":1,"y":1}`)
	waitBoard(t, sink, alice.ID, 1, 1, "Bob, seated and here, resets", func(s map[string]any) bool {
		return s["p"] == startPos && s["w"] == nil && s["b"] == nil
	})
}

func TestChessHelloMakesAbsent(t *testing.T) {
	h, sink, _ := chessHost(t, newMemKV(), alice, bob)
	for _, xy := range [][2]int{{1, 1}, {4, 4}} {
		h.Use(alice, chess, "chessboard", xy[0], xy[1])
		h.Use(bob, chess, "chessboard", xy[0], xy[1])
	}
	send(h, alice, `{"t":"seat","x":1,"y":1,"side":"w"}`)
	send(h, alice, `{"t":"seat","x":4,"y":4,"side":"b"}`)
	waitBoard(t, sink, bob.ID, 4, 4, "seated", func(s map[string]any) bool { return seat(s, "b") == "Alice" })
	send(h, alice, `{"t":"hello"}`) // her page reloaded: no window of hers is open
	waitBoard(t, sink, bob.ID, 1, 1, "away on the first board", func(s map[string]any) bool { return seat(s, "w") == "Alice (away)" })
	waitBoard(t, sink, bob.ID, 4, 4, "away on the second", func(s map[string]any) bool { return seat(s, "b") == "Alice (away)" })
	_, before := boardOf(sink, alice.ID, 1, 1)
	send(h, alice, `{"t":"move","x":1,"y":1,"from":52,"to":36}`) // not a viewer any more: ignored
	time.Sleep(300 * time.Millisecond)
	if s, n := boardOf(sink, bob.ID, 1, 1); s["p"] != startPos {
		t.Fatalf("a member who is not a viewer cannot move: %v (%d)", s, n)
	}
	if _, n := boardOf(sink, alice.ID, 1, 1); n != before {
		t.Fatal("a member who closed the board gets no more states of it")
	}
	h.Use(alice, chess, "chessboard", 1, 1)
	waitBoard(t, sink, bob.ID, 1, 1, "back in her seat", func(s map[string]any) bool { return seat(s, "w") == "Alice" })
	h.Presence(alice, false) // leaving the office makes her absent too
	waitBoard(t, sink, bob.ID, 1, 1, "away after leaving", func(s map[string]any) bool { return seat(s, "w") == "Alice (away)" })
}

// A page whose plugin starts after its member pressed X says hello after the board opened. The window it
// then draws counts: the page confirms it ("opened") and the member is a viewer again. A confirmation that
// no open is waiting for (never opened, or closed since) changes nothing.
func TestChessLateHelloKeepsTheWindowOpen(t *testing.T) {
	h, sink, _ := chessHost(t, newMemKV(), alice, bob)
	h.Use(bob, chess, "chessboard", 1, 1)
	h.Use(alice, chess, "chessboard", 1, 1)
	send(h, alice, `{"t":"seat","x":1,"y":1,"side":"w"}`)
	waitBoard(t, sink, bob.ID, 1, 1, "seated", func(s map[string]any) bool { return seat(s, "w") == "Alice" })
	send(h, alice, `{"t":"hello"}`) // her plugin started after the open was sent
	waitBoard(t, sink, bob.ID, 1, 1, "away for a moment", func(s map[string]any) bool { return seat(s, "w") == "Alice (away)" })
	send(h, alice, `{"t":"opened","x":1,"y":1}`) // her page drew the window
	waitBoard(t, sink, bob.ID, 1, 1, "here again", func(s map[string]any) bool { return seat(s, "w") == "Alice" })
	send(h, alice, `{"t":"move","x":1,"y":1,"from":52,"to":36}`)
	waitBoard(t, sink, bob.ID, 1, 1, "she plays", func(s map[string]any) bool { return s["p"] != startPos })

	// closed: a confirmation afterwards does not reopen it; nor does one for a board never opened
	send(h, alice, `{"t":"close","x":1,"y":1}`)
	waitBoard(t, sink, bob.ID, 1, 1, "away after closing", func(s map[string]any) bool { return seat(s, "w") == "Alice (away)" })
	send(h, alice, `{"t":"opened","x":1,"y":1}`)
	send(h, alice, `{"t":"opened","x":2,"y":2}`)
	time.Sleep(300 * time.Millisecond)
	if s, _ := boardOf(sink, bob.ID, 1, 1); seat(s, "w") != "Alice (away)" {
		t.Fatalf("an unexpected confirmation reopened the window: %v", s)
	}
	if _, n := boardOf(sink, alice.ID, 2, 2); n != 0 {
		t.Fatal("a confirmation for a board never opened sent its state")
	}
}

func TestChessSurvivesRestart(t *testing.T) {
	kv := newMemKV()
	h, sink, _ := chessHost(t, kv, alice, bob)
	h.Use(alice, chess, "chessboard", 6, 2)
	h.Use(bob, chess, "chessboard", 6, 2)
	send(h, alice, `{"t":"seat","x":6,"y":2,"side":"w"}`)
	send(h, bob, `{"t":"seat","x":6,"y":2,"side":"b"}`)
	send(h, alice, `{"t":"move","x":6,"y":2,"from":52,"to":36}`)
	waitBoard(t, sink, bob.ID, 6, 2, "moved", func(s map[string]any) bool { return s["p"].(string)[36] == 'P' && seat(s, "b") == "Bob" })
	h.Close()

	h2, sink2, _ := chessHost(t, kv, carol)
	h2.Use(carol, chess, "chessboard", 6, 2)
	s := waitBoard(t, sink2, carol.ID, 6, 2, "reopened", func(map[string]any) bool { return true })
	if s["p"].(string)[36] != 'P' || seat(s, "w") != "Alice (away)" || seat(s, "b") != "Bob (away)" {
		t.Fatalf("position and seats kept across a restart, nobody present: %v", s)
	}
}

func TestChessMovesApplyInOrder(t *testing.T) {
	h, sink, _ := chessHost(t, newMemKV(), alice)
	h.Use(alice, chess, "chessboard", 0, 0)
	send(h, alice, `{"t":"seat","x":0,"y":0,"side":"w"}`)
	for _, m := range [][2]int{{52, 44}, {44, 36}, {36, 28}, {28, 20}, {62, 45}, {45, 30}} {
		send(h, alice, fmt.Sprintf(`{"t":"move","x":0,"y":0,"from":%d,"to":%d}`, m[0], m[1]))
	}
	s := waitBoard(t, sink, alice.ID, 0, 0, "moves", func(s map[string]any) bool { return s["p"].(string)[30] == 'N' })
	p := s["p"].(string)
	if p[20] != 'P' || p[52] != '.' || p[44] != '.' || p[36] != '.' || p[28] != '.' || p[62] != '.' || p[45] != '.' {
		t.Fatalf("each move applies to the position the previous one left: %s", p)
	}
}

// A refused move leaves the mover's view showing it (optimistic): they are sent the server's state again.
func TestChessRefusedMoveResendsState(t *testing.T) {
	h, sink, _ := chessHost(t, newMemKV(), alice, bob)
	h.Use(alice, chess, "chessboard", 2, 2)
	h.Use(bob, chess, "chessboard", 2, 2)
	send(h, alice, `{"t":"seat","x":2,"y":2,"side":"w"}`)
	waitBoard(t, sink, alice.ID, 2, 2, "seated", func(s map[string]any) bool { return seat(s, "w") == "Alice" })
	time.Sleep(200 * time.Millisecond)
	_, before := boardOf(sink, alice.ID, 2, 2)
	_, bobBefore := boardOf(sink, bob.ID, 2, 2)
	send(h, alice, `{"t":"move","x":2,"y":2,"from":12,"to":28}`) // a black pawn: refused
	eventually(t, "a fresh state for the mover", func() bool { _, n := boardOf(sink, alice.ID, 2, 2); return n > before })
	if s, _ := boardOf(sink, alice.ID, 2, 2); s["p"] != startPos {
		t.Fatalf("the board did not change: %v", s)
	}
	time.Sleep(200 * time.Millisecond)
	if _, n := boardOf(sink, bob.ID, 2, 2); n != bobBefore {
		t.Fatal("only the mover is sent the state again")
	}
}

func TestChessBoardKeyIsItsTile(t *testing.T) {
	kv := newMemKV()
	h, sink, _ := chessHost(t, kv, alice)
	h.Use(alice, chess, "chessboard", 3, 4)
	waitBoard(t, sink, alice.ID, 3, 4, "open", func(map[string]any) bool { return true })
	if got, _ := kv.Load(chess); len(got) != 0 {
		t.Fatalf("opening a board writes nothing: %v", got)
	}
	send(h, alice, `{"t":"seat","x":3,"y":4,"side":"b"}`)
	var stored map[string]any
	eventually(t, "stored", func() bool {
		got, _ := kv.Load(chess)
		v, ok := got["board:3,4"]
		return ok && json.Unmarshal([]byte(v), &stored) == nil
	})
	if stored["p"] != startPos || stored["w"] != nil {
		t.Fatalf("stored: %v", stored)
	}
	if b := stored["b"].(map[string]any); b["id"] != 1.0 || b["name"] != "Alice" || len(b) != 2 {
		t.Fatalf("a seat is stored as {id, name}: %v", b)
	}
}

func TestChessIgnoresMalformed(t *testing.T) {
	h, sink, errs := chessHost(t, newMemKV(), alice)
	h.Use(alice, chess, "chessboard", 1, 2)
	send(h, alice, `{"t":"seat","x":1,"y":2,"side":"w"}`)
	waitBoard(t, sink, alice.ID, 1, 2, "seated", func(s map[string]any) bool { return seat(s, "w") == "Alice" })
	for _, m := range []string{
		`null`, `7`, `"move"`, `[]`, `{}`, `{"t":"nope"}`, `{"t":"move"}`,
		`{"t":"move","x":"1","y":2,"from":52,"to":36}`,
		`{"t":"move","x":1,"y":2,"from":"52","to":36}`,
		`{"t":"move","x":1,"y":2,"from":52.5,"to":36}`,
		`{"t":"move","x":1,"y":2,"from":52,"to":64}`,
		`{"t":"move","x":1,"y":2,"from":-1,"to":36}`,
		`{"t":"move","x":1,"y":2,"from":52,"to":52}`,
		`{"t":"move","x":9,"y":9,"from":52,"to":36}`,
		`{"t":"seat","x":1,"y":2,"side":"x"}`,
		`{"t":"seat","x":1,"y":2}`,
		`{"t":"seat","x":8,"y":8,"side":"b"}`,
		`{"t":"reset","x":8,"y":8}`,
		`{"t":"close","x":8,"y":8}`,
		`{"t":"close","x":null,"y":2}`,
		`{"t":"reset","x":{},"y":2}`,
		`{"t":"seat","x":1,"y":2,"side":"b"}`, // already seated
	} {
		send(h, alice, m)
	}
	send(h, alice, `{"t":"move","x":1,"y":2,"from":51,"to":35}`) // a valid one after them
	s := waitBoard(t, sink, alice.ID, 1, 2, "valid move", func(s map[string]any) bool { return s["p"].(string)[35] == 'P' })
	if s["p"].(string)[36] != '.' {
		t.Fatalf("a malformed move applied: %v", s["p"])
	}
	if _, n := boardOf(sink, alice.ID, 8, 8); n != 0 {
		t.Fatal("a board never opened got no state")
	}
	if n := errs.n.Load(); n != 0 {
		t.Fatalf("malformed messages are ignored, not errors: %d", n)
	}
	if st, msg := state(h, chess); st != "running" {
		t.Fatalf("hq-chess is %s: %s", st, msg)
	}
}

func TestChessPlayingList(t *testing.T) {
	h, sink, _ := chessHost(t, newMemKV(), alice, bob)
	h.Use(alice, chess, "chessboard", 1, 1)
	h.Use(bob, chess, "chessboard", 1, 1)
	send(h, alice, `{"t":"seat","x":1,"y":1,"side":"w"}`)
	send(h, bob, `{"t":"seat","x":1,"y":1,"side":"b"}`)
	want := func(what string, list ...string) {
		t.Helper()
		eventually(t, what, func() bool {
			got, seen := playingOf(sink, alice.ID)
			return seen && fmt.Sprint(got) == fmt.Sprint(list)
		})
	}
	want("both listed", "1:w", "2:b")
	send(h, bob, `{"t":"close","x":1,"y":1}`)
	want("Bob closed his window", "1:w")
	h.Presence(carol, true)
	eventually(t, "a joining member gets the list", func() bool {
		got, seen := playingOf(sink, carol.ID)
		return seen && fmt.Sprint(got) == "[1:w]"
	})
	send(h, alice, `{"t":"reset","x":1,"y":1}`)
	want("a reset frees both seats")
}

// The playing list goes to each member on its own: a member whose send budget is spent does not hold it
// back from the others, and gets it once the budget allows.
func TestChessPlayingListPerMember(t *testing.T) {
	h, sink, _ := chessHost(t, newMemKV(), alice, bob, carol)
	h.Use(alice, chess, "chessboard", 1, 1)
	h.Use(bob, chess, "chessboard", 1, 1)
	send(h, alice, `{"t":"seat","x":1,"y":1,"side":"w"}`)
	send(h, bob, `{"t":"seat","x":1,"y":1,"side":"b"}`)
	listIs := func(id uint32, want string) func() bool {
		return func() bool { got, seen := playingOf(sink, id); return seen && fmt.Sprint(got) == want }
	}
	eventually(t, "Carol sees both players", listIs(carol.ID, "[1:w 2:b]"))
	// Bob's budget kept spent (as a page flooded by messages would): every token he gets is taken
	for h.spend([]uint32{bob.ID}) {
	}
	stop := make(chan struct{})
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		for {
			select {
			case <-stop:
				return
			default:
				h.spend([]uint32{bob.ID})
				runtime.Gosched()
			}
		}
	}()
	send(h, alice, `{"t":"close","x":1,"y":1}`)
	eventually(t, "Carol gets the new list while Bob's budget is spent", listIs(carol.ID, "[2:b]"))
	close(stop)
	<-drained
	eventually(t, "Bob gets it once his budget allows", listIs(bob.ID, "[2:b]"))
}

// The reserve of captured pieces and promotion, through the real plugin: place, stash and move with promote.
func TestChessReserveAndPromotion(t *testing.T) {
	kv := newMemKV()
	h, sink, errs := chessHost(t, kv, alice, bob)
	h.Use(alice, chess, "chessboard", 3, 3)
	h.Use(bob, chess, "chessboard", 3, 3)
	send(h, alice, `{"t":"seat","x":3,"y":3,"side":"w"}`)
	send(h, bob, `{"t":"seat","x":3,"y":3,"side":"b"}`)
	s := waitBoard(t, sink, bob.ID, 3, 3, "seated, empty reserve", func(s map[string]any) bool { return seat(s, "b") == "Bob" })
	if s["r"] != "" {
		t.Fatalf("a new board's reserve is empty: %v", s)
	}
	send(h, alice, `{"t":"move","x":3,"y":3,"from":52,"to":12}`) // e2 takes e7
	waitBoard(t, sink, bob.ID, 3, 3, "the black pawn in the reserve", func(s map[string]any) bool { return s["r"] == "p" })
	send(h, bob, `{"t":"place","x":3,"y":3,"piece":"p","to":20}`)   // the pawn back on e6
	send(h, alice, `{"t":"place","x":3,"y":3,"piece":"p","to":21}`) // refused: not White's piece
	send(h, alice, `{"t":"stash","x":3,"y":3,"from":62}`)           // the g1 knight off the board
	send(h, alice, `{"t":"stash","x":3,"y":3,"from":1}`)            // refused: a black knight
	s = waitBoard(t, sink, bob.ID, 3, 3, "placed and stashed", func(s map[string]any) bool { return s["r"] == "N" })
	if p := s["p"].(string); p[20] != 'p' || p[21] != '.' || p[62] != '.' || p[1] != 'n' {
		t.Fatalf("place and stash: %v", s)
	}
	send(h, alice, `{"t":"move","x":3,"y":3,"from":12,"to":5,"promote":"k"}`) // refused: not a choice
	send(h, alice, `{"t":"move","x":3,"y":3,"from":12,"to":5,"promote":"q"}`) // e7 takes f8 and is a queen
	s = waitBoard(t, sink, bob.ID, 3, 3, "promoted", func(s map[string]any) bool { return s["r"] == "Nb" })
	if p := s["p"].(string); p[5] != 'Q' || p[12] != '.' || p[59] != 'Q' {
		t.Fatalf("promotion makes a second queen: %v", s)
	}
	send(h, alice, `{"t":"place","x":3,"y":3,"piece":"N","to":4}`) // on the black king: it goes to the reserve
	waitBoard(t, sink, bob.ID, 3, 3, "the king in the reserve", func(s map[string]any) bool { return s["r"] == "bk" })
	h.Close()

	h2, sink2, _ := chessHost(t, kv, carol)
	h2.Use(carol, chess, "chessboard", 3, 3)
	s = waitBoard(t, sink2, carol.ID, 3, 3, "reopened", func(map[string]any) bool { return true })
	if s["r"] != "bk" || s["p"].(string)[4] != 'N' {
		t.Fatalf("the reserve survives a restart: %v", s)
	}
	if n := errs.n.Load(); n != 0 {
		t.Fatalf("%d errors", n)
	}
}

func TestChessResetEmptiesTheReserve(t *testing.T) {
	kv := newMemKV()
	h, sink, _ := chessHost(t, kv, alice)
	h.Use(alice, chess, "chessboard", 1, 1)
	send(h, alice, `{"t":"seat","x":1,"y":1,"side":"w"}`)
	send(h, alice, `{"t":"stash","x":1,"y":1,"from":57}`)
	waitBoard(t, sink, alice.ID, 1, 1, "stashed", func(s map[string]any) bool { return s["r"] == "N" })
	send(h, alice, `{"t":"reset","x":1,"y":1}`)
	waitBoard(t, sink, alice.ID, 1, 1, "reset", func(s map[string]any) bool { return s["r"] == "" && s["w"] == nil })
	var stored map[string]any
	eventually(t, "stored", func() bool {
		got, _ := kv.Load(chess)
		return json.Unmarshal([]byte(got["board:1,1"]), &stored) == nil && stored["r"] == ""
	})
}

func TestChessIgnoresMalformedReserve(t *testing.T) {
	h, sink, errs := chessHost(t, newMemKV(), alice)
	h.Use(alice, chess, "chessboard", 1, 2)
	send(h, alice, `{"t":"seat","x":1,"y":2,"side":"w"}`)
	send(h, alice, `{"t":"stash","x":1,"y":2,"from":57}`)
	waitBoard(t, sink, alice.ID, 1, 2, "stashed", func(s map[string]any) bool { return s["r"] == "N" })
	for _, m := range []string{
		`{"t":"place","x":1,"y":2}`,
		`{"t":"place","x":1,"y":2,"piece":"N"}`,
		`{"t":"place","x":1,"y":2,"piece":7,"to":40}`,
		`{"t":"place","x":1,"y":2,"piece":"NN","to":40}`,
		`{"t":"place","x":1,"y":2,"piece":"N","to":64}`,
		`{"t":"place","x":1,"y":2,"piece":"N","to":"40"}`,
		`{"t":"stash","x":1,"y":2}`,
		`{"t":"stash","x":1,"y":2,"from":-1}`,
		`{"t":"stash","x":1,"y":2,"from":[]}`,
		`{"t":"move","x":1,"y":2,"from":52,"to":36,"promote":null}`,
		`{"t":"move","x":1,"y":2,"from":52,"to":36,"promote":1}`,
		`{"t":"move","x":1,"y":2,"from":52,"to":36,"promote":"q"}`,
	} {
		send(h, alice, m)
	}
	send(h, alice, `{"t":"place","x":1,"y":2,"piece":"N","to":42}`) // a valid one after them
	s := waitBoard(t, sink, alice.ID, 1, 2, "valid place", func(s map[string]any) bool { return s["p"].(string)[42] == 'N' })
	if s["r"] != "" || s["p"].(string)[52] != 'P' || s["p"].(string)[40] != '.' {
		t.Fatalf("a malformed message applied: %v", s)
	}
	if n := errs.n.Load(); n != 0 {
		t.Fatalf("malformed messages are ignored, not errors: %d", n)
	}
}
