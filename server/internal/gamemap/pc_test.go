package gamemap

import "testing"

// A 2-wide desk at (2,2) and a 4-wide one at (2,5) on an open map, plus the prop under test.
func pcMap(p Prop) *Map {
	return openMap(Prop{T: "desk", X: 2, Y: 2}, Prop{T: "desk", X: 2, Y: 5, W: 4, H: 1}, p)
}

func TestValidatePC(t *testing.T) {
	cases := []struct {
		name string
		p    Prop
		ok   bool
	}{
		{"on a desk, centred", Prop{T: PropPC, X: 2, Y: 2, DX: 8}, true},
		{"on the desk's right tile", Prop{T: PropPC, X: 3, Y: 2}, true},
		{"on a wide desk", Prop{T: PropPC, X: 5, Y: 5}, true},
		{"on the floor", Prop{T: PropPC, X: 2, Y: 3}, false},
		{"offset at the limit", Prop{T: PropPC, X: 2, Y: 2, DX: -15, DY: 15}, true},
		{"dx too far", Prop{T: PropPC, X: 2, Y: 2, DX: 16}, false},
		{"dy too far", Prop{T: PropPC, X: 2, Y: 2, DY: -16}, false},
		{"offset on a chair", Prop{T: "chair", X: 6, Y: 6, DX: 1}, false},
		{"offset on a plugin object", Prop{T: "hq-chess/chessboard", X: 6, Y: 6, W: 1, H: 1, DY: 1}, false},
		{"label", Prop{T: PropPC, X: 2, Y: 2, Label: "Mine"}, false},
		{"turned", Prop{T: PropPC, X: 2, Y: 2, Up: true}, false},
		{"sized", Prop{T: PropPC, X: 2, Y: 2, W: 2}, false},
		{"assigned", Prop{T: PropPC, X: 2, Y: 2, Assign: 3}, false},
		{"data", Prop{T: PropPC, X: 2, Y: 2, Data: "x"}, false},
		{"destination", Prop{T: PropPC, X: 2, Y: 2, To: &Point{}}, false},
	}
	for _, c := range cases {
		err := Validate(pcMap(c.p))
		if (err == nil) != c.ok {
			t.Errorf("%s: Validate = %v, want ok=%v", c.name, err, c.ok)
		}
	}
}

func TestPCOnCentresOnTheDesk(t *testing.T) {
	cases := []struct {
		desk Prop
		want Prop
	}{
		{Prop{T: "desk", X: 4, Y: 7}, Prop{T: PropPC, X: 4, Y: 7, DX: 8}},
		{Prop{T: "desk", X: 4, Y: 7, W: 3, H: 1}, Prop{T: PropPC, X: 5, Y: 7}},
		{Prop{T: "desk", X: 0, Y: 1, W: 4, H: 1}, Prop{T: PropPC, X: 1, Y: 1, DX: 8}},
		{Prop{T: "desk", X: 4, Y: 7, Up: true}, Prop{T: PropPC, X: 4, Y: 7, DX: 8}},
	}
	for _, c := range cases {
		if got := PCOn(c.desk); got != c.want {
			t.Errorf("PCOn(%+v) = %+v, want %+v", c.desk, got, c.want)
		}
	}
}

// A pc stands on desks only: a desk's tiles, nothing else.
func TestOnDesk(t *testing.T) {
	m := pcMap(Prop{T: "chair", X: 6, Y: 6})
	for _, c := range []struct {
		x, y int
		want bool
	}{{2, 2, true}, {3, 2, true}, {4, 2, false}, {5, 5, true}, {6, 6, false}, {2, 3, false}} {
		if got := OnDesk(m, c.x, c.y); got != c.want {
			t.Errorf("OnDesk(%d,%d) = %v, want %v", c.x, c.y, got, c.want)
		}
	}
}
