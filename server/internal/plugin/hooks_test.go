package plugin

import (
	"context"
	"strings"
	"testing"
	"time"
)

// Two plugins: "pets" exposes hooks, "caller" calls them when a member sends it a message and
// broadcasts what came back, so the test reads every outcome from the sink.
const hookCallee = `
export function load() {
  hq.expose("add", (c: HQ.Caller, a: { x: number }) => ({ from: c.plugin, member: c.member, y: a.x + 1 }));
  hq.expose("later", async (c: HQ.Caller, a: { x: number }) => a.x * 2);
  hq.expose("fail", () => { throw new Error("nope"); });
  hq.expose("big", () => "x".repeat(5000));
  hq.expose("slow", () => { const t0 = hq.now(); while (hq.now() - t0 < 0.03) {} return 1; });
}`

const hookCaller = `
export async function onMessage(p: HQ.Player, m: { plugin: string; hook: string; args: unknown }) {
  try {
    const v = await hq.plugins.call(m.plugin, m.hook, m.args);
    hq.broadcast({ hook: m.hook, ok: true, v });
  } catch (e) {
    hq.broadcast({ hook: m.hook, ok: false, err: String(e) });
  }
}`

func hookOutcome(t *testing.T, sink *fakeSink, hook string) map[string]any {
	t.Helper()
	var got map[string]any
	eventually(t, "the answer of "+hook, func() bool {
		for _, d := range sink.data(0) {
			if d["hook"] == hook {
				got = d
				return true
			}
		}
		return false
	})
	return got
}

func TestHooksBetweenPlugins(t *testing.T) {
	h, sink, _ := newHost(t, map[string]string{"pets": hookCallee, "caller": hookCaller, "off": hookCallee})
	h.Presence(alice, true)
	for _, p := range []string{"pets", "caller"} {
		if err := h.Start(p); err != nil {
			t.Fatal(p, err)
		}
	}
	call := func(plugin, hook, args string) map[string]any {
		h.Message(alice, "caller", []byte(`{"plugin":"`+plugin+`","hook":"`+hook+`","args":`+args+`}`))
		return hookOutcome(t, sink, hook)
	}
	if got := call("pets", "add", `{"x":41}`); got["ok"] != true || got["v"].(map[string]any)["y"] != 42.0 || got["v"].(map[string]any)["from"] != "caller" ||
		got["v"].(map[string]any)["member"] != float64(alice.ID) {
		t.Fatalf("a hook answers, and knows which plugin called for which member (the one whose message it handled): %v", got)
	}
	if got := call("pets", "later", `{"x":21}`); got["ok"] != true || got["v"] != 42.0 {
		t.Fatalf("an async hook answers: %v", got)
	}
	for hook, want := range map[string]string{"nothere": "no such hook", "fail": "nope", "big": "over the 4096-byte limit"} {
		if got := call("pets", hook, `{}`); got["ok"] != false || !strings.Contains(got["err"].(string), want) {
			t.Fatalf("%s: want an error with %q, got %v", hook, want, got)
		}
	}
	h.Message(alice, "caller", []byte(`{"plugin":"off","hook":"nothere2","args":{}}`))
	if got := hookOutcome(t, sink, "nothere2"); got["ok"] != false || !strings.Contains(got["err"].(string), "not running") {
		t.Fatalf("a plugin that is off: %v", got)
	}
	for _, p := range []string{"pets", "caller"} {
		if st, msg := state(h, p); st != "running" {
			t.Fatalf("%s is %s: %s", p, st, msg)
		}
	}
}

func TestHookTimesOut(t *testing.T) {
	old := hookWait
	hookWait = 5 * time.Millisecond
	t.Cleanup(func() { hookWait = old })
	h, sink, _ := newHost(t, map[string]string{"pets": hookCallee, "caller": hookCaller})
	h.Presence(alice, true)
	for _, p := range []string{"pets", "caller"} {
		if err := h.Start(p); err != nil {
			t.Fatal(err)
		}
	}
	h.Message(alice, "caller", []byte(`{"plugin":"pets","hook":"slow","args":{}}`))
	if got := hookOutcome(t, sink, "slow"); got["ok"] != false || !strings.Contains(got["err"].(string), "in time") {
		t.Fatalf("a hook slower than the wait is a timeout for the caller: %v", got)
	}
}

func TestHookRules(t *testing.T) {
	// refused when the plugin starts
	for name, src := range map[string]string{
		"bad name":     `export function load() { hq.expose("no-dashes", () => 1); }`,
		"too many":     `export function load() { for (let i = 0; i < 17; i++) hq.expose("h" + i, () => i); }`,
		"call in load": `export function load() { hq.plugins.call("other", "x", {}); }`,
	} {
		t.Run(name, func(t *testing.T) {
			h, _, _ := newHost(t, map[string]string{"p": src})
			if err := h.Start("p"); err == nil {
				t.Fatal("the plugin started")
			}
		})
	}
	// refused later, as an error the plugin can catch
	h, sink, _ := newHost(t, map[string]string{"p": `
export function onJoin() {
  const tries: [string, () => unknown][] = [
    ["late", () => hq.expose("late", () => 1)],
    ["self", () => hq.plugins.call("p", "x", {})],
    ["huge", () => hq.plugins.call("other", "x", "y".repeat(5000))],
  ];
  for (const [k, f] of tries) {
    try { f(); hq.broadcast({ k, err: "" }); } catch (e) { hq.broadcast({ k, err: String(e) }); }
  }
}`})
	h.Presence(alice, true)
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]string{"late": "only allowed in load", "self": "its own hooks", "huge": "4096-byte limit"} {
		eventually(t, k, func() bool {
			for _, d := range sink.data(0) {
				if d["k"] == k {
					if !strings.Contains(d["err"].(string), want) {
						t.Fatalf("%s: %v", k, d["err"])
					}
					return true
				}
			}
			return false
		})
	}
}

// A route (or a hook) that awaits another plugin's hook answers with it: it keeps settling the answers
// to its calls until it has its own.
func TestRouteAwaitsAHook(t *testing.T) {
	h, _, _ := newHost(t, map[string]string{"pets": hookCallee, "caller": `
export function load() {
  hq.route("GET", "/via", async () => ({ body: await hq.plugins.call("pets", "add", { x: 1 }) }));
  hq.expose("relay", async (c: HQ.Caller, a: { x: number }) => hq.plugins.call("pets", "later", a));
}`, "third": hookCaller})
	h.Presence(alice, true)
	for _, p := range []string{"pets", "caller", "third"} {
		if err := h.Start(p); err != nil {
			t.Fatal(p, err)
		}
	}
	resp, err := h.Route(context.Background(), "caller", "GET", "/via", RouteReq{Player: alice})
	if err != nil || resp.Status != 200 || !strings.Contains(string(resp.Body), `"y":2`) {
		t.Fatalf("route: %v %d %s", err, resp.Status, resp.Body)
	}
}
