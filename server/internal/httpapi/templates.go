package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"time"

	"homequarters/internal/gamemap"
)

type templateRow struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	W       int             `json:"w"`
	H       int             `json:"h"`
	Summary gamemap.Summary `json:"summary"`
	Carry   gamemap.Carry   `json:"carry"`   // what applying it now would do to desk assignments
	Current bool            `json:"current"` // the office's walls are this template's
}

// listTemplates lists the office templates, each with what it offers and what applying it now would do
// to the desk assignments.
func (s *Server) listTemplates(w http.ResponseWriter, r *http.Request) {
	se := s.adminSession(w, r)
	if se == nil {
		return
	}
	office, err := s.st.OfficeByID(r.Context(), se.OfficeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	var cur gamemap.Map
	if err := json.Unmarshal([]byte(office.MapJSON), &cur); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	rows := make([]templateRow, 0, len(gamemap.Templates))
	for _, t := range gamemap.Templates {
		m := t.Build()
		rows = append(rows, templateRow{ID: t.ID, Name: t.Name, W: m.W, H: m.H, Summary: gamemap.Summarize(m),
			Carry: gamemap.CarryDesks(&cur, m), Current: cur.W == m.W && cur.H == m.H && slices.Equal(cur.Walls, m.Walls)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"templates": rows})
}

// applyTemplate replaces the office's map with a template. Everything an administrator or a member set
// on the map is overwritten, except desk assignments, which carry over by desk number. Everybody online
// reconnects into the new map near its spawn.
func (s *Server) applyTemplate(w http.ResponseWriter, r *http.Request) {
	se := s.adminSession(w, r)
	if se == nil {
		return
	}
	if !s.mapLim.Allow(strconv.FormatInt(se.UserID, 10)) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limited"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 256)
	var req struct {
		Template string `json:"template"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown template"})
		return
	}
	t, ok := gamemap.TemplateByID(req.Template)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown template"})
		return
	}
	office, err := s.st.OfficeByID(r.Context(), se.OfficeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	wd, err := s.worldFor(office)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	s.mapMu.Lock()
	defer s.mapMu.Unlock()
	// the map saved under the lock is the one last applied
	office, err = s.st.OfficeByID(r.Context(), se.OfficeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	var cur gamemap.Map
	if err := json.NewDecoder(bytes.NewReader([]byte(office.MapJSON))).Decode(&cur); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	owners, err := s.st.MemberNames(r.Context(), se.OfficeID, gamemap.Owners(&cur))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	gamemap.KeepOwners(&cur, func(u int64) bool { _, ok := owners[u]; return ok }) // removed members get nothing
	m := t.Build()
	carry := gamemap.CarryDesks(&cur, m)
	cm, err := gamemap.Compile(m)
	if err != nil {
		s.log.Error("compile template", "template", t.ID, "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	// Once begun, the switch finishes even if the admin's request goes away (a closed tab): a world on the
	// new map with the old one saved would come back as the old office at the next restart.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
	defer cancel()
	// last positions and whiteboards belong to the old map: forget them before anybody reconnects into the new one
	if err := s.st.ForgetMapState(ctx, se.OfficeID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	if err := wd.ReplaceMap(ctx, cm, owners, t.Name); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	raw, _ := json.Marshal(m)
	rev, err := s.st.SaveMap(ctx, office.ID, string(raw))
	// and again: a position saved on the way out (the save queue runs on its own) may have landed meanwhile
	if err == nil {
		err = s.st.ForgetMapState(ctx, se.OfficeID)
	}
	if err != nil {
		s.log.Error("save map", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "map applied but not saved"})
		return
	}
	s.log.Info("map template applied", "by", se.UserID, "template", t.ID, "rev", rev)
	s.audit(r, se, "map.template", 0, t.Name, "template="+t.ID+" rev="+strconv.FormatInt(rev, 10)+
		" kept="+strconv.Itoa(carry.Kept)+" lost="+strconv.Itoa(carry.Lost))
	writeJSON(w, http.StatusOK, map[string]any{"rev": rev, "carry": carry})
}
