package world

import (
	"context"
	"errors"
	"strconv"
	"time"

	"tilework/internal/gamemap"
)

// Why a desk claim was refused.
var (
	ErrClaimOffline  = errors.New("not in the office")
	ErrClaimNoDesk   = errors.New("no desk there")
	ErrClaimFar      = errors.New("too far from the desk")
	ErrClaimTaken    = errors.New("this desk is taken")
	ErrClaimRoom     = errors.New("desks inside a room are assigned by an administrator")
	ErrClaimHasPlace = errors.New("you already have a desk or an office")
	// ErrReleaseNotMine refuses to free a desk that is not assigned to the player.
	ErrReleaseNotMine = errors.New("this is not your desk")
)

// deskLabel names a desk after its owner, cut on a character boundary to the 40 bytes the map
// accepts for a label.
func deskLabel(name string) string {
	l := []rune(name + "'s desk")
	for len(string(l)) > 40 {
		l = l[:len(l)-1]
	}
	return string(l)
}

type claimResult struct {
	m   *gamemap.Map
	err error
}

// ClaimDesk gives the free desk at tile (x, y) to a connected player who stands next to it and has
// no desk or office yet. The running world applies it at once; the returned map is what the caller
// persists.
func (w *World) ClaimDesk(ctx context.Context, uid uint32, x, y int) (*gamemap.Map, error) {
	return w.deskChange(ctx, uid, x, y, false)
}

// ReleaseDesk frees the desk at tile (x, y) for its owner, who stands next to it. Like ClaimDesk,
// the world applies it and returns the map to persist.
func (w *World) ReleaseDesk(ctx context.Context, uid uint32, x, y int) (*gamemap.Map, error) {
	return w.deskChange(ctx, uid, x, y, true)
}

func (w *World) deskChange(ctx context.Context, uid uint32, x, y int, release bool) (*gamemap.Map, error) {
	reply := make(chan claimResult, 1)
	if !w.post(ctx, ev{kind: evClaim, id: uid, x: x, y: y, b: release, claim: reply}) {
		return nil, ctx.Err()
	}
	select {
	case r := <-reply:
		return r.m, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// deskNear finds the desk at (x, y) and checks that the connected player uid stands within reach.
func (w *World) deskNear(uid uint32, x, y int) (int, error) {
	p := w.players[uid]
	if p == nil || p.out == nil {
		return -1, ErrClaimOffline
	}
	for i := range w.m.Map.Props {
		pr := &w.m.Map.Props[i]
		if pr.T != "desk" || pr.X != x || pr.Y != y {
			continue
		}
		dw, dh := pr.Size()
		if rectDist(p.X, p.Y, float64(x*gamemap.TilePx), float64(y*gamemap.TilePx), float64(dw*gamemap.TilePx), float64(dh*gamemap.TilePx)) > useReach {
			return i, ErrClaimFar
		}
		return i, nil
	}
	return -1, ErrClaimNoDesk
}

// assignDesk applies a map where the desk at prop index at belongs to owner (0 frees it) and is
// labelled label: "<name>'s desk" for an owner and no label once freed, as the map editor does.
func (w *World) assignDesk(at int, owner int64, label string, now time.Time) (*gamemap.Map, error) {
	cur := w.m.Map
	// Compile rewrites Areas, and the current compiled map must stay intact if this fails.
	next := *cur
	next.Props = append([]gamemap.Prop(nil), cur.Props...)
	next.Areas = append([]gamemap.Area(nil), cur.Areas...)
	next.Props[at].Assign = owner
	next.Props[at].Label = label
	cm, err := gamemap.Compile(&next)
	if err != nil {
		return nil, err
	}
	if err := w.doReloadMap(cm, now); err != nil {
		return nil, err
	}
	return &next, nil
}

// doReleaseDesk frees my desk while I stand in its room, where the Release button sits next to Lock.
func (w *World) doReleaseDesk(uid uint32, x, y int, now time.Time) (*gamemap.Map, error) {
	p := w.players[uid]
	if p == nil || p.out == nil {
		return nil, ErrClaimOffline
	}
	at := -1
	for i := range w.m.Map.Props {
		if pr := &w.m.Map.Props[i]; pr.T == "desk" && pr.X == x && pr.Y == y {
			at = i
			break
		}
	}
	if at < 0 {
		return nil, ErrClaimNoDesk
	}
	if w.m.Map.Props[at].Assign != int64(uid) {
		return nil, ErrReleaseNotMine
	}
	if p.area < 0 || w.m.Map.Areas[p.area].ID != "desk-"+strconv.Itoa(x)+"-"+strconv.Itoa(y) {
		return nil, ErrClaimFar
	}
	return w.assignDesk(at, 0, "", now)
}

func (w *World) doClaimDesk(uid uint32, x, y int, now time.Time) (*gamemap.Map, error) {
	at, err := w.deskNear(uid, x, y)
	if at < 0 {
		return nil, err
	}
	cur := w.m.Map
	if a := cur.Props[at].Assign; a == int64(uid) {
		return nil, ErrClaimHasPlace // already mine (a second click, a retry)
	} else if a != 0 {
		return nil, ErrClaimTaken
	}
	// every room, not just the topmost area: a desk room may cover a desk on a room's edge
	for _, a := range cur.Areas {
		if a.Kind == gamemap.KindRoom && !a.Auto && x >= a.X && y >= a.Y && x < a.X+a.W && y < a.Y+a.H {
			return nil, ErrClaimRoom
		}
	}
	if err != nil {
		return nil, err // too far
	}
	me := int64(uid)
	for _, pr := range cur.Props {
		if pr.T == "desk" && pr.Assign == me {
			return nil, ErrClaimHasPlace
		}
	}
	for _, a := range cur.Areas {
		if a.Kind == gamemap.KindRoom && a.Access.Mode == gamemap.AccessOffice && !a.Auto {
			for _, u := range a.Access.Users {
				if u == me {
					return nil, ErrClaimHasPlace
				}
			}
		}
	}
	return w.assignDesk(at, me, deskLabel(w.players[uid].Name), now)
}
