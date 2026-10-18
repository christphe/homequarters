package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"modernc.org/quickjs"
)

type evKind int

const (
	evMessage evKind = iota + 1
	evRoute
)

type event struct {
	kind  evKind
	p     Player
	data  []byte
	route int // index of the route's handler in the plugin's __routes
	req   RouteReq
	reply chan routeResult
}

type routeResult struct {
	resp RouteResp
	err  error
}

// route is one hq.route: its handler's index, and whether an app token may call it.
type route struct {
	id    int
	token bool
}

type presenceEv struct {
	p      Player
	online bool
}

// fatal is an error that stops the plugin at once (time budget, memory cap).
type fatal struct{ msg string }

func (f *fatal) Error() string { return f.msg }

func isFatal(err error) bool {
	var f *fatal
	return errors.As(err, &f)
}

// Per-plugin QuickJS limits. The stack cap bounds JavaScript recursion: every JS frame also costs Go
// stack in the pure-Go QuickJS, and a Go stack overflow would end the whole server.
const (
	memoryCap = 16 << 20
	stackCap  = 8 << 10
)

// exportNames are the functions a server module may export.
var exportNames = map[string]bool{"load": true, "update": true, "onJoin": true, "onLeave": true, "onMessage": true, "unload": true}

// instance is one running plugin. A single goroutine (run) owns its QuickJS VM; everything else
// reaches it through the bounded inbox, or the presence queue, which is never dropped so the
// plugin's view of who is online stays right.
type instance struct {
	h       *Host
	info    Info
	vm      *quickjs.VM
	client  []byte
	inbox   chan event
	routes  map[string]route
	loading bool

	pmu     sync.Mutex
	pres    []presenceEv
	presIdx map[uint32]int // member id -> index in pres
	wake    chan struct{}

	stop    chan struct{}
	done    chan struct{}
	dropped atomic.Int64

	// goroutine-owned
	players   []Player
	kv        map[string]string
	errs      []time.Time
	budgetLog time.Time
	started   time.Time
}

func newInstance(h *Host, info Info) (*instance, error) {
	code, err := info.code()
	if err != nil {
		return nil, err
	}
	kv, err := h.kv.Load(info.Name)
	if err != nil {
		return nil, fmt.Errorf("load stored data: %w", err)
	}
	in := &instance{h: h, info: info, client: code.client, inbox: make(chan event, inboxSize), routes: map[string]route{},
		wake: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{}), kv: kv, started: time.Now()}
	if code.server == "" {
		return in, nil // a browser-only plugin: nothing runs on the server
	}
	vm, err := quickjs.NewVM()
	if err != nil {
		return nil, err
	}
	vm.SetMemoryLimit(memoryCap)
	vm.SetMaxStackSize(stackCap)
	in.vm = vm
	if err := in.install(); err != nil {
		vm.Close()
		return nil, err
	}
	// parsing and the module's top level get a longer budget than a call: a large plugin takes tens of
	// milliseconds to parse (bench/plugin-runtime)
	vm.SetEvalTimeout(startBudget)
	in.loading = true
	err = in.eval(code.server)
	if err == nil {
		err = in.checkExports()
	}
	if err == nil {
		err = in.callExport("load")
	}
	in.loading = false
	vm.SetEvalTimeout(callBudget)
	if err != nil {
		vm.Close()
		return nil, err
	}
	return in, nil
}

// eval runs the plugin's top level, then the promise jobs it queued.
func (in *instance) eval(js string) error {
	_, err := in.vm.Eval(js, quickjs.EvalGlobal)
	if err == nil {
		err = in.drain()
	}
	return in.jsError("the top level", err)
}

// checkExports refuses a module exporting anything but the known functions: a misspelled export
// (on_join for onJoin) would otherwise never be called, silently.
func (in *instance) checkExports() error {
	out, err := in.vm.Call("__exports")
	if err != nil {
		return in.jsError("the exports", err)
	}
	var names []string
	s, _ := out.(string)
	if err := json.Unmarshal([]byte(s), &names); err != nil {
		return err
	}
	for _, n := range names {
		if !exportNames[n] {
			return fmt.Errorf("unknown export %q: a server module exports only load, update, onJoin, onLeave, onMessage and unload", n)
		}
	}
	return nil
}

// drain runs the promise jobs queued by the last call (async functions continuing, .then callbacks),
// within a budget of their own, then reports the first error an async export threw.
func (in *instance) drain() error {
	// the drain has a deadline of its own; QuickJS stops a job that runs over it but does not report the
	// interruption, so a drain that used up the budget is an overrun (a promise chain that never ends)
	t0 := time.Now()
	_, err := in.vm.ExecutePendingJobs()
	if time.Since(t0) >= callBudget || (err != nil && strings.Contains(err.Error(), "aborted draining")) {
		return errors.New("InternalError: interrupted")
	}
	if err != nil {
		return err
	}
	out, err := in.vm.Call("__asyncError")
	if err != nil {
		return err
	}
	if s, _ := out.(string); s != "" {
		return errors.New(s)
	}
	return nil
}

// callExport calls one of the module's exported functions, if it has it, with JSON arguments, then
// settles the promises it started.
func (in *instance) callExport(name string, args ...any) error {
	if in.vm == nil {
		return nil
	}
	a, err := json.Marshal(args)
	if err != nil {
		return err
	}
	_, err = in.vm.Call("__call", name, string(a))
	if err == nil {
		err = in.drain()
	}
	return in.jsError(name, err)
}

// jsError turns a QuickJS error into the plugin's error, naming where it happened. Only QuickJS's own
// interrupt and allocation failure are fatal, not a plugin throwing those words.
func (in *instance) jsError(where string, err error) error {
	if err == nil {
		return nil
	}
	msg := strings.TrimSpace(strings.SplitN(err.Error(), "\n", 2)[0])
	switch {
	case msg == "InternalError: interrupted":
		return &fatal{fmt.Sprintf("%s ran over its %v time budget", where, callBudget)}
	case msg == "InternalError: out of memory":
		return &fatal{fmt.Sprintf("%s went over the %d MB memory cap", where, memoryCap>>20)}
	}
	return fmt.Errorf("in %s: %s", where, msg)
}

// presence queues a member's latest state. Pending changes are coalesced per member (the last one wins),
// so the queue is bounded by the office size however fast statuses flip.
func (in *instance) presence(p Player, online bool) {
	in.pmu.Lock()
	if i, ok := in.presIdx[p.ID]; ok {
		in.pres[i] = presenceEv{p, online}
	} else {
		if in.presIdx == nil {
			in.presIdx = map[uint32]int{}
		}
		in.presIdx[p.ID] = len(in.pres)
		in.pres = append(in.pres, presenceEv{p, online})
	}
	in.pmu.Unlock()
	select {
	case in.wake <- struct{}{}:
	default:
	}
}

func (in *instance) post(e event) {
	select {
	case in.inbox <- e:
	default:
		in.dropped.Add(1)
	}
}

// halt stops the goroutine and waits for it (unload runs within its budget).
func (in *instance) halt() {
	close(in.stop)
	<-in.done
}

func (in *instance) run() {
	defer close(in.done)
	defer func() {
		if in.vm != nil {
			in.vm.Close()
		}
	}()
	tick := time.NewTicker(updateEvery)
	defer tick.Stop()
	last := time.Now()
	for {
		// presence first, so a member joins before their messages are handled
		if err := in.drainPresence(); err != nil {
			in.h.crash(in, err.Error())
			return
		}
		var err error
		select {
		case <-in.stop:
			if err := in.callExport("unload"); err != nil {
				in.h.log.Warn("plugin unload failed", "plugin", in.info.Name, "err", err)
			}
			return
		case <-in.wake:
		case e := <-in.inbox:
			err = in.handle(e)
		case now := <-tick.C:
			dt := now.Sub(last).Seconds()
			last = now
			err = in.check(in.callExport("update", dt))
		}
		if err != nil {
			in.h.crash(in, err.Error())
			return
		}
	}
}

func (in *instance) drainPresence() error {
	in.pmu.Lock()
	evs := in.pres
	in.pres = nil
	clear(in.presIdx)
	in.pmu.Unlock()
	for _, e := range evs {
		idx := -1
		for i, q := range in.players {
			if q.ID == e.p.ID {
				idx = i
				break
			}
		}
		if e.online {
			if idx >= 0 {
				in.players[idx] = e.p
				continue
			}
			in.players = append(in.players, e.p)
			if err := in.check(in.callExport("onJoin", jsPlayer(e.p))); err != nil {
				return err
			}
		} else if idx >= 0 {
			in.players = append(in.players[:idx], in.players[idx+1:]...)
			if err := in.check(in.callExport("onLeave", jsPlayer(e.p))); err != nil {
				return err
			}
		}
	}
	return nil
}

func (in *instance) handle(e event) error {
	switch e.kind {
	case evMessage:
		if !json.Valid(e.data) {
			return nil // the socket already bounded it; a malformed body is ignored
		}
		return in.check(in.callExport("onMessage", jsPlayer(e.p), json.RawMessage(e.data)))
	case evRoute:
		resp, err := in.route(e)
		e.reply <- routeResult{resp, err}
		return in.check(err)
	}
	return nil
}

type jsReq struct {
	Player playerJSON        `json:"player"`
	Body   string            `json:"body"`
	Query  map[string]string `json:"query"`
}

func (in *instance) route(e event) (RouteResp, error) {
	q := map[string]string{}
	for k, v := range e.req.Query {
		if len(v) > 0 {
			q[k] = v[0]
		}
	}
	req, err := json.Marshal(jsReq{jsPlayer(e.req.Player), string(e.req.Body), q})
	if err != nil {
		return RouteResp{Status: 500}, err
	}
	_, err = in.vm.Call("__route", e.route, string(req))
	if err == nil {
		err = in.drain() // an async handler resolves here
	}
	if err == nil {
		var out any
		if out, err = in.vm.Call("__reply"); err == nil {
			if s, _ := out.(string); len(s) > MaxReplyBytes+64 {
				err = fmt.Errorf("reply of %d bytes is over the %d-byte limit", len(s), MaxReplyBytes)
			} else {
				return in.reply(s)
			}
		}
	}
	return RouteResp{Status: 500}, in.jsError("route "+e.req.Path, err)
}

// reply turns the handler's {s, t, b} into the HTTP answer.
func (in *instance) reply(s string) (RouteResp, error) {
	var r struct {
		S int             `json:"s"`
		T int             `json:"t"`
		B json.RawMessage `json:"b"`
	}
	if err := json.Unmarshal([]byte(s), &r); err != nil {
		return RouteResp{Status: 500}, fmt.Errorf("route reply: %v", err)
	}
	resp := RouteResp{Status: r.S, ContentType: "application/json"}
	if resp.Status < 100 || resp.Status > 599 {
		resp.Status = 200
	}
	switch {
	case string(r.B) == "null" || len(r.B) == 0:
		resp.ContentType = "text/plain; charset=utf-8"
	case r.T == 1: // a string body is sent as text
		var text string
		_ = json.Unmarshal(r.B, &text)
		resp.Body, resp.ContentType = []byte(text), "text/plain; charset=utf-8"
	default:
		resp.Body = r.B
	}
	if len(resp.Body) > MaxReplyBytes {
		return RouteResp{Status: 500}, fmt.Errorf("reply of %d bytes is over the %d-byte limit", len(resp.Body), MaxReplyBytes)
	}
	return resp, nil
}

// check counts a non-fatal error and turns the error rate or a fatal error into a stop.
func (in *instance) check(err error) error {
	if err == nil {
		return nil
	}
	if isFatal(err) {
		return err
	}
	now := time.Now()
	keep := in.errs[:0]
	for _, t := range in.errs {
		if now.Sub(t) < time.Minute {
			keep = append(keep, t)
		}
	}
	in.errs = append(keep, now)
	in.h.log.Warn("plugin error", "plugin", in.info.Name, "err", err)
	if len(in.errs) > maxErrors {
		return fmt.Errorf("more than %d errors in a minute, last: %v", maxErrors, err)
	}
	return nil
}

type playerJSON struct {
	ID   uint32 `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

func jsPlayer(p Player) playerJSON { return playerJSON{p.ID, p.Name, p.Role} }

func (in *instance) online(id uint32) bool {
	for _, p := range in.players {
		if p.ID == id {
			return true
		}
	}
	return false
}
