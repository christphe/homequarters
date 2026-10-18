// Spike: the sample plugin's server side on two runtimes, gopher-lua (today) and QuickJS (pure Go,
// modernc.org/quickjs) running TypeScript compiled by esbuild. Same logic, same minimal tw API, same
// workload. Throwaway: it decides whether plugins move from Lua to TypeScript (docs/plugin-runtime.md).
//
//	go run . -rt lua|js [-n instances] [-members 50] [-ticks 2000]
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"math/rand"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/evanw/esbuild/pkg/api"
	lua "github.com/yuin/gopher-lua"
	"modernc.org/quickjs"
)

type player struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

// plugin is what the host needs from a runtime.
type plugin interface {
	join(p player) error
	message(p player, msg []byte) error
	update(dt float64) error
	close()
}

var sink int // bytes "sent", so nothing is optimised away

func main() {
	rt := flag.String("rt", "lua", "lua or js")
	n := flag.Int("n", 20, "instances kept alive for the memory measure")
	members := flag.Int("members", 50, "members online")
	ticks := flag.Int("ticks", 2000, "updates measured")
	flag.Parse()

	newPlugin := func() (plugin, error) {
		if *rt == "lua" {
			src, err := os.ReadFile("sample.lua") // the sample plugin as it was in Lua (commit 226a404)
			if err != nil {
				return nil, err
			}
			return newLua(string(src))
		}
		return newJS("sample.ts")
	}

	// compile + start + joins
	runtime.GC()
	t0 := time.Now()
	p, err := newPlugin()
	if err != nil {
		fmt.Println("start:", err)
		os.Exit(1)
	}
	startup := time.Since(t0)
	t1 := time.Now()
	for i := 1; i <= *members; i++ {
		must(p.join(player{i, "m" + strconv.Itoa(i), "member"}))
	}
	joins := time.Since(t1)

	// steady state: per tick, 5 members change something, then update broadcasts
	msgs := [][]byte{[]byte(`{"t":"variant","v":2}`), []byte(`{"t":"shown","on":false}`), []byte(`{"t":"mode","m":"wander"}`),
		[]byte(`{"t":"wander","x":120,"y":340}`), []byte(`{"t":"shown","on":true}`), []byte(`{"t":"variant","v":1}`)}
	lat := make([]time.Duration, 0, *ticks)
	loop := time.Now()
	for i := 0; i < 200; i++ { // warm up
		must(p.message(player{1 + i%*members, "m", "member"}, msgs[i%len(msgs)]))
		must(p.update(0.1))
	}
	for i := 0; i < *ticks; i++ {
		s := time.Now()
		for k := 0; k < 5; k++ {
			id := 1 + (i*5+k)%*members
			must(p.message(player{id, "m", "member"}, msgs[(i+k)%len(msgs)]))
		}
		must(p.update(0.1))
		lat = append(lat, time.Since(s))
	}
	mean := time.Since(loop) / time.Duration(*ticks)
	sort.Slice(lat, func(a, b int) bool { return lat[a] < lat[b] })
	p.close()

	// memory: n live instances with members joined
	runtime.GC()
	before := workingSet()
	live := make([]plugin, 0, *n)
	for i := 0; i < *n; i++ {
		q, err := newPlugin()
		must(err)
		for j := 1; j <= *members; j++ {
			must(q.join(player{j, "m", "member"}))
		}
		must(q.update(0.1))
		live = append(live, q)
	}
	runtime.GC()
	after := workingSet()
	for _, q := range live {
		q.close()
	}

	fmt.Printf("runtime %s, %s/%s, %s\n", *rt, runtime.GOOS, runtime.GOARCH, runtime.Version())
	fmt.Printf("start (compile + load): %v; %d joins: %v\n", startup.Round(time.Microsecond), *members, joins.Round(time.Microsecond))
	fmt.Printf("tick (5 messages + update + broadcast, %d members), %d ticks: mean %v, max %v (timer granularity ~0.5 ms on Windows)\n", *members, *ticks,
		mean, lat[len(lat)-1])
	fmt.Printf("memory: %d instances = %.1f MB working set, %.2f MB each\n", *n, float64(after-before)/1e6, float64(after-before)/1e6/float64(*n))
	fmt.Printf("runaway loop stopped after: %v\n", runaway(*rt))
	fmt.Printf("memory cap: %s\n", memcap(*rt))
	_ = sink
}

func must(err error) {
	if err != nil {
		fmt.Println("error:", err)
		os.Exit(1)
	}
}

// ---- gopher-lua -----------------------------------------------------------------------------

type luaPlugin struct {
	L  *lua.LState
	kv map[string]string
	t0 time.Time
}

func newLua(src string) (*luaPlugin, error) {
	p := &luaPlugin{kv: map[string]string{}, t0: time.Now()}
	L := lua.NewState(lua.Options{SkipOpenLibs: true, CallStackSize: 200, MinimizeStackMemory: true})
	for _, lib := range []struct {
		n string
		f lua.LGFunction
	}{{lua.BaseLibName, lua.OpenBase}, {lua.TabLibName, lua.OpenTable}, {lua.StringLibName, lua.OpenString}, {lua.MathLibName, lua.OpenMath}} {
		L.Push(L.NewFunction(lib.f))
		L.Push(lua.LString(lib.n))
		L.Call(1, 0)
	}
	tw := L.NewTable()
	kv := L.NewTable()
	kv.RawSetString("get", L.NewFunction(func(L *lua.LState) int {
		if v, ok := p.kv[L.CheckString(1)]; ok {
			L.Push(lua.LString(v))
		} else {
			L.Push(lua.LNil)
		}
		return 1
	}))
	kv.RawSetString("set", L.NewFunction(func(L *lua.LState) int { p.kv[L.CheckString(1)] = L.CheckString(2); return 0 }))
	tw.RawSetString("kv", kv)
	send := func(L *lua.LState, i int) int {
		var b bytes.Buffer
		luaJSON(&b, L.Get(i))
		sink += b.Len()
		L.Push(lua.LTrue)
		return 1
	}
	tw.RawSetString("broadcast", L.NewFunction(func(L *lua.LState) int { return send(L, 1) }))
	tw.RawSetString("send", L.NewFunction(func(L *lua.LState) int { return send(L, 2) }))
	tw.RawSetString("now", L.NewFunction(func(L *lua.LState) int { L.Push(lua.LNumber(time.Since(p.t0).Seconds())); return 1 }))
	L.SetGlobal("tw", tw)
	if err := L.DoString(src); err != nil {
		return nil, err
	}
	p.L = L
	return p, nil
}

func (p *luaPlugin) call(name string, args ...lua.LValue) error {
	fn, ok := p.L.GetGlobal(name).(*lua.LFunction)
	if !ok {
		return nil
	}
	return p.L.CallByParam(lua.P{Fn: fn, Protect: true}, args...)
}

func (p *luaPlugin) ptable(pl player) *lua.LTable {
	t := p.L.NewTable()
	t.RawSetString("id", lua.LNumber(pl.ID))
	t.RawSetString("name", lua.LString(pl.Name))
	t.RawSetString("role", lua.LString(pl.Role))
	return t
}

func (p *luaPlugin) join(pl player) error { return p.call("on_join", p.ptable(pl)) }
func (p *luaPlugin) message(pl player, msg []byte) error {
	var v any
	if err := json.Unmarshal(msg, &v); err != nil {
		return err
	}
	return p.call("on_message", p.ptable(pl), toLua(p.L, v))
}
func (p *luaPlugin) update(dt float64) error { return p.call("update", lua.LNumber(dt)) }
func (p *luaPlugin) close()                  { p.L.Close() }

func toLua(L *lua.LState, v any) lua.LValue {
	switch x := v.(type) {
	case bool:
		return lua.LBool(x)
	case float64:
		return lua.LNumber(x)
	case string:
		return lua.LString(x)
	case []any:
		t := L.NewTable()
		for _, e := range x {
			t.Append(toLua(L, e))
		}
		return t
	case map[string]any:
		t := L.NewTable()
		for k, e := range x {
			t.RawSetString(k, toLua(L, e))
		}
		return t
	}
	return lua.LNil
}

func luaJSON(b *bytes.Buffer, v lua.LValue) {
	switch x := v.(type) {
	case lua.LBool:
		b.WriteString(strconv.FormatBool(bool(x)))
	case lua.LNumber:
		f := float64(x)
		if f == math.Trunc(f) {
			b.WriteString(strconv.FormatInt(int64(f), 10))
		} else {
			b.WriteString(strconv.FormatFloat(f, 'g', -1, 64))
		}
	case lua.LString:
		s, _ := json.Marshal(string(x))
		b.Write(s)
	case *lua.LTable:
		if n := x.MaxN(); n > 0 {
			b.WriteByte('[')
			for i := 1; i <= n; i++ {
				if i > 1 {
					b.WriteByte(',')
				}
				luaJSON(b, x.RawGetInt(i))
			}
			b.WriteByte(']')
			return
		}
		b.WriteByte('{')
		first := true
		x.ForEach(func(k, e lua.LValue) {
			if !first {
				b.WriteByte(',')
			}
			first = false
			s, _ := json.Marshal(k.String())
			b.Write(s)
			b.WriteByte(':')
			luaJSON(b, e)
		})
		b.WriteByte('}')
	default:
		b.WriteString("null")
	}
}

// ---- QuickJS + esbuild ----------------------------------------------------------------------

type jsPlugin struct {
	vm *quickjs.VM
	kv map[string]string
	t0 time.Time
}

// glue turns the compiled module's exports into globals the host calls, and builds tw.
const glue = `
var tw = {
  kv: { get: (k) => __kv_get(k), set: (k, v) => __kv_set(k, v) },
  broadcast: (m) => __out(JSON.stringify(m)),
  send: (id, m) => __out(JSON.stringify(m)),
  now: () => __now(),
};
function __join(p) { plugin.on_join(p); }
function __msg(p, s) { plugin.on_message(p, JSON.parse(s)); }
function __update(dt) { plugin.update(dt); }
`

func compileTS(path string) (string, error) {
	r := api.Build(api.BuildOptions{EntryPoints: []string{path}, Bundle: true, Format: api.FormatIIFE, GlobalName: "plugin", Target: api.ES2020, Write: false})
	if len(r.Errors) > 0 {
		return "", fmt.Errorf("esbuild: %s", r.Errors[0].Text)
	}
	return string(r.OutputFiles[0].Contents), nil
}

func newJS(path string) (*jsPlugin, error) {
	js, err := compileTS(path)
	if err != nil {
		return nil, err
	}
	vm, err := quickjs.NewVM()
	if err != nil {
		return nil, err
	}
	p := &jsPlugin{vm: vm, kv: map[string]string{}, t0: time.Now()}
	vm.SetMemoryLimit(16 << 20)
	vm.SetEvalTimeout(50 * time.Millisecond)
	reg := func(name string, f quickjs.HostFunc) { must(vm.RegisterHostFunc(name, f)) }
	reg("__kv_get", func(a []any) (any, error) {
		if v, ok := p.kv[fmt.Sprint(a[0])]; ok {
			return v, nil
		}
		return nil, nil
	})
	reg("__kv_set", func(a []any) (any, error) { p.kv[fmt.Sprint(a[0])] = fmt.Sprint(a[1]); return nil, nil })
	reg("__out", func(a []any) (any, error) { sink += len(fmt.Sprint(a[0])); return true, nil })
	reg("__now", func(a []any) (any, error) { return time.Since(p.t0).Seconds(), nil })
	if _, err := vm.Eval(js+glue, quickjs.EvalGlobal); err != nil {
		vm.Close()
		return nil, err
	}
	return p, nil
}

func (p *jsPlugin) join(pl player) error {
	_, err := p.vm.Call("__join", pl)
	return err
}
func (p *jsPlugin) message(pl player, msg []byte) error {
	_, err := p.vm.Call("__msg", pl, string(msg))
	return err
}
func (p *jsPlugin) update(dt float64) error {
	_, err := p.vm.Call("__update", dt)
	return err
}
func (p *jsPlugin) close() { p.vm.Close() }

// ---- limits ---------------------------------------------------------------------------------

func runaway(rt string) string {
	t0 := time.Now()
	var err error
	if rt == "lua" {
		p, _ := newLua("function update() while true do end end")
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		p.L.SetContext(ctx)
		err = p.update(0.1)
		cancel()
		p.close()
	} else {
		vm, _ := quickjs.NewVM()
		vm.SetEvalTimeout(50 * time.Millisecond)
		_, err = vm.Eval("for (;;) {}", quickjs.EvalGlobal)
		vm.Close()
	}
	if err == nil {
		return "NOT stopped"
	}
	return time.Since(t0).Round(time.Millisecond).String()
}

func memcap(rt string) string {
	if rt == "lua" {
		return "none (gopher-lua cannot cap its heap)"
	}
	vm, _ := quickjs.NewVM()
	defer vm.Close()
	vm.SetMemoryLimit(16 << 20)
	_, err := vm.Eval("var a = []; for (;;) a.push(new Array(1000).fill(1));", quickjs.EvalGlobal)
	if err == nil {
		return "NOT enforced"
	}
	return "16 MB cap enforced: " + strings.SplitN(err.Error(), "\n", 2)[0]
}

// ---- process memory (Windows) ---------------------------------------------------------------

type memCounters struct {
	cb                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

func workingSet() uint64 {
	if runtime.GOOS != "windows" {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		return m.Sys
	}
	psapi := syscall.NewLazyDLL("psapi.dll")
	proc := psapi.NewProc("GetProcessMemoryInfo")
	h, _ := syscall.GetCurrentProcess()
	var c memCounters
	c.cb = uint32(unsafe.Sizeof(c))
	proc.Call(uintptr(h), uintptr(unsafe.Pointer(&c)), uintptr(c.cb))
	return uint64(c.WorkingSetSize)
}

var _ = rand.Int
