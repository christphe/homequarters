package plugin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"sort"
	"sync"
	"time"
)

// Player is a member as plugins see them. Invisible members are never reported (see Presence).
type Player struct {
	ID   uint32
	Name string
	Role string
}

// Sink delivers a ready-made {"t":"plg",...} frame to one online player, or to every one when to is 0.
// It must not block; false means the frame was not accepted.
type Sink interface {
	Deliver(to uint32, frame []byte) bool
}

// KV persists plugin key-value pairs. Set and Delete must not block: they queue the write and fail
// when the queue is full.
type KV interface {
	Load(plugin string) (map[string]string, error)
	Set(plugin, key, value string) error
	Delete(plugin, key string) error
}

type RouteReq struct {
	Player Player
	Body   []byte
	Query  url.Values
	Path   string // "GET /mine", set by Route, for error messages
}

type RouteResp struct {
	Status      int
	ContentType string
	Body        []byte
}

var (
	ErrUnknown    = errors.New("no such plugin")
	ErrBroken     = errors.New("plugin is broken")
	ErrNotRunning = errors.New("plugin is not running")
	ErrNoRoute    = errors.New("no such plugin route")
	ErrTimeout    = errors.New("plugin did not answer in time")
	ErrBusy       = errors.New("plugin is busy")
)

// Limits (see docs/plugins.md).
const (
	updateEvery   = 100 * time.Millisecond
	routeWait     = time.Second
	inboxSize     = 256
	maxErrors     = 10 // runtime errors tolerated per minute
	maxSendBytes  = 4 << 10
	sendRate      = 10 // messages per second per recipient, all plugins together
	sendBurst     = 20
	maxKeys       = 1000
	maxKeyBytes   = 128
	maxValueBytes = 4 << 10
)

// callBudget is the time one call into a plugin may take. The race detector slows the pure-Go QuickJS
// down by an order of magnitude, so instrumented builds (tests only, never production) get ten times
// more (race.go).
var callBudget = 50 * time.Millisecond

// startBudget is the time a plugin's top level and load() may take: parsing a large plugin alone
// takes tens of milliseconds.
var startBudget = time.Second

// Status is one installed plugin and what it is doing.
type Status struct {
	Info
	State string // disabled, running, crashed, broken
	Error string
}

// Host runs the plugins of one office.
type Host struct {
	log  *slog.Logger
	sink Sink
	kv   KV

	smu     sync.Mutex // serialises Start and Stop
	mu      sync.Mutex // guards the fields below; never held while plugin code runs
	cat     []Info
	inst    map[string]*instance
	crashed map[string]string
	online  map[uint32]Player
	closed  bool

	bmu    sync.Mutex
	budget map[uint32]*bucket

	// OnChange is called, from any goroutine, when a plugin stops by itself (crash). Set before use.
	OnChange func()
}

func NewHost(cat []Info, sink Sink, kv KV, log *slog.Logger) *Host {
	return &Host{log: log, sink: sink, kv: kv, cat: cat, inst: map[string]*instance{}, crashed: map[string]string{},
		online: map[uint32]Player{}, budget: map[uint32]*bucket{}}
}

func (h *Host) info(name string) *Info {
	for i := range h.cat {
		if h.cat[i].Name == name {
			return &h.cat[i]
		}
	}
	return nil
}

// Status lists every installed plugin, in name order.
func (h *Host) Status() []Status {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]Status, 0, len(h.cat))
	for _, i := range h.cat {
		s := Status{Info: i, State: "disabled"}
		switch {
		case i.Err != "":
			s.State, s.Error = "broken", i.Err
		case h.inst[i.Name] != nil:
			s.State = "running"
		case h.crashed[i.Name] != "":
			s.State, s.Error = "crashed", h.crashed[i.Name]
		}
		out = append(out, s)
	}
	return out
}

func (h *Host) Running(name string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.inst[name] != nil
}

// RunningInfo lists the running plugins, in name order.
func (h *Host) RunningInfo() []Info {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []Info
	for _, i := range h.cat {
		if h.inst[i.Name] != nil {
			out = append(out, i)
		}
	}
	return out
}

// Info returns an installed plugin's description.
func (h *Host) Info(name string) (Info, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if i := h.info(name); i != nil {
		return *i, true
	}
	return Info{}, false
}

// Start runs a plugin: its file is read again, its top level and load() run, then every member
// online gets onJoin. Starting a running plugin does nothing; starting a crashed one restarts it.
func (h *Host) Start(name string) error {
	h.smu.Lock() // one start or stop at a time; Presence and Message never wait for a plugin's load()
	defer h.smu.Unlock()
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return ErrNotRunning
	}
	i := h.info(name)
	if i == nil {
		h.mu.Unlock()
		return ErrUnknown
	}
	if i.Err != "" {
		// it was broken when the server read it: read it again, it may have been fixed since
		fresh := load(i.Dir)
		*i = fresh
		if fresh.Err != "" {
			h.mu.Unlock()
			return fmt.Errorf("%w: %s", ErrBroken, fresh.Err)
		}
	}
	if h.inst[name] != nil {
		h.mu.Unlock()
		return nil
	}
	info := *i
	h.mu.Unlock()
	in, err := newInstance(h, info)
	h.mu.Lock()
	defer h.mu.Unlock()
	if err == nil && h.closed {
		if in.vm != nil {
			in.vm.Close()
		}
		return ErrNotRunning
	}
	if err != nil {
		h.crashed[name] = err.Error()
		h.log.Warn("plugin failed to start", "plugin", name, "err", err)
		return err
	}
	delete(h.crashed, name)
	ids := make([]uint32, 0, len(h.online))
	for id := range h.online {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(a, b int) bool { return ids[a] < ids[b] })
	for _, id := range ids {
		in.presence(h.online[id], true)
	}
	h.inst[name] = in
	go in.run()
	return nil
}

// Stop stops a plugin (calling unload) and waits for it.
func (h *Host) Stop(name string) {
	h.smu.Lock()
	defer h.smu.Unlock()
	h.mu.Lock()
	in := h.inst[name]
	delete(h.inst, name)
	delete(h.crashed, name)
	h.mu.Unlock()
	if in != nil {
		in.halt()
	}
}

// Close stops every plugin; the host cannot start any afterwards.
func (h *Host) Close() {
	h.mu.Lock()
	h.closed = true
	all := make([]*instance, 0, len(h.inst))
	for _, in := range h.inst {
		all = append(all, in)
	}
	h.inst = map[string]*instance{}
	h.mu.Unlock()
	for _, in := range all {
		in.halt()
	}
}

// crash is called by an instance's goroutine when it stops by itself.
func (h *Host) crash(in *instance, reason string) {
	h.mu.Lock()
	mine := h.inst[in.info.Name] == in
	if mine {
		delete(h.inst, in.info.Name)
		h.crashed[in.info.Name] = reason
	}
	h.mu.Unlock()
	if mine {
		h.log.Warn("plugin stopped", "plugin", in.info.Name, "err", reason)
		if h.OnChange != nil {
			h.OnChange()
		}
	}
}

// Presence reports that a member became visible-online (online) or left, went invisible (offline).
// It never blocks and keeps every running plugin's view in order.
func (h *Host) Presence(p Player, online bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if online {
		h.online[p.ID] = p
	} else {
		if _, ok := h.online[p.ID]; !ok {
			return
		}
		delete(h.online, p.ID)
		h.bmu.Lock()
		delete(h.budget, p.ID)
		h.bmu.Unlock()
	}
	for _, in := range h.inst {
		in.presence(p, online)
	}
}

// Message hands a message from a member's browser code to the plugin. Dropped (and counted) when
// the plugin is not running or its inbox is full.
func (h *Host) Message(from Player, plugin string, data []byte) {
	h.mu.Lock()
	in := h.inst[plugin]
	h.mu.Unlock()
	if in == nil {
		return
	}
	in.post(event{kind: evMessage, p: from, data: data})
}

// RouteAuth says whether a running plugin has that route, and whether an app token may call it.
func (h *Host) RouteAuth(plugin, method, path string) (found, token bool) {
	h.mu.Lock()
	in := h.inst[plugin]
	h.mu.Unlock()
	if in == nil {
		return false, false
	}
	rt, ok := in.routes[method+" "+path]
	return ok, ok && rt.token
}

// Route runs a plugin's HTTP route and waits for its answer, at most routeWait.
func (h *Host) Route(ctx context.Context, plugin, method, path string, req RouteReq) (RouteResp, error) {
	h.mu.Lock()
	in := h.inst[plugin]
	h.mu.Unlock()
	if in == nil {
		return RouteResp{}, ErrNotRunning
	}
	rt, ok := in.routes[method+" "+path] // written only while loading, before the instance was published
	if !ok {
		return RouteResp{}, ErrNoRoute
	}
	id := rt.id
	ctx, cancel := context.WithTimeout(ctx, routeWait)
	defer cancel()
	req.Path = method + " " + path
	reply := make(chan routeResult, 1)
	select {
	case in.inbox <- event{kind: evRoute, route: id, req: req, reply: reply}:
	default:
		in.dropped.Add(1)
		return RouteResp{}, ErrBusy
	}
	select {
	case r := <-reply:
		return r.resp, r.err
	case <-in.done:
		return RouteResp{}, ErrNotRunning
	case <-ctx.Done():
		return RouteResp{}, ErrTimeout
	}
}

// spend takes one message from the shared per-recipient budget.
func (h *Host) spend(ids []uint32) bool {
	now := time.Now()
	h.bmu.Lock()
	defer h.bmu.Unlock()
	for _, id := range ids {
		if h.bucketFor(id, now).tokens < 1 {
			return false
		}
	}
	for _, id := range ids {
		h.budget[id].tokens--
	}
	return true
}

func (h *Host) bucketFor(id uint32, now time.Time) *bucket {
	b := h.budget[id]
	if b == nil {
		b = &bucket{tokens: sendBurst, at: now}
		h.budget[id] = b
		return b
	}
	b.tokens += now.Sub(b.at).Seconds() * sendRate
	if b.tokens > sendBurst {
		b.tokens = sendBurst
	}
	b.at = now
	return b
}

type bucket struct {
	tokens float64
	at     time.Time
}

// Client returns the compiled browser code of a running plugin.
func (h *Host) Client(name string) ([]byte, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	in := h.inst[name]
	if in == nil || in.client == nil {
		return nil, false
	}
	return in.client, true
}
