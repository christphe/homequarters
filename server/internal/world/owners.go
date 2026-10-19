package world

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"homequarters/internal/gamemap"
)

// SeedOwners names the members the places of the starting map belong to. Call before Run.
func (w *World) SeedOwners(names map[int64]string) {
	for id, n := range names {
		w.owners[id] = n
	}
	w.pruneOwners()
}

// OwnerRenamed shows a member's new name on their desk or office, for everybody online and in
// later hellos. Nothing happens when they own no place here.
func (w *World) OwnerRenamed(ctx context.Context, id int64, name string) {
	w.post(ctx, ev{kind: evOwnerName, id: uint32(id), s: name})
}

// FreePlaces frees the desk and the office seat of a member who left the office. The running world
// applies it at once; the returned map is what the caller persists, nil when they had no place.
func (w *World) FreePlaces(ctx context.Context, id int64) (*gamemap.Map, error) {
	reply := make(chan claimResult, 1)
	if !w.post(ctx, ev{kind: evFreePlaces, id: uint32(id), claim: reply}) {
		return nil, ctx.Err()
	}
	select {
	case r := <-reply:
		return r.m, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (w *World) doOwnerName(id int64, name string) {
	if _, ok := w.owners[id]; !ok || w.owners[id] == name {
		return
	}
	w.owners[id] = name
	b := []byte(`{"t":"own","id":`)
	b = strconv.AppendInt(b, id, 10)
	b = append(b, `,"n":`...)
	b = appendJSONString(b, name)
	b = append(b, '}')
	for _, p := range w.list {
		w.sendShared(p, b)
	}
}

func (w *World) doFreePlaces(id int64, now time.Time) (*gamemap.Map, error) {
	next := *w.m.Map
	if !gamemap.KeepOwners(&next, func(u int64) bool { return u != id }) {
		return nil, nil
	}
	cm, err := gamemap.Compile(&next)
	if err != nil {
		return nil, err
	}
	if err := w.doReloadMap(cm, now); err != nil {
		return nil, err
	}
	return &next, nil
}

// pruneOwners forgets the names of members who no longer own a place in the current map.
func (w *World) pruneOwners() {
	keep := map[int64]bool{}
	for _, u := range gamemap.Owners(w.m.Map) {
		keep[u] = true
	}
	for id := range w.owners {
		if !keep[id] {
			delete(w.owners, id)
		}
	}
}

// appendOwners writes the owner names as a JSON object keyed by user id.
func (w *World) appendOwners(b []byte) []byte {
	b = append(b, '{')
	first := true
	for id, n := range w.owners {
		if !first {
			b = append(b, ',')
		}
		first = false
		b = append(b, '"')
		b = strconv.AppendInt(b, id, 10)
		b = append(b, `":`...)
		b = appendJSONString(b, n)
	}
	return append(b, '}')
}

// areaTitle is how messages name area i: a desk room after its owner ("Ana's desk"), an owned
// office with its owners ("Office 2 · Ana"), any other area by its name.
func (w *World) areaTitle(i int) string {
	if i < 0 || i >= len(w.m.Map.Areas) {
		return ""
	}
	a := &w.m.Map.Areas[i]
	var names []string
	for _, u := range a.Access.Users {
		if n, ok := w.owners[u]; ok {
			names = append(names, n)
		}
	}
	switch {
	case len(names) == 0:
		return a.Name
	case a.Auto:
		return deskLabel(names[0])
	case isOwnedOffice(a):
		return a.Name + gamemap.OwnerSep + strings.Join(names, ", ")
	}
	return a.Name
}

func appendJSONString(b []byte, s string) []byte {
	sb, _ := json.Marshal(s)
	return append(b, sb...)
}
