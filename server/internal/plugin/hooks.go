package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
)

// Hooks: a plugin exposes functions other plugins may call (hq.expose in load()), and calls another
// plugin's with hq.plugins.call, which returns a Promise. The call runs on the callee's goroutine like
// a route; its answer comes back to the caller through a channel with room for every call it may have
// pending, so neither side ever waits for the other (two plugins calling each other cannot deadlock).

const (
	maxHooks       = 16
	maxHookBytes   = 4096 // arguments, and the answer
	maxPendingCall = 64   // calls a plugin may have waiting for an answer
)

var (
	hookNameRE = regexp.MustCompile(`^[a-z][a-zA-Z0-9]{0,31}$`)
	// hookWait bounds a call; a variable so tests can shorten it
	hookWait = 2 * time.Second

	ErrNoHook = errors.New("no such hook")
)

type hookResult struct {
	value string // JSON
	err   error
}

// hookReply is a finished call, back on the caller's goroutine.
type hookReply struct {
	id      int
	ok      bool
	payload string // the answer's JSON, or the error message
}

func (in *instance) jsExpose(a []any) (any, error) {
	name, _ := argString(a, 0)
	if !in.loading {
		return nil, errors.New("hq.expose is only allowed in load()")
	}
	if !hookNameRE.MatchString(name) {
		return nil, fmt.Errorf("hq.expose: name %q must match %s", name, hookNameRE)
	}
	if !in.hooks[name] && len(in.hooks) >= maxHooks {
		return nil, fmt.Errorf("hq.expose: at most %d hooks", maxHooks)
	}
	in.hooks[name] = true
	return nil, nil
}

// jsCall starts a call to another plugin's hook and returns its id; the answer resolves the Promise
// the prelude keeps under that id.
func (in *instance) jsCall(a []any) (any, error) {
	plugin, _ := argString(a, 0)
	hook, _ := argString(a, 1)
	args, _ := argString(a, 2)
	switch {
	case in.loading:
		return nil, errors.New("hq.plugins.call is not allowed in load(): other plugins may not have started")
	case plugin == in.info.Name:
		return nil, errors.New("hq.plugins.call: a plugin cannot call its own hooks")
	case len(args) > maxHookBytes:
		return nil, fmt.Errorf("hq.plugins.call: arguments of %d bytes are over the %d-byte limit", len(args), maxHookBytes)
	case !json.Valid([]byte(args)):
		return nil, errors.New("hq.plugins.call: the arguments are not valid JSON")
	case in.pending >= maxPendingCall:
		return nil, fmt.Errorf("hq.plugins.call: %d calls already wait for an answer", maxPendingCall)
	}
	in.pending++
	in.nextCall++
	id := in.nextCall
	from, actor := in.info.Name, in.actor
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), hookWait)
		defer cancel()
		v, err := in.h.Hook(ctx, from, actor, plugin, hook, args)
		r := hookReply{id: id, ok: err == nil, payload: v}
		if err != nil {
			r.payload = err.Error()
		}
		in.replies <- r // room for every pending call: never blocks, even once the caller stopped
	}()
	return id, nil
}

// Hook runs plugin's exposed hook for the plugin from, acting for member actor (0: none), and waits
// for its answer (JSON).
func (h *Host) Hook(ctx context.Context, from string, actor uint32, plugin, hook, args string) (string, error) {
	h.mu.Lock()
	in := h.inst[plugin]
	h.mu.Unlock()
	if in == nil {
		return "", fmt.Errorf("%s: %w", plugin, ErrNotRunning)
	}
	if !in.hooks[hook] { // written only while loading, before the instance was published
		return "", fmt.Errorf("%s.%s: %w", plugin, hook, ErrNoHook)
	}
	reply := make(chan hookResult, 1)
	select {
	case in.inbox <- event{kind: evHook, hook: hook, from: from, actor: actor, data: []byte(args), hreply: reply}:
	default:
		in.dropped.Add(1)
		return "", fmt.Errorf("%s: %w", plugin, ErrBusy)
	}
	select {
	case r := <-reply:
		return r.value, r.err
	case <-in.done:
		return "", fmt.Errorf("%s: %w", plugin, ErrNotRunning)
	case <-ctx.Done():
		return "", fmt.Errorf("%s.%s: %w", plugin, hook, ErrTimeout)
	}
}

// hook runs one of this plugin's exposed hooks (on its goroutine).
func (in *instance) hook(e event) (string, error) {
	_, err := in.vm.Call("__hook", e.hook, e.from, int(e.actor), string(e.data))
	if err == nil {
		err = in.drain() // an async hook resolves here
	}
	if err == nil {
		err = in.await(true, hookWait) // or once the plugins it called answered
	}
	if err == nil {
		var out any
		if out, err = in.vm.Call("__hookReply"); err == nil {
			s, _ := out.(string)
			if len(s) > maxHookBytes {
				return "", fmt.Errorf("hook %s: an answer of %d bytes is over the %d-byte limit", e.hook, len(s), maxHookBytes)
			}
			if !json.Valid([]byte(s)) {
				return "", fmt.Errorf("hook %s: the answer is not valid JSON", e.hook)
			}
			return s, nil
		}
	}
	return "", in.jsError("hook "+e.hook, err)
}

// await lets a route or hook that waits for other plugins' answers finish: it settles the answers to
// this plugin's calls as they come, until the handler answered, nothing is pending, or wait is over.
// Other events wait meanwhile; a plugin calling back into this one gets a timeout, never a deadlock.
func (in *instance) await(hook bool, wait time.Duration) error {
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	for in.pending > 0 {
		done, err := in.vm.Call("__answered", hook)
		if err != nil {
			return err
		}
		if b, _ := done.(bool); b {
			return nil
		}
		select {
		case r := <-in.replies:
			if err := in.resolve(r); err != nil {
				return err
			}
		case <-deadline.C:
			return nil // the handler did not answer: reported as such by the caller
		case <-in.stop:
			return nil
		}
	}
	return nil
}

// resolve settles the Promise of a finished call (on the caller's goroutine).
func (in *instance) resolve(r hookReply) error {
	in.pending--
	if in.vm == nil {
		return nil
	}
	if _, err := in.vm.Call("__resolve", r.id, r.ok, r.payload); err != nil {
		return in.jsError("a call's answer", err)
	}
	return in.drain()
}
