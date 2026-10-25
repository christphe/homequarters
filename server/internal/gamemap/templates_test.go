package gamemap

import (
	"strconv"
	"strings"
	"testing"
)

// reach returns, for each tile, whether it can be walked to from the spawn.
func reach(cm *Compiled) []bool {
	m := cm.Map
	seen := make([]bool, m.W*m.H)
	q := [][2]int{{m.Spawn.X, m.Spawn.Y}}
	seen[m.Spawn.Y*m.W+m.Spawn.X] = true
	for len(q) > 0 {
		c := q[0]
		q = q[1:]
		for _, d := range [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
			x, y := c[0]+d[0], c[1]+d[1]
			if cm.IsSolidTile(x, y) || seen[y*m.W+x] {
				continue
			}
			seen[y*m.W+x] = true
			q = append(q, [2]int{x, y})
		}
	}
	return seen
}

// Every template compiles, every area can be walked into from the spawn and every desk's seat reached.
func TestTemplatesCompileAndEverythingIsReachable(t *testing.T) {
	for _, tp := range Templates {
		t.Run(tp.ID, func(t *testing.T) {
			cm, err := Compile(tp.Build())
			if err != nil {
				t.Fatal(err)
			}
			m := cm.Map
			seen := reach(cm)
			for _, a := range m.Areas {
				ok := false
				for y := a.Y; y < a.Y+a.H && !ok; y++ {
					for x := a.X; x < a.X+a.W && !ok; x++ {
						ok = seen[y*m.W+x]
					}
				}
				if !ok {
					t.Errorf("area %s cannot be reached from the spawn", a.ID)
				}
			}
			for _, p := range m.Props {
				if p.T != "desk" {
					continue
				}
				w, h := p.Size()
				seat := p.Y + h
				if p.Up {
					seat = p.Y - 1
				}
				if !seen[seat*m.W+p.X+w/2] {
					t.Errorf("the seat of %s (%d,%d) cannot be reached", p.Label, p.X, p.Y)
				}
			}
		})
	}
}

// The extension of the wide templates is walled up: no tile of it can be reached.
func TestWideTemplatesWallUpTheExtension(t *testing.T) {
	for _, build := range []func() *Map{Manor, Lodge} {
		cm, err := Compile(build())
		if err != nil {
			t.Fatal(err)
		}
		seen := reach(cm)
		for y := 18; y < 50; y++ {
			for x := 1; x < 19; x++ {
				if seen[y*cm.W+x] {
					t.Fatalf("extension tile %d,%d is reachable", x, y)
				}
			}
		}
	}
}

func count(m *Map, pred func(Prop) bool) int {
	n := 0
	for _, p := range m.Props {
		if pred(p) {
			n++
		}
	}
	return n
}

// The approved plans: sizes, desks, rooms, corners, tables.
func TestWideTemplatesMatchThePlans(t *testing.T) {
	for _, c := range []struct {
		name                         string
		build                        func() *Map
		w, desks, minis, miniW, duos int
	}{
		{"manor", Manor, 85, 48, 7, 8, 6},
		{"lodge", Lodge, 77, 36, 5, 10, 4},
	} {
		t.Run(c.name, func(t *testing.T) {
			m := c.build()
			if m.W != c.w || m.H != 51 {
				t.Fatalf("size %dx%d", m.W, m.H)
			}
			s := Summarize(m)
			if s.Desks != c.desks || s.Rooms != 3+c.minis || s.Corners != 2*c.duos || s.Offices != 0 {
				t.Fatalf("summary %+v", s)
			}
			if n := count(m, func(p Prop) bool { return p.T == "desk" && p.W == 3 && p.H == 1 }); n != c.desks {
				t.Errorf("%d desks are 3x1, want %d", n, c.desks)
			}
			for _, a := range m.Areas {
				in := func(p Prop) bool { return p.X >= a.X && p.Y >= a.Y && p.X < a.X+a.W && p.Y < a.Y+a.H }
				chairs := count(m, func(p Prop) bool { return p.T == "chair" && in(p) })
				switch {
				case strings.HasPrefix(a.ID, "meeting-"):
					if a.W != 10 || chairs != 12 || count(m, func(p Prop) bool { return p.T == "table" && p.W == 6 && p.H == 2 && in(p) }) != 1 {
						t.Errorf("%s: %dx%d, %d chairs", a.ID, a.W, a.H, chairs)
					}
				case strings.HasPrefix(a.ID, "mini-"):
					if a.W != c.miniW || chairs != 8 || count(m, func(p Prop) bool {
						return p.T == "table" && p.W == 4 && p.H == 2 && in(p) && p.X-a.X == a.X+a.W-(p.X+4)
					}) != 1 {
						t.Errorf("%s: %dx%d, %d chairs, table not centred", a.ID, a.W, a.H, chairs)
					}
				case strings.HasPrefix(a.ID, CornerPrefix+"duo-"):
					if a.W != 3 || a.H != 3 || count(m, func(p Prop) bool { return p.T == "armchair" && in(p) }) != 2 {
						t.Errorf("%s: %dx%d", a.ID, a.W, a.H)
					}
				case strings.HasPrefix(a.ID, CornerPrefix+"couch-"):
					if a.W != 4 || a.H != 4 || a.Y+a.H != 12 || count(m, func(p Prop) bool { return p.T == "couch" && in(p) }) != 4 {
						t.Errorf("%s: %dx%d at row %d, want 4 couches and a free row above the wall", a.ID, a.W, a.H, a.Y)
					}
				}
			}
			// the mini rooms' walls run exactly under the hall
			var hall Area
			for _, a := range m.Areas {
				if a.ID == "hall" {
					hall = a
				}
			}
			if hall.X != 20 || m.Walls[42][hall.X] != '#' || m.Walls[42][hall.X+hall.W-1] != '#' || 1+c.minis*(c.miniW+1) != hall.W {
				t.Errorf("minis do not span the hall (%d wide)", hall.W)
			}
		})
	}
}

// Corners are numbered from left to right, so "corner 2" is the second one along the room.
func TestCornersAreNumberedLeftToRight(t *testing.T) {
	for _, build := range []func() *Map{Manor, Lodge} {
		for _, kind := range []string{"duo-", "couch-"} {
			xs := map[int]int{} // corner number -> x
			for _, a := range build().Areas {
				if num, ok := strings.CutPrefix(a.ID, CornerPrefix+kind); ok {
					n, _ := strconv.Atoi(num)
					xs[n] = a.X
				}
			}
			for n := 2; n <= len(xs); n++ {
				if xs[n] <= xs[n-1] {
					t.Fatalf("%scorner %d (x=%d) is not right of corner %d (x=%d)", kind, n, xs[n], n-1, xs[n-1])
				}
			}
		}
	}
}

// Couches are seats: people walk onto them, as onto chairs.
func TestCouchesDoNotBlock(t *testing.T) {
	cm, err := Compile(Manor())
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, p := range cm.Map.Props {
		if p.T != "couch" {
			continue
		}
		n++
		w, h := p.Size()
		for y := p.Y; y < p.Y+h; y++ {
			for x := p.X; x < p.X+w; x++ {
				if cm.IsSolidTile(x, y) {
					t.Fatalf("couch tile %d,%d blocks", x, y)
				}
			}
		}
	}
	if n == 0 {
		t.Fatal("no couch to check")
	}
}

// Each island desk, once assigned, gets its 3x3 zone as desk room: above an Up desk, below the others.
func TestIslandDesksGetTheirZoneAsDeskRoom(t *testing.T) {
	m := Manor()
	for i := range m.Props {
		if m.Props[i].T == "desk" {
			m.Props[i].Assign = int64(i + 1)
		}
	}
	cm, err := Compile(m)
	if err != nil {
		t.Fatal(err)
	}
	rooms := 0
	for _, a := range cm.Map.Areas {
		if a.Auto {
			rooms++
			if a.W != 3 || a.H != 3 {
				t.Errorf("desk room %s is %dx%d", a.ID, a.W, a.H)
			}
		}
	}
	if rooms != 48 {
		t.Fatalf("%d desk rooms, want 48", rooms)
	}
	for _, p := range cm.Map.Props {
		if p.T == "chair" && cm.AreaIndexAt(p.X, p.Y) < 0 {
			t.Errorf("chair at %d,%d is in no area", p.X, p.Y)
		}
	}
}

func TestCarryDesks(t *testing.T) {
	// old: three free-standing desks (numbers 0..2) and one private office with two owners
	old := &Map{W: 20, H: 10,
		Props: []Prop{{T: "desk", X: 1, Y: 1, Assign: 7}, {T: "desk", X: 4, Y: 1}, {T: "desk", X: 7, Y: 1, Assign: 9}},
		Areas: []Area{{ID: "office-1", Kind: KindRoom, X: 10, Y: 0, W: 5, H: 5, Access: Access{Mode: AccessOffice, Users: []int64{11, 12}}}}}
	desks := func(n int) *Map {
		m := &Map{W: 40, H: 10}
		for i := 0; i < n; i++ {
			m.Props = append(m.Props, Prop{T: "desk", X: i * 3, Y: 5})
		}
		return m
	}
	owners := func(m *Map) []int64 {
		var out []int64
		for _, p := range m.Props {
			out = append(out, p.Assign)
		}
		return out
	}
	for _, c := range []struct {
		n    int
		want []int64
		kept int
		lost int
	}{
		{5, []int64{7, 11, 9, 12, 0}, 4, 0}, // same numbers kept, office owners fill the gaps in order
		{3, []int64{7, 11, 9}, 3, 1},        // one desk short: the last office owner loses
		{2, []int64{7, 9}, 2, 2},            // desk 2 does not exist: its owner takes the free one, office owners come last and go
		{0, nil, 0, 4},
	} {
		next := desks(c.n)
		got := CarryDesks(old, next)
		if g := owners(next); len(g) != len(c.want) || (len(g) > 0 && !equal(g, c.want)) {
			t.Errorf("%d desks: owners %v, want %v", c.n, g, c.want)
		}
		if got.Kept != c.kept || got.Lost != c.lost {
			t.Errorf("%d desks: %+v, want kept %d lost %d", c.n, got, c.kept, c.lost)
		}
	}
	// a desk inside a room of the next map (a private office's desk) is never handed out
	next := desks(2)
	next.Areas = []Area{{ID: "office-1", Kind: KindRoom, X: 0, Y: 4, W: 2, H: 3, Access: Access{Mode: AccessOffice}}}
	CarryDesks(old, next)
	if next.Props[0].Assign != 0 || next.Props[1].Assign != 7 {
		t.Errorf("office desk handed out: %v", owners(next))
	}
}

func equal(a, b []int64) bool {
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
