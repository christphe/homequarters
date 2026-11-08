package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// An administrator forcing a closed office over the game socket lands in the activity log, with the
// office's id (the world's rule, who may force and that the owner is told, is in world/office_test.go).
func TestAForcedDoorIsInTheActivityLog(t *testing.T) {
	r := newRig(t, nil)
	r.srv.mapLim = newLimiter(100, 100)
	ana, _ := r.join("Ana", "") // the first member is the admin
	bia, _ := r.join("Bia", "")
	if code, out := ana.do("PUT", "/api/map", withPlaces(r.savedMap(t), 0, bia.ID)); code != http.StatusOK {
		t.Fatalf("give office-1 to Bia: %d %v", code, out)
	}
	ch := ana.listen(t)
	oi := -1
	for i, a := range mapOf(t, await(t, ch, "hello", nil)).Areas {
		if a.ID == "office-1" {
			oi = i
		}
	}
	if oi < 0 {
		t.Fatal("the default office has an office-1")
	}
	c := ana.online(t) // a second socket of the same account replaces the first: drive this one
	send := func(msg string) {
		if err := c.Write(context.Background(), websocket.MessageText, []byte(msg)); err != nil {
			t.Fatal(err)
		}
	}
	send(`{"t":"go","x":5,"y":37}`) // the hall, in front of office-1's door
	office, err := r.st.OfficeBySlug(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); time.Sleep(300 * time.Millisecond) {
		send(`{"t":"force","n":` + strconv.Itoa(oi) + `}`) // refused until Ana stands at the door
		entries, _ := r.st.ListAudit(context.Background(), office.ID, 5)
		for _, e := range entries {
			if e.Action == "room.force" {
				if e.TargetName != "office-1" || e.Actor != "Ana" {
					t.Fatalf("the forced door names the office and the administrator: %+v", e)
				}
				return
			}
		}
	}
	t.Fatal("the activity log records the forced door")
}
