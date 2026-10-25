package gamemap

import (
	"strings"
	"testing"
)

// openMap is an 8x8 map without walls or props.
func openMap(props ...Prop) *Map {
	walls := make([]string, 8)
	for i := range walls {
		walls[i] = strings.Repeat(".", 8)
	}
	return &Map{Version: 1, W: 8, H: 8, Walls: walls, Props: props, Spawn: Point{X: 0, Y: 0}}
}

func TestPluginPropValidates(t *testing.T) {
	cases := []struct {
		name string
		p    Prop
		ok   bool
	}{
		{"valid", Prop{T: "hq-chess/chessboard", X: 1, Y: 1, W: 1, H: 1}, true},
		{"largest", Prop{T: "hq-chess/chessboard", X: 4, Y: 4, W: 4, H: 4}, true},
		{"empty kind", Prop{T: "hq-chess/", X: 1, Y: 1, W: 1, H: 1}, false},
		{"empty plugin", Prop{T: "/chessboard", X: 1, Y: 1, W: 1, H: 1}, false},
		{"uppercase", Prop{T: "Hq/x", X: 1, Y: 1, W: 1, H: 1}, false},
		{"two slashes", Prop{T: "a/b/c", X: 1, Y: 1, W: 1, H: 1}, false},
		{"zero width", Prop{T: "hq-chess/chessboard", X: 1, Y: 1, W: 0, H: 1}, false},
		{"too wide", Prop{T: "hq-chess/chessboard", X: 1, Y: 1, W: 5, H: 1}, false},
		{"missing height", Prop{T: "hq-chess/chessboard", X: 1, Y: 1, W: 1}, false},
		{"data", Prop{T: "hq-chess/chessboard", X: 1, Y: 1, W: 1, H: 1, Data: "x"}, false},
		{"destination", Prop{T: "hq-chess/chessboard", X: 1, Y: 1, W: 1, H: 1, To: &Point{}}, false},
		{"out of bounds", Prop{T: "hq-chess/chessboard", X: 7, Y: 7, W: 2, H: 2}, false},
	}
	for _, c := range cases {
		err := Validate(openMap(c.p))
		if (err == nil) != c.ok {
			t.Errorf("%s: Validate = %v, want ok=%v", c.name, err, c.ok)
		}
	}
}

func TestPluginKind(t *testing.T) {
	pl, kind, ok := Prop{T: "hq-chess/chessboard"}.PluginKind()
	if !ok || pl != "hq-chess" || kind != "chessboard" {
		t.Fatalf("got %q %q %v", pl, kind, ok)
	}
	for _, typ := range []string{"desk", "", "a/", "/b", "a/b/c", "A/b", "a/B", "1a/b"} {
		if _, _, ok := (Prop{T: typ}).PluginKind(); ok {
			t.Errorf("%q must not be a plugin prop", typ)
		}
	}
}

func TestPluginPropIsInteractiveNotSolid(t *testing.T) {
	p := Prop{T: "hq-chess/chessboard", X: 2, Y: 3, W: 2, H: 2}
	if !p.Interactive() {
		t.Fatal("plugin props are interactive")
	}
	if w, h := p.Size(); w != 2 || h != 2 {
		t.Fatalf("Size = %dx%d", w, h)
	}
	c, err := Compile(openMap(p))
	if err != nil {
		t.Fatal(err)
	}
	for y := 3; y < 5; y++ {
		for x := 2; x < 4; x++ {
			if c.IsSolidTile(x, y) {
				t.Errorf("tile %d,%d is solid", x, y)
			}
		}
	}
}
