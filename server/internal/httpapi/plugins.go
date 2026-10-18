package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"homequarters/internal/plugin"
	"homequarters/internal/world"
)

// Plugins: folders under HQ_PLUGINS_DIR/bundled and HQ_PLUGINS_DIR/installed, run per office by an
// internal/plugin Host that lives as long as the office's world. See docs/plugins.md and ADR 0022.

const (
	maxPluginBody = 16 << 10 // POST body of a plugin route
	maxPluginMsg  = 1500     // "d" of a client's plg message
)

var plgsFrame = []byte(`{"t":"plgs"}`)

type kvWrite struct {
	office    int64
	plugin, k string
	v         string
	del       bool
}

func (s *Server) setupPlugins() {
	s.hosts = map[int64]*plugin.Host{}
	s.kvQ = make(chan kvWrite, 1024)
	s.plugLim = newLimiter(5, 10)
	if s.cfg.PluginsDir == "" {
		return
	}
	cat, err := plugin.Scan(s.cfg.PluginsDir)
	if err != nil {
		s.log.Error("plugins folder unreadable", "dir", s.cfg.PluginsDir, "err", err)
	}
	if plugin.FlatLayout(s.cfg.PluginsDir) {
		s.log.Warn("plugin folders directly in the plugins folder are not read: move them into installed/", "dir", s.cfg.PluginsDir)
	}
	if cat == nil {
		s.log.Info("no bundled/ or installed/ plugins folder: plugins are off", "dir", s.cfg.PluginsDir)
		return
	}
	s.plugins = cat
	for _, i := range cat {
		if i.Err != "" {
			s.log.Warn("plugin is broken", "plugin", i.Name, "source", i.Source, "err", i.Err)
		}
	}
	s.log.Info("plugins installed", "count", len(cat))
}

func (s *Server) writeKV(ctx context.Context, k kvWrite) {
	var err error
	if k.del {
		err = s.st.DeletePluginKV(ctx, k.office, k.plugin, k.k)
	} else {
		err = s.st.PutPluginKV(ctx, k.office, k.plugin, k.k, k.v)
	}
	if err != nil {
		s.log.Error("save plugin data", "plugin", k.plugin, "err", err) // never the key or value
	}
}

// worldSink delivers plugin frames through the world, which never kicks a player for them.
type worldSink struct{ w *world.World }

func (ws worldSink) Deliver(to uint32, frame []byte) bool { return ws.w.PluginFrame(to, frame) }

// storeKV keeps plugin data in SQLite. Writes go through the persistence worker; once the server is
// stopping (unload at shutdown) they are written directly.
type storeKV struct {
	s      *Server
	office int64
}

func (k storeKV) Load(p string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return k.s.st.PluginKV(ctx, k.office, p)
}

func (k storeKV) put(w kvWrite) error {
	if k.s.ctx.Err() != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		k.s.writeKV(ctx, w)
		return nil
	}
	select {
	case k.s.kvQ <- w:
		return nil
	default:
		return errors.New("storage busy, try again later")
	}
}

func (k storeKV) Set(p, key, v string) error {
	return k.put(kvWrite{office: k.office, plugin: p, k: key, v: v})
}
func (k storeKV) Delete(p, key string) error {
	return k.put(kvWrite{office: k.office, plugin: p, k: key, del: true})
}

// pluginHost builds the host of a world being created (s.mu held). Nil when plugins are off.
func (s *Server) pluginHost(office int64, w *world.World) *plugin.Host {
	if s.plugins == nil {
		return nil
	}
	h := plugin.NewHost(s.plugins, worldSink{w}, storeKV{s, office}, s.log.With("office", office))
	h.OnChange = func() { w.PluginFrame(0, plgsFrame) }
	w.OnPresence = func(_ int64, id uint32, name, role string, online bool) {
		h.Presence(plugin.Player{ID: id, Name: name, Role: role}, online)
	}
	s.hosts[office] = h
	return h
}

// startPlugins gives every plugin its stored settings, then starts the ones an administrator enabled.
func (s *Server) startPlugins(office int64, h *plugin.Host) {
	settings, err := s.st.PluginSettings(s.ctx, office)
	if err != nil {
		s.log.Error("load plugin settings", "err", err)
	}
	for _, st := range h.Status() {
		if !st.NameRefused && len(st.Settings) > 0 {
			h.SetSettings(st.Name, settings[st.Name])
		}
	}
	flags, err := s.st.PluginFlags(s.ctx, office)
	if err != nil {
		s.log.Error("load plugin flags", "err", err)
		return
	}
	for _, st := range h.Status() {
		if flags[st.Name] && st.State == "disabled" {
			h.Start(st.Name) // a failure is kept as the plugin's state and logged by the host
		}
	}
}

// hostFor returns the plugin host of the configured office, starting its world if needed.
func (s *Server) hostFor(ctx context.Context) *plugin.Host {
	if s.plugins == nil {
		return nil
	}
	o, err := s.st.OfficeBySlug(ctx, s.cfg.OfficeSlug)
	if err != nil {
		return nil
	}
	if _, err := s.worldFor(o); err != nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hosts[o.ID]
}

// runningHost returns the configured office's plugin host if its world already runs, else nil.
// A plugin's assets are only fetched by pages of members who are in the office, so nothing is lost.
func (s *Server) runningHost(ctx context.Context) *plugin.Host {
	if s.plugins == nil {
		return nil
	}
	o, err := s.st.OfficeBySlug(ctx, s.cfg.OfficeSlug)
	if err != nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hosts[o.ID]
}

func (s *Server) pluginRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/plugins", s.listPlugins)
	mux.HandleFunc("GET /api/admin/plugins", s.adminPlugins)
	mux.HandleFunc("PUT /api/admin/plugins/{name}", s.setPlugin)
	mux.HandleFunc("PUT /api/admin/plugins/{name}/settings", s.setPluginSetting)
	mux.HandleFunc("GET /plugins/{name}/api/{path...}", s.pluginRoute)
	mux.HandleFunc("POST /plugins/{name}/api/{path...}", s.pluginRoute)
	mux.HandleFunc("GET /plugins/{name}/assets/{path...}", s.pluginAsset)
	mux.HandleFunc("GET /plugins/{name}/client.js", s.pluginClient)
	mux.HandleFunc("/plugins/", http.NotFound) // nothing else under /plugins/, never the SPA page
	mux.HandleFunc("GET /api/plugins/{name}/token", s.appToken)
	mux.HandleFunc("POST /api/plugins/{name}/token", s.appToken)
	mux.HandleFunc("DELETE /api/plugins/{name}/token", s.appToken)
}

// appToken lets a member see whether they have a token for a plugin (GET), create or replace it
// (POST: the token is returned this once) or revoke it (DELETE). Only for running plugins whose
// manifest asks for app tokens.
func (s *Server) appToken(w http.ResponseWriter, r *http.Request) {
	se, err := s.session(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	name := r.PathValue("name")
	h := s.hostFor(r.Context())
	info, ok := plugin.Info{}, false
	if h != nil {
		info, ok = h.Info(name)
	}
	if !ok || !info.AppTokens || !h.Running(name) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such plugin"})
		return
	}
	if r.Method != http.MethodGet && !s.plugLim.Allow(name+"/"+strconv.FormatInt(se.UserID, 10)) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		at, exists, err := s.st.AppTokenInfo(r.Context(), se.OfficeID, se.UserID, name)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "storage"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"exists": exists, "createdAt": at})
	case http.MethodPost:
		tok, err := s.st.CreateAppToken(r.Context(), se.OfficeID, se.UserID, name)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "storage"})
			return
		}
		s.audit(r, se, "plugin.token.create", 0, name, "")
		writeJSON(w, http.StatusOK, map[string]string{"token": tok})
	case http.MethodDelete:
		if err := s.st.DeleteAppToken(r.Context(), se.OfficeID, se.UserID, name); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "storage"})
			return
		}
		s.audit(r, se, "plugin.token.revoke", 0, name, "")
		writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
	}
}

type pluginEntry struct {
	Name   string  `json:"name"`
	Title  string  `json:"title"`
	Client *string `json:"client"`
	// Hosts the page lets the plugin's iframe fetch from (its Content Security Policy)
	Hosts []string `json:"hosts,omitempty"`
}

// listPlugins tells a member's page which plugins run and where their browser code is.
func (s *Server) listPlugins(w http.ResponseWriter, r *http.Request) {
	if _, err := s.session(r); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	out := []pluginEntry{}
	if h := s.hostFor(r.Context()); h != nil {
		for _, i := range h.RunningInfo() {
			e := pluginEntry{Name: i.Name, Title: i.Title, Hosts: i.ExternalHosts}
			if i.Client != "" {
				c := "/plugins/" + i.Name + "/client.js" // compiled by the server from client.ts or client.js
				e.Client = &c
			}
			out = append(out, e)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

type pluginStatus struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Version     string `json:"version"`
	Description string `json:"description"`
	// LongDescription is shown in the admin dialog's About modal
	LongDescription string `json:"longDescription,omitempty"`
	// ExternalHosts: where the plugin's browser code may fetch from (each viewer's address reaches them)
	ExternalHosts []string `json:"externalHosts,omitempty"`
	State         string   `json:"state"`
	Error         string   `json:"error"`
	Source        string   `json:"source"`  // bundled or installed
	Refused       bool     `json:"refused"` // refused for its name: no switch, it can never run
	// Settings are the administrator's choices the plugin declares, with their current values
	Settings []settingView `json:"settings,omitempty"`
}

type settingView struct {
	Key   string  `json:"key"`
	Label string  `json:"label"`
	Min   float64 `json:"min"`
	Max   float64 `json:"max"`
	Value float64 `json:"value"`
	Help  string  `json:"help,omitempty"`
}

func (s *Server) adminPlugins(w http.ResponseWriter, r *http.Request) {
	if s.adminSession(w, r) == nil {
		return
	}
	out := []pluginStatus{}
	if h := s.hostFor(r.Context()); h != nil {
		for _, st := range h.Status() {
			row := pluginStatus{Name: st.Name, Title: st.Title, Version: st.Version, Description: st.Description, LongDescription: st.LongDescription, ExternalHosts: st.ExternalHosts, State: st.State, Error: st.Error, Source: st.Source, Refused: st.NameRefused}
			if !st.NameRefused {
				vals := h.Settings(st.Name)
				for _, d := range st.Settings {
					row.Settings = append(row.Settings, settingView{d.Key, d.Label, d.Min, d.Max, vals[d.Key], d.Help})
				}
			}
			out = append(out, row)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// setPluginSetting changes one of a plugin's declared settings for the office: checked against its
// manifest, stored, audited, and handed to the plugin at once (onSettings).
func (s *Server) setPluginSetting(w http.ResponseWriter, r *http.Request) {
	se := s.adminSession(w, r)
	if se == nil {
		return
	}
	var body struct {
		Key   string   `json:"key"`
		Value *float64 `json:"value"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256)).Decode(&body); err != nil || body.Value == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "key and value are required"})
		return
	}
	name := r.PathValue("name")
	h := s.hostFor(r.Context())
	info, ok := plugin.Info{}, false
	if h != nil {
		info, ok = h.Info(name)
	}
	if !ok || info.NameRefused {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such plugin"})
		return
	}
	if err := info.CheckSetting(body.Key, *body.Value); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := s.st.SetPluginSetting(r.Context(), se.OfficeID, name, body.Key, *body.Value); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not save"})
		return
	}
	stored, err := s.st.PluginSettings(r.Context(), se.OfficeID)
	if err != nil {
		s.log.Error("load plugin settings", "plugin", name, "err", err)
	}
	h.SetSettings(name, stored[name])
	s.audit(r, se, "plugin.settings", 0, info.Name, fmt.Sprintf("%s=%v", body.Key, *body.Value))
	writeJSON(w, http.StatusOK, map[string]any{"settings": h.Settings(name)})
}

// setPlugin enables or disables an installed plugin, live, and remembers the choice.
func (s *Server) setPlugin(w http.ResponseWriter, r *http.Request) {
	se := s.adminSession(w, r)
	if se == nil {
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256)).Decode(&body); err != nil || body.Enabled == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "enabled is required"})
		return
	}
	name := r.PathValue("name")
	h := s.hostFor(r.Context())
	if h == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such plugin"})
		return
	}
	info, ok := h.Info(name)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such plugin"})
		return
	}
	action := "plugin.disable"
	if *body.Enabled {
		action = "plugin.enable"
		if err := h.Start(name); err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error(), "state": stateOf(h, name)})
			return
		}
	} else {
		h.Stop(name)
	}
	if err := s.st.SetPluginEnabled(r.Context(), se.OfficeID, name, *body.Enabled); err != nil {
		s.log.Error("save plugin flag", "plugin", name, "err", err)
	}
	s.audit(r, se, action, 0, info.Name, "")
	s.broadcastPlugins()
	writeJSON(w, http.StatusOK, map[string]string{"state": stateOf(h, name)})
}

func stateOf(h *plugin.Host, name string) string {
	for _, st := range h.Status() {
		if st.Name == name {
			return st.State
		}
	}
	return ""
}

func (s *Server) broadcastPlugins() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, wd := range s.worlds {
		wd.PluginFrame(0, plgsFrame)
	}
}

// pluginRoute runs a route a plugin declared with hq.route, for signed-in members, or with that
// member's app token (Authorization: Bearer) on routes declared with { token: true }.
func (s *Server) pluginRoute(w http.ResponseWriter, r *http.Request) {
	if s.plugins == nil {
		http.NotFound(w, r)
		return
	}
	name, path := r.PathValue("name"), "/"+r.PathValue("path")
	unauthorized := func() { writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"}) }
	var player plugin.Player
	var h *plugin.Host
	if se, err := s.session(r); err == nil {
		player = plugin.Player{ID: uint32(se.UserID), Name: se.Name, Role: se.Role}
		h = s.hostFor(r.Context())
	} else if tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		owner, err := s.st.LookupAppToken(r.Context(), strings.TrimSpace(tok))
		if err != nil || owner.Plugin != name {
			unauthorized()
			return
		}
		if h = s.hostFor(r.Context()); h != nil {
			if found, token := h.RouteAuth(name, r.Method, path); found && !token {
				unauthorized() // a token only opens the routes declared for it
				return
			}
		}
		if o, err := s.st.OfficeBySlug(r.Context(), s.cfg.OfficeSlug); err != nil || o.ID != owner.OfficeID {
			unauthorized()
			return
		}
		player = plugin.Player{ID: uint32(owner.UserID), Name: owner.Name, Role: owner.Role}
		if err := s.st.TouchAppToken(r.Context(), strings.TrimSpace(tok)); err != nil {
			s.log.Error("app token use", "plugin", name, "err", err) // never the token
		}
	} else {
		unauthorized()
		return
	}
	if h == nil || !h.Running(name) { // before the limiter: its keys are only running plugins
		http.NotFound(w, r)
		return
	}
	var err error
	if !s.plugLim.Allow(name + "/" + strconv.FormatUint(uint64(player.ID), 10)) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
		return
	}
	var body []byte
	if r.Method == http.MethodPost {
		body, err = io.ReadAll(http.MaxBytesReader(w, r.Body, maxPluginBody))
		if err != nil {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "body too large"})
			return
		}
	}
	resp, err := h.Route(r.Context(), name, r.Method, path, plugin.RouteReq{Player: player, Body: body, Query: r.URL.Query()})
	switch {
	case errors.Is(err, plugin.ErrNotRunning), errors.Is(err, plugin.ErrNoRoute):
		http.NotFound(w, r)
		return
	case errors.Is(err, plugin.ErrTimeout), errors.Is(err, plugin.ErrBusy):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "plugin busy"})
		return
	case err != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "plugin error"})
		return
	}
	w.Header().Set("Content-Type", resp.ContentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.Status)
	w.Write(resp.Body)
}

// pluginClient serves a running plugin's browser code, compiled when the plugin started. Public, like
// its assets: the sandboxed iframe that loads it sends no cookie.
func (s *Server) pluginClient(w http.ResponseWriter, r *http.Request) {
	h := s.runningHost(r.Context())
	if h == nil {
		http.NotFound(w, r)
		return
	}
	js, ok := h.Client(r.PathValue("name"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	hd := w.Header()
	hd.Set("Content-Type", "text/javascript; charset=utf-8")
	hd.Set("Cache-Control", "no-cache")
	hd.Set("Access-Control-Allow-Origin", "*")
	sum := sha256.Sum256(js)
	hd.Set("ETag", `"`+hex.EncodeToString(sum[:8])+`"`)
	if r.Header.Get("If-None-Match") == hd.Get("ETag") {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Write(js)
}

// pluginAsset serves a file of a running plugin's public/ folder. No session: the plugin's sandboxed
// iframe has an opaque origin and sends no cookie, and public/ is public by name.
func (s *Server) pluginAsset(w http.ResponseWriter, r *http.Request) {
	h := s.runningHost(r.Context()) // never starts the office for an anonymous request
	if h == nil {
		http.NotFound(w, r)
		return
	}
	name := r.PathValue("name")
	info, ok := h.Info(name)
	if !ok || !h.Running(name) {
		http.NotFound(w, r)
		return
	}
	p, ok := info.Asset(r.PathValue("path"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() > plugin.MaxAssetBytes {
		http.NotFound(w, r)
		return
	}
	hd := w.Header()
	hd.Set("Content-Type", plugin.ContentType(p))
	hd.Set("Cache-Control", "no-cache")
	hd.Set("Access-Control-Allow-Origin", "*")
	hd.Set("ETag", fmt.Sprintf(`"%x-%x"`, st.ModTime().UnixNano(), st.Size()))
	http.ServeContent(w, r, "", st.ModTime(), f)
}
