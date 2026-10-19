package world

import (
	"math/rand/v2"
	"strings"
	"testing"
	"time"

	"homequarters/internal/gamemap"
)

// BenchmarkTick measures one world tick (simulation, interest management and encoding of every
// client's frame) with n connected players, a third of them changing direction every tick:
// far busier than people really are, so it shows the cost of the hot path, not a capacity.
// Concentrated puts everybody in the 17x13-tile reception, the worst case for fan-out.
func BenchmarkTick(b *testing.B) {
	for _, c := range []struct {
		name         string
		n            int
		x0, y0, w, h int
	}{
		{"300-concentrated", 300, 2, 1, 17, 13},
		{"300-distributed", 300, 1, 1, 70, 40},
	} {
		b.Run(c.name, func(b *testing.B) {
			h := newHarness(b)
			rng := rand.New(rand.NewPCG(1, 2))
			var ps []*Player
			for id := uint32(1); len(ps) < c.n; {
				tx, ty := c.x0+rng.IntN(c.w), c.y0+rng.IntN(c.h)
				if tx >= h.w.m.Map.W || ty >= h.w.m.Map.H || h.w.m.IsSolidTile(tx, ty) {
					continue
				}
				if ai := h.w.m.AreaIndexAt(tx, ty); ai >= 0 && !h.w.canEnterArea(&Player{Role: "member", area: -1}, ai) {
					continue
				}
				ps = append(ps, h.add(id, "member", float64(tx*gamemap.TilePx+8), float64(ty*gamemap.TilePx+8)))
				id++
			}
			step := time.Second / time.Duration(h.w.cfg.TickHz)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				for j := i % 3; j < len(ps); j += 3 {
					h.send(ps[j], ev{kind: evInput, seq: uint32(i), dx: int8(rng.IntN(3) - 1), dy: int8(rng.IntN(3) - 1)})
				}
				h.now = h.now.Add(step)
				h.w.tick(h.now)
				for _, p := range ps {
					for len(p.out) > 0 {
						<-p.out
					}
				}
			}
		})
	}
}

// TestZoomedOutTraffic measures what one observer receives over a minute of simulated time with
// 100 people spread over the default office, at the default radius and zoomed out (radius 8: the
// whole office). Movers change direction every 1.5 s on average. Run with -v to see the numbers;
// they are local simulation figures (no network), not a capacity claim.
func TestZoomedOutTraffic(t *testing.T) {
	for _, c := range []struct {
		name   string
		moving float64 // share of people walking at any time
		radius int
	}{
		{"all-walking/r2", 1, 2}, {"all-walking/r8", 1, 8},
		{"quarter-walking/r2", 0.25, 2}, {"quarter-walking/r8", 0.25, 8},
	} {
		t.Run(c.name, func(t *testing.T) {
			bytes, recs := zoomedOutTraffic(t, c.moving, c.radius)
			t.Logf("%-20s %6.0f B/s %6.0f records/s", c.name, bytes, recs)
		})
	}
}

func zoomedOutTraffic(t *testing.T, moving float64, radius int) (bytesPerSec, recsPerSec float64) {
	h := newHarness(t)
	rng := rand.New(rand.NewPCG(7, 9))
	obs := h.add(1000, "member", 30*16+8, 24*16+8)
	h.w.handle(ev{kind: evView, p: obs, gen: obs.gen, x: radius}, h.now)
	var ps []*Player
	for id := uint32(1); len(ps) < 100; {
		tx, ty := 1+rng.IntN(h.w.m.Map.W-2), 1+rng.IntN(h.w.m.Map.H-2)
		if h.w.m.IsSolidTile(tx, ty) {
			continue
		}
		if ai := h.w.m.AreaIndexAt(tx, ty); ai >= 0 && !h.w.canEnterArea(&Player{Role: "member", area: -1}, ai) {
			continue
		}
		ps = append(ps, h.add(id, "member", float64(tx*gamemap.TilePx+8), float64(ty*gamemap.TilePx+8)))
		id++
	}
	step := time.Second / time.Duration(h.w.cfg.TickHz)
	seq := make([]uint32, len(ps))
	drainAll := func() (n, recs int) {
		for _, p := range append(ps, obs) {
			for len(p.out) > 0 {
				f := <-p.out
				if p == obs && strings.HasPrefix(string(f), `{"t":"w"`) {
					n += len(f)
					recs += strings.Count(string(f), "[") - strings.Count(string(f), `"m":[`) - strings.Count(string(f), `"l":[`)
				}
			}
		}
		return
	}
	turn := func(i int) {
		seq[i]++
		dx, dy := int8(0), int8(0)
		if rng.Float64() < moving {
			for dx == 0 && dy == 0 {
				dx, dy = int8(rng.IntN(3)-1), int8(rng.IntN(3)-1)
			}
		}
		h.send(ps[i], ev{kind: evInput, seq: seq[i], dx: dx, dy: dy})
	}
	for i := range ps {
		turn(i)
	}
	for i := 0; i < 5*h.w.cfg.TickHz; i++ { // settle: everybody entered the observer's view
		h.now = h.now.Add(step)
		h.w.tick(h.now)
		drainAll()
	}
	const secs = 60
	total, recs := 0, 0
	for i := 0; i < secs*h.w.cfg.TickHz; i++ {
		for j := range ps {
			if rng.Float64() < 1/(1.5*float64(h.w.cfg.TickHz)) {
				turn(j)
			}
		}
		h.now = h.now.Add(step)
		h.w.tick(h.now)
		n, r := drainAll()
		total += n
		recs += r
	}
	return float64(total) / secs, float64(recs) / secs
}

// BenchmarkFindPath measures one route from the social area into Focus: around Horizon, and through
// it when Focus's own door is walled up (the route must cross a room).
func BenchmarkFindPath(b *testing.B) {
	for _, c := range []struct {
		name       string
		closeFocus bool
	}{{"around-a-room", false}, {"through-a-room", true}} {
		b.Run(c.name, func(b *testing.B) {
			h := roomShortcutHarness(b, c.closeFocus)
			p := h.add(1, "member", 40*16+8, 20*16+8)
			from := tileOf(p.X, p.Y)
			b.ReportAllocs()
			for b.Loop() {
				if h.w.findPath(p, from, tile{50, 27}) == nil {
					b.Fatal("no route")
				}
			}
		})
	}
}
