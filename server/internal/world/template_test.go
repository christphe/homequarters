package world

import (
	"strings"
	"testing"
	"time"

	"homequarters/internal/gamemap"
)

// Applying a template of another size disconnects everybody (they reconnect into it), saves each of
// them a place near the new spawn and resizes the spatial grid, so newcomers move in the whole new map.
func TestReplaceMapChangesSizeAndRespawnsEverybody(t *testing.T) {
	h := newHarness(t)
	type left struct{ x, y float64 }
	var leaves []left
	h.w.OnLeave = func(_ int64, _ uint32, x, y float64) { leaves = append(leaves, left{x, y}) }
	a := h.add(1, "member", sx, sy)
	h.add(2, "member", sx+40, sy)
	h.w.boards["30,1"] = &board{key: "30,1", strokes: []*stroke{{}}} // a board of the Loft, drawn on
	cm, err := gamemap.Compile(gamemap.Manor())
	if err != nil {
		t.Fatal(err)
	}
	if h.w.SameSize(cm) {
		t.Fatal("Manor is larger than the Loft")
	}
	out := a.out
	errc := make(chan error, 1)
	h.w.handle(ev{kind: evMap, cm: cm, b: true, s: "Manor", errc: errc}, h.now)
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
	told := false
	for f := range out { // closed by the eviction, after what was queued
		told = told || string(f) == `{"n":"Manor","t":"layout"}`
	}
	if !told {
		t.Fatal("everybody is told the office moved to the new layout before reconnecting")
	}
	if len(h.w.list) != 0 || a.out != nil {
		t.Fatal("everybody is disconnected, to reconnect into the new map")
	}
	if len(h.w.boards) != 0 {
		t.Fatal("whiteboards are keyed by tile: the old map's strokes must not show on a board of the new one")
	}
	if len(h.w.lastCounts) != 0 {
		t.Fatal("head counts per area of the old map must not be sent to people joining the new one")
	}
	sp := cm.Map.Spawn
	for _, l := range leaves {
		tx, ty := int(l.x)/gamemap.TilePx, int(l.y)/gamemap.TilePx
		if cm.IsSolidTile(tx, ty) || tx < sp.X-3 || tx > sp.X+3 || ty < sp.Y-2 || ty > sp.Y+2 {
			t.Fatalf("saved position %v is not a free tile near the spawn %v", l, sp)
		}
	}
	if len(leaves) != 2 || !h.w.SameSize(cm) || h.w.cols*h.w.cfg.CellPx < cm.W*gamemap.TilePx || h.w.rows*h.w.cfg.CellPx < cm.H*gamemap.TilePx {
		t.Fatalf("grid %dx%d cells does not cover the new map", h.w.cols, h.w.rows)
	}
	// someone in the far corner of the new map is in the grid and seen by a neighbour
	far := h.add(3, "member", float64((cm.W-3)*gamemap.TilePx), float64(40*gamemap.TilePx))
	near := h.add(4, "member", float64((cm.W-4)*gamemap.TilePx), float64(40*gamemap.TilePx))
	h.run(time.Second)
	if !far.inGrid || !strings.Contains(strings.Join(drain(near), ""), `"id":3`) {
		t.Fatal("a player beyond the old map's edge is tracked and visible")
	}
}

// A couch corner is a room without walls: two people in it share a call, someone in the aisle beside
// it is not pulled in.
func TestConversationCornerIsARoomWithoutWalls(t *testing.T) {
	h := newHarness(t)
	cm, err := gamemap.Compile(gamemap.Manor())
	if err != nil {
		t.Fatal(err)
	}
	errc := make(chan error, 1)
	h.w.handle(ev{kind: evMap, cm: cm, b: true, errc: errc}, h.now)
	<-errc
	var c gamemap.Area
	for _, a := range cm.Map.Areas {
		if strings.HasPrefix(a.ID, gamemap.CornerPrefix+"couch-") {
			c = a
			break
		}
	}
	at := func(tx, ty int) (float64, float64) {
		return float64(tx*gamemap.TilePx + 8), float64(ty*gamemap.TilePx + 8)
	}
	x1, y1 := at(c.X, c.Y)
	x2, y2 := at(c.X+c.W-1, c.Y+c.H-1)
	x3, y3 := at(c.X, c.Y-2) // the aisle above it
	p1 := h.add(1, "member", x1, y1)
	p2 := h.add(2, "member", x2, y2)
	p3 := h.add(3, "member", x3, y3)
	for _, p := range []*Player{p1, p2, p3} {
		h.consent(p, true)
	}
	h.run(3 * time.Second)
	if p1.group == nil || p1.group != p2.group || !p1.group.isRoom {
		t.Fatal("the two people in the corner share its call")
	}
	if p3.group == p1.group {
		t.Fatal("someone in the aisle is not in the corner's call")
	}
}
