package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"homequarters/internal/gamemap"
)

// listen connects u's game socket and hands every frame to the returned channel (newest dropped when full).
func (u *user) listen(t *testing.T) <-chan map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(u.r.ts.URL, "http")+"/ws", &websocket.DialOptions{HTTPClient: u.c})
	if err != nil {
		t.Fatal(err)
	}
	c.SetReadLimit(4 << 20)
	t.Cleanup(func() { c.CloseNow() })
	ch := make(chan map[string]any, 256)
	go func() {
		for {
			_, b, err := c.Read(context.Background())
			if err != nil {
				return
			}
			var m map[string]any
			if json.Unmarshal(b, &m) == nil {
				select {
				case ch <- m:
				default:
				}
			}
		}
	}()
	return ch
}

// await returns the first frame of type typ that ok accepts, or fails after a few seconds.
func await(t *testing.T, ch <-chan map[string]any, typ string, ok func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case m := <-ch:
			if m["t"] == typ && (ok == nil || ok(m)) {
				return m
			}
		case <-deadline:
			t.Fatalf("no %q frame arrived", typ)
			return nil
		}
	}
}

// savedMap reads the default office's map as stored.
func (r *rig) savedMap(t *testing.T) gamemap.Map {
	t.Helper()
	office, err := r.st.OfficeBySlug(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	var m gamemap.Map
	if err := json.Unmarshal([]byte(office.MapJSON), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// withPlaces gives desk (20,3) to deskOwner and office-1 to officeOwner (0 leaves them free).
func withPlaces(m gamemap.Map, deskOwner, officeOwner int64) gamemap.Map {
	m.Props = append([]gamemap.Prop(nil), m.Props...)
	m.Areas = append([]gamemap.Area(nil), m.Areas...)
	for i := range m.Props {
		if p := &m.Props[i]; p.T == "desk" && p.X == 20 && p.Y == 3 {
			p.Assign = deskOwner
		}
	}
	for i := range m.Areas {
		if a := &m.Areas[i]; a.ID == "office-1" {
			a.Access.Users = nil
			if officeOwner != 0 {
				a.Access.Users = []int64{officeOwner}
			}
		}
	}
	return m
}

func ownerOf(m gamemap.Map) (desk int64, office []int64) {
	for _, p := range m.Props {
		if p.T == "desk" && p.X == 20 && p.Y == 3 {
			desk = p.Assign
		}
	}
	for _, a := range m.Areas {
		if a.ID == "office-1" {
			office = a.Access.Users
		}
	}
	return desk, office
}

// mapOf decodes the map carried by a hello or map frame.
func mapOf(t *testing.T, f map[string]any) gamemap.Map {
	t.Helper()
	b, _ := json.Marshal(f["map"])
	var m gamemap.Map
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func ownersOf(f map[string]any) map[string]any {
	o, _ := f["owners"].(map[string]any)
	return o
}

func TestRemovedMemberLosesTheirPlaces(t *testing.T) {
	r := newRig(t, nil)
	r.srv.mapLim = newLimiter(100, 100)
	ana, _ := r.join("Ana", "")
	bia, _ := r.join("Bia", "")
	cid, _ := r.join("Cid", "")
	ch := ana.listen(t)
	await(t, ch, "hello", nil)
	if code, out := ana.do("PUT", "/api/map", withPlaces(r.savedMap(t), bia.ID, cid.ID)); code != http.StatusOK {
		t.Fatalf("assign the places: %d %v", code, out)
	}
	await(t, ch, "map", nil)

	if code, out := ana.do("DELETE", "/api/admin/members/"+strconv.FormatInt(bia.ID, 10), nil); code != http.StatusOK {
		t.Fatalf("remove Bia: %d %v", code, out)
	}
	f := await(t, ch, "map", func(f map[string]any) bool { d, _ := ownerOf(mapOf(t, f)); return d == 0 })
	if _, office := ownerOf(mapOf(t, f)); len(office) != 1 || office[0] != cid.ID {
		t.Fatalf("only the removed member's place is freed: office %v", office)
	}
	for _, a := range mapOf(t, f).Areas {
		if a.ID == "desk-20-3" {
			t.Fatal("the freed desk loses its room for everybody online")
		}
	}
	if d, _ := ownerOf(r.savedMap(t)); d != 0 {
		t.Fatalf("the freed desk is saved: still assigned to %d", d)
	}

	if code, _ := ana.do("DELETE", "/api/admin/members/"+strconv.FormatInt(cid.ID, 10), nil); code != http.StatusOK {
		t.Fatal("remove Cid")
	}
	await(t, ch, "map", func(f map[string]any) bool { _, o := ownerOf(mapOf(t, f)); return len(o) == 0 })
	if _, office := ownerOf(r.savedMap(t)); len(office) != 0 {
		t.Fatalf("the removed owner leaves the private office: %v", office)
	}
}

func TestOwnerNamesAreJoinedNotStored(t *testing.T) {
	r := newRig(t, nil)
	r.srv.mapLim = newLimiter(100, 100)
	ana, _ := r.join("Ana", "")
	bia, _ := r.join("Bia", "")
	cid, _ := r.join("Cid", "")
	ch := ana.listen(t)
	await(t, ch, "hello", nil)
	if code, out := ana.do("PUT", "/api/map", withPlaces(r.savedMap(t), bia.ID, cid.ID)); code != http.StatusOK {
		t.Fatalf("assign the places: %d %v", code, out)
	}
	f := await(t, ch, "map", nil)
	if o := ownersOf(f); o[strconv.FormatInt(bia.ID, 10)] != "Bia" || o[strconv.FormatInt(cid.ID, 10)] != "Cid" {
		t.Fatalf("the map frame names the owners: %v", f["owners"])
	}

	if code, out := bia.do("PUT", "/api/profile", map[string]any{"name": "Bianca"}); code != http.StatusOK {
		t.Fatalf("rename: %d %v", code, out)
	}
	own := await(t, ch, "own", nil)
	if own["n"] != "Bianca" || int64(own["id"].(float64)) != bia.ID {
		t.Fatalf("everybody online learns the owner's new name: %v", own)
	}
	again := ana.listen(t)
	if o := ownersOf(await(t, again, "hello", nil)); o[strconv.FormatInt(bia.ID, 10)] != "Bianca" {
		t.Fatalf("a later hello names the owner by their current name: %v", o)
	}

	saved := r.savedMap(t)
	for _, p := range saved.Props {
		if p.T == "desk" && p.Assign != 0 && strings.Contains(p.Label, "Bia") {
			t.Fatalf("an assigned desk stores no owner name: %q", p.Label)
		}
	}
	for _, a := range saved.Areas {
		if a.ID == "office-1" && a.Name != "Office 1" {
			t.Fatalf("an owned office keeps its own name: %q", a.Name)
		}
	}
}

func TestMapDropsPlacesOfNonMembers(t *testing.T) {
	r := newRig(t, nil)
	ana, _ := r.join("Ana", "")
	bia, _ := r.join("Bia", "")
	// an editor draft opened before a member was removed still gives them a place: it is not kept
	if code, out := ana.do("PUT", "/api/map", withPlaces(r.savedMap(t), 9999, 9998)); code != http.StatusOK {
		t.Fatalf("a draft naming a non-member is saved: %d %v", code, out)
	}
	if desk, office := ownerOf(r.savedMap(t)); desk != 0 || len(office) != 0 {
		t.Fatalf("without the non-member's places: desk %d, office %v", desk, office)
	}
	if code, _ := ana.do("PUT", "/api/map", withPlaces(r.savedMap(t), bia.ID, 0)); code != http.StatusOK {
		t.Fatal("a member's place is kept")
	}
	if desk, _ := ownerOf(r.savedMap(t)); desk != bia.ID {
		t.Fatalf("a member's place is saved: %d", desk)
	}
	huge := withPlaces(r.savedMap(t), 0, 0)
	for i := range huge.Areas {
		if huge.Areas[i].ID == "office-1" {
			for u := int64(1); u <= 40000; u++ {
				huge.Areas[i].Access.Users = append(huge.Areas[i].Access.Users, u)
			}
		}
	}
	if code, _ := ana.do("PUT", "/api/map", huge); code != http.StatusUnprocessableEntity {
		t.Fatalf("an oversized owner list is refused before any lookup: %d", code)
	}
}

func TestLegacyMapLoadsClean(t *testing.T) {
	r := newRig(t, nil)
	ana, _ := r.join("Ana", "")
	bia, _ := r.join("Bia", "")
	m := withPlaces(r.savedMap(t), 9999, bia.ID) // a desk kept by a member removed before this fix
	for i := range m.Props {
		if p := &m.Props[i]; p.T == "desk" && p.X == 20 && p.Y == 3 {
			p.Label = "Gone's desk"
		}
	}
	for i := range m.Areas {
		if a := &m.Areas[i]; a.ID == "office-1" {
			a.Name = "Office 1 · Bia"
		}
	}
	raw, _ := json.Marshal(m)
	office, _ := r.st.OfficeBySlug(context.Background(), "default")
	if _, err := r.st.SaveMap(context.Background(), office.ID, string(raw)); err != nil {
		t.Fatal(err)
	}
	hello := await(t, ana.listen(t), "hello", nil)
	got := mapOf(t, hello)
	desk, owners := ownerOf(got)
	if desk != 0 {
		t.Fatalf("a place kept by a non-member loads free: %d", desk)
	}
	if len(owners) != 1 || owners[0] != bia.ID {
		t.Fatalf("members keep their places: %v", owners)
	}
	for _, a := range got.Areas {
		if a.ID == "office-1" && a.Name != "Office 1" {
			t.Fatalf("a stored owner name is dropped from the office name: %q", a.Name)
		}
	}
	for _, p := range got.Props {
		if p.T == "desk" && p.X == 20 && p.Y == 3 && p.Label != "" {
			t.Fatalf("a stored owner name is dropped from the desk: %q", p.Label)
		}
	}
	if o := ownersOf(hello); o[strconv.FormatInt(bia.ID, 10)] != "Bia" {
		t.Fatalf("the hello names the owners: %v", o)
	}
	if d, _ := ownerOf(r.savedMap(t)); d != 0 {
		t.Fatal("the cleaned map is saved")
	}
	if entries, _ := r.st.ListAudit(context.Background(), office.ID, 5); len(entries) == 0 || entries[0].Action != "map.clean" {
		t.Fatalf("the clean-up is in the activity log: %+v", entries)
	}
}

func TestEditorSaveRacingARemovalLeavesNoGhost(t *testing.T) {
	r := newRig(t, nil)
	r.srv.mapLim = newLimiter(1000, 1000)
	ana, _ := r.join("Ana", "")
	ana.listen(t) // the world runs, as when an administrator edits the map
	for round := 0; round < 15; round++ {
		bia, _ := r.join("Bia"+strconv.Itoa(round), "")
		draft := withPlaces(r.savedMap(t), bia.ID, 0)
		done := make(chan struct{})
		go func() {
			defer close(done)
			ana.do("PUT", "/api/map", draft)
		}()
		if code, _ := ana.do("DELETE", "/api/admin/members/"+strconv.FormatInt(bia.ID, 10), nil); code != http.StatusOK {
			t.Fatal("remove")
		}
		<-done
		if d, _ := ownerOf(r.savedMap(t)); d == bia.ID {
			t.Fatalf("round %d: a removed member kept the desk an editor save gave them", round)
		}
	}
}
