package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"modernc.org/quickjs"
)

// prelude runs before the plugin's code. It builds the global hq (plugins/sdk/server.d.ts) over the
// host functions, then hides those, so a plugin only ever sees hq. __call and __route are how the host
// calls the module's exports and route handlers; arguments and results cross as JSON.
const prelude = `
(function () {
  "use strict";
  var h = {
    send: __tw_send, broadcast: __tw_broadcast, players: __tw_players, get: __tw_kv_get, set: __tw_kv_set,
    del: __tw_kv_delete, route: __tw_route, log: __tw_log, now: __tw_now,
  };
  ["__tw_send", "__tw_broadcast", "__tw_players", "__tw_kv_get", "__tw_kv_set", "__tw_kv_delete", "__tw_route", "__tw_log", "__tw_now"]
    .forEach(function (k) { delete globalThis[k]; });
  var json = function (v) { var s = JSON.stringify(v === undefined ? null : v); return s === undefined ? "null" : s; };
  var routes = [];
  var log = function () { h.log(Array.prototype.map.call(arguments, String).join(" ")); };
  globalThis.hq = Object.freeze({
    send: function (id, msg) { return h.send(id, json(msg)); },
    broadcast: function (msg) { return h.broadcast(json(msg)); },
    players: function () { return JSON.parse(h.players()); },
    kv: Object.freeze({
      get: function (k) { return h.get(String(k)); },
      set: function (k, v) { h.set(String(k), v); },
      delete: function (k) { h.del(String(k)); },
    }),
    route: function (method, path, fn, opts) {
      if (typeof fn !== "function") throw new TypeError("hq.route: the handler must be a function");
      h.route(String(method), String(path), !!(opts && opts.token), routes.length);
      routes.push(fn);
    },
    log: log,
    now: function () { return h.now(); },
  });
  globalThis.console = Object.freeze({ log: log, info: log, warn: log, error: log });
  // the host's view of the module and its async work, kept in this closure
  var stringify = JSON.stringify, parse = JSON.parse, keys = Object.keys;
  var asyncError = "", reply = "";
  var thenable = function (r) { return r !== null && (typeof r === "object" || typeof r === "function") && typeof r.then === "function"; };
  var describe = function (e) { return e instanceof Error ? e.name + ": " + e.message : "uncaught " + String(e); };
  globalThis.__exports = function () {
    return stringify(typeof __plugin === "object" && __plugin !== null ? keys(__plugin) : []);
  };
  globalThis.__call = function (name, args) {
    var m = typeof __plugin === "object" && __plugin !== null ? __plugin : {};
    var f = m[name];
    if (typeof f !== "function") return;
    var r = f.apply(undefined, parse(args));
    if (thenable(r)) r.then(undefined, function (e) { if (!asyncError) asyncError = "in " + name + ": " + describe(e); });
  };
  globalThis.__asyncError = function () { var e = asyncError; asyncError = ""; return e; };
  var format = function (r) {
    if (r === undefined || r === null) r = {};
    var b = r.body;
    return stringify({ s: typeof r.status === "number" ? r.status : 200, t: typeof b === "string" ? 1 : 0, b: b === undefined ? null : b });
  };
  globalThis.__route = function (id, req) {
    reply = "";
    var r = routes[id](parse(req));
    if (thenable(r)) r.then(function (v) { reply = format(v); }, function (e) { asyncError = describe(e); });
    else reply = format(r);
  };
  globalThis.__reply = function () { var r = reply; reply = ""; if (!r) throw new Error("the route handler did not answer"); return r; };
})();
`

// install registers the host functions and runs the prelude.
func (in *instance) install() error {
	fns := map[string]quickjs.HostFunc{
		"__tw_send":      in.jsSend,
		"__tw_broadcast": in.jsBroadcast,
		"__tw_players":   in.jsPlayers,
		"__tw_kv_get":    in.jsKVGet,
		"__tw_kv_set":    in.jsKVSet,
		"__tw_kv_delete": in.jsKVDelete,
		"__tw_route":     in.jsRoute,
		"__tw_log":       in.jsLog,
		"__tw_now":       func([]any) (any, error) { return time.Since(in.started).Seconds(), nil },
	}
	for name, f := range fns {
		if err := in.vm.RegisterHostFunc(name, f); err != nil {
			return err
		}
	}
	_, err := in.vm.Eval(prelude, quickjs.EvalGlobal)
	return err
}

func arg(a []any, i int) any {
	if i < len(a) {
		return a[i]
	}
	return nil
}

func argString(a []any, i int) (string, bool) {
	s, ok := arg(a, i).(string)
	return s, ok
}

func argID(a []any, i int) (uint32, bool) {
	switch v := arg(a, i).(type) {
	case int:
		return uint32(v), v > 0
	case float64:
		return uint32(v), v > 0 && v == float64(uint32(v))
	}
	return 0, false
}

// frame wraps an encoded message as {"t":"plg","pl":<name>,"d":<d>}.
func (in *instance) frame(d string) ([]byte, error) {
	if len(d) > maxSendBytes {
		return nil, fmt.Errorf("message of %d bytes is over the %d-byte limit", len(d), maxSendBytes)
	}
	if !json.Valid([]byte(d)) { // the plugin can replace JSON.stringify: never paste anything but JSON into a frame
		return nil, errors.New("the message is not valid JSON")
	}
	b := make([]byte, 0, len(d)+len(in.info.Name)+24)
	b = append(b, `{"t":"plg","pl":"`...)
	b = append(b, in.info.Name...)
	b = append(b, `","d":`...)
	b = append(b, d...)
	return append(b, '}'), nil
}

func (in *instance) jsSend(a []any) (any, error) {
	id, ok := argID(a, 0)
	if !ok {
		return nil, errors.New("hq.send: the first argument is a member id")
	}
	d, _ := argString(a, 1)
	f, err := in.frame(d)
	if err != nil {
		return nil, fmt.Errorf("hq.send: %v", err)
	}
	if !in.online(id) {
		return false, nil
	}
	if !in.h.spend([]uint32{id}) {
		in.overBudget()
		return false, nil
	}
	if !in.h.sink.Deliver(id, f) {
		in.dropped.Add(1)
	}
	return true, nil
}

func (in *instance) jsBroadcast(a []any) (any, error) {
	d, _ := argString(a, 0)
	f, err := in.frame(d)
	if err != nil {
		return nil, fmt.Errorf("hq.broadcast: %v", err)
	}
	ids := make([]uint32, len(in.players))
	for i, p := range in.players {
		ids[i] = p.ID
	}
	if len(ids) == 0 {
		return true, nil
	}
	if !in.h.spend(ids) {
		in.overBudget()
		return false, nil
	}
	if !in.h.sink.Deliver(0, f) {
		in.dropped.Add(1)
	}
	return true, nil
}

// overBudget counts a message refused by the send budget; logged at most every 10 s per plugin.
func (in *instance) overBudget() {
	in.dropped.Add(1)
	if now := time.Now(); now.Sub(in.budgetLog) > 10*time.Second {
		in.budgetLog = now
		in.h.log.Warn("plugin over its send budget: messages dropped", "plugin", in.info.Name, "dropped", in.dropped.Load())
	}
}

func (in *instance) jsPlayers([]any) (any, error) {
	out := make([]playerJSON, len(in.players))
	for i, p := range in.players {
		out[i] = jsPlayer(p)
	}
	b, err := json.Marshal(out)
	return string(b), err
}

func (in *instance) jsRoute(a []any) (any, error) {
	method, _ := argString(a, 0)
	path, _ := argString(a, 1)
	token, _ := arg(a, 2).(bool)
	id, _ := arg(a, 3).(int)
	if token && !in.info.AppTokens {
		return nil, errors.New(`a route with { token: true } needs "appTokens": true in plugin.json`)
	}
	if !in.loading {
		return nil, errors.New("hq.route is only allowed in load()")
	}
	if method != "GET" && method != "POST" {
		return nil, errors.New("hq.route: the method must be GET or POST")
	}
	if !strings.HasPrefix(path, "/") || len(path) > 64 || strings.ContainsAny(path, "?#{}\\ ") || strings.Contains(path, "..") {
		return nil, fmt.Errorf("hq.route: path %q must be a fixed path starting with /", path)
	}
	in.routes[method+" "+path] = route{id, token}
	return nil, nil
}

func (in *instance) jsLog(a []any) (any, error) {
	s, _ := argString(a, 0)
	in.h.log.Info("plugin log", "plugin", in.info.Name, "msg", clip(s, 2000))
	return nil, nil
}

func (in *instance) jsKVGet(a []any) (any, error) {
	k, _ := argString(a, 0)
	if v, ok := in.kv[k]; ok {
		return v, nil
	}
	return nil, nil
}

func (in *instance) jsKVSet(a []any) (any, error) {
	k, _ := argString(a, 0)
	v, ok := argString(a, 1)
	if !ok {
		return nil, errors.New("hq.kv.set: the value must be a string (use JSON.stringify for objects)")
	}
	if len(k) == 0 || len(k) > maxKeyBytes {
		return nil, fmt.Errorf("hq.kv.set: keys are 1 to %d bytes", maxKeyBytes)
	}
	if len(v) > maxValueBytes {
		return nil, fmt.Errorf("hq.kv.set: values are at most %d bytes", maxValueBytes)
	}
	if _, exists := in.kv[k]; !exists && len(in.kv) >= maxKeys {
		return nil, fmt.Errorf("hq.kv.set: at most %d keys per plugin", maxKeys)
	}
	if err := in.h.kv.Set(in.info.Name, k, v); err != nil {
		return nil, fmt.Errorf("hq.kv.set: %v", err)
	}
	in.kv[k] = v
	return nil, nil
}

func (in *instance) jsKVDelete(a []any) (any, error) {
	k, _ := argString(a, 0)
	if _, ok := in.kv[k]; !ok {
		return nil, nil
	}
	if err := in.h.kv.Delete(in.info.Name, k); err != nil {
		return nil, fmt.Errorf("hq.kv.delete: %v", err)
	}
	delete(in.kv, k)
	return nil, nil
}

// MaxReplyBytes bounds a route's reply body.
const MaxReplyBytes = 1 << 20

// clip shortens s to at most n bytes without cutting a character in two.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
