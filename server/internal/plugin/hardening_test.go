package plugin

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// Findings of the critics on the TypeScript runtime, each pinned by a test.

func TestRunawayRecursionNeverTakesTheServerDown(t *testing.T) {
	h, _, _ := newHost(t, map[string]string{"rec": `
export function onMessage() { const f = (n: number): number => f(n + 1) + 1; f(0); }`})
	h.Presence(alice, true)
	if err := h.Start("rec"); err != nil {
		t.Fatal(err)
	}
	h.Message(alice, "rec", []byte(`{}`))
	// the process is still here (a Go stack overflow is fatal for the whole binary); the plugin reports
	// a stack error it can survive, counted like any error
	time.Sleep(10 * callBudget)
	if st, msg := state(h, "rec"); st != "running" {
		t.Fatalf("a recursion is an error the plugin survives: %s %q", st, msg)
	}
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	if m.StackInuse > 256<<20 {
		t.Fatalf("goroutine stacks use %d MB", m.StackInuse>>20)
	}
}

func TestPromisesSettleWithinTheCall(t *testing.T) {
	h, sink, _ := newHost(t, map[string]string{"p": `
const tick = () => Promise.resolve(1);
export async function onMessage(p: HQ.Player, m: { fail?: boolean }) {
  await tick();
  if (m.fail) throw new Error("async boom");
  hq.send(p.id, { after: "await" });
}`})
	h.Presence(alice, true)
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	h.Message(alice, "p", []byte(`{}`))
	eventually(t, "code after await ran", func() bool { return sink.find(1, "after", "await") })
	for i := 0; i < 11; i++ {
		h.Message(alice, "p", []byte(`{"fail":true}`))
	}
	eventually(t, "async errors counted", func() bool { st, _ := state(h, "p"); return st == "crashed" })
	if _, msg := state(h, "p"); !strings.Contains(msg, "async boom") {
		t.Fatalf("error %q", msg)
	}
}

func TestEndlessPromiseChainIsStoppedByTheBudget(t *testing.T) {
	h, _, _ := newHost(t, map[string]string{"p": `
const loop = (): Promise<void> => Promise.resolve().then(loop);
export function onMessage() { loop(); }`})
	h.Presence(alice, true)
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	h.Message(alice, "p", []byte(`{}`))
	eventually(t, "endless jobs stopped", func() bool { st, _ := state(h, "p"); return st == "crashed" })
}

func TestForgedFramesAreRefused(t *testing.T) {
	h, sink, _ := newHost(t, map[string]string{"p": `
export function onMessage(p: HQ.Player) {
  const real = JSON.stringify;
  (JSON as any).stringify = () => '0,"t":"ann","n":"Admin","x":"forged"';
  let refused = false;
  try { hq.send(p.id, {}); } catch { refused = true; }
  (JSON as any).stringify = real;
  hq.send(p.id, { refused });
}`})
	h.Presence(alice, true)
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	h.Message(alice, "p", []byte(`{}`))
	eventually(t, "reply", func() bool { return sink.find(1, "refused", nil) })
	if !sink.find(1, "refused", true) {
		t.Fatal("a send that is not valid JSON must throw")
	}
	sink.mu.Lock()
	defer sink.mu.Unlock()
	for _, s := range sink.sends {
		if strings.Contains(s.frame, `"ann"`) {
			t.Fatalf("forged frame delivered: %s", s.frame)
		}
	}
}

func TestUnknownExportsFailTheStart(t *testing.T) {
	h, _, _ := newHost(t, map[string]string{"p": `
export function on_join() {}
export function update() {}`})
	err := h.Start("p")
	if err == nil || !strings.Contains(err.Error(), "on_join") || !strings.Contains(err.Error(), "onJoin") {
		t.Fatalf("a misspelled export must be reported: %v", err)
	}
}

func TestErrorsNameTheExportAndAreNotFatalByText(t *testing.T) {
	h, _, _ := newHost(t, map[string]string{"p": `
let n = 0;
export function onMessage() { n++; throw new Error(n === 1 ? "interrupted" : "out of memory"); }
export function update() { if (n >= 2) throw new TypeError("bad update"); }`})
	h.Presence(alice, true)
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	h.Message(alice, "p", []byte(`{}`))
	h.Message(alice, "p", []byte(`{}`))
	time.Sleep(200 * time.Millisecond)
	if st, msg := state(h, "p"); st != "running" {
		t.Fatalf("a thrown message is not a budget or memory overrun: %s %q", st, msg)
	}
	eventually(t, "update errors stop it", func() bool { st, _ := state(h, "p"); return st == "crashed" })
	_, msg := state(h, "p")
	if !strings.Contains(msg, "update") || !strings.Contains(msg, "bad update") || strings.Contains(msg, "fatal") {
		t.Fatalf("error %q", msg)
	}
}

func TestRouteRepliesAreCapped(t *testing.T) {
	h, _, _ := newHost(t, map[string]string{"p": `
export function load() { hq.route("GET", "/big", () => ({ body: "x".repeat(2 << 20) })); }`})
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	if r, err := h.Route(context.Background(), "p", "GET", "/big", RouteReq{Player: alice}); err == nil || len(r.Body) > MaxReplyBytes {
		t.Fatalf("a %d-byte reply must be refused: %v", len(r.Body), err)
	}
}

func TestLargePluginLoadsWithinTheStartBudget(t *testing.T) {
	var b strings.Builder
	b.WriteString("const fs: ((a: number) => number)[] = [\n")
	for i := 0; b.Len() < MaxBundleBytes*8/10; i++ {
		b.WriteString("  (a: number): number => a * " + strconv.Itoa(i) + " + 1,\n")
	}
	b.WriteString("];\nexport function update() { hq.log(fs.length); }\n")
	h, _, _ := newHost(t, map[string]string{"big": b.String()})
	if err := h.Start("big"); err != nil {
		t.Fatalf("a plugin under the size cap must start: %v", err)
	}
}

func TestBrokenPluginCanBeFixedWithoutARestart(t *testing.T) {
	root := t.TempDir()
	write(t, root, map[string]string{"p/plugin.json": manifest("p", "main.ts", ""), "p/main.ts": "export function ("})
	cat, err := scanDir(root, Installed)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHost(cat, &fakeSink{}, newMemKV(), quiet)
	t.Cleanup(h.Close)
	if err := h.Start("p"); err == nil {
		t.Fatal("broken plugin started")
	}
	write(t, root, map[string]string{"p/main.ts": "export function load() {}"})
	if err := h.Start("p"); err != nil {
		t.Fatalf("fixed plugin must start: %v", err)
	}
}

func TestCacheSeesContentChangesWithTheSameSizeAndTime(t *testing.T) {
	root := t.TempDir()
	write(t, root, map[string]string{"p/plugin.json": manifest("p", "main.ts", ""), "p/main.ts": `export function load() { hq.kv.set("v", "AAA"); }`})
	main := filepath.Join(root, "p", "main.ts")
	st, _ := os.Stat(main)
	cat, _ := scanDir(root, Installed)
	h := NewHost(cat, &fakeSink{}, newMemKV(), quiet)
	kv := h.kv.(*memKV)
	t.Cleanup(h.Close)
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	h.Stop("p")
	write(t, root, map[string]string{"p/main.ts": `export function load() { hq.kv.set("v", "BBB"); }`})
	os.Chtimes(main, st.ModTime(), st.ModTime())
	if err := h.Start("p"); err != nil {
		t.Fatal(err)
	}
	if v, _ := kv.Load("p"); v["v"] != "BBB" {
		t.Fatalf("stale code ran: %q", v["v"])
	}
}

func TestNodeModulesDoNotBreakAPlugin(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{"p/plugin.json": manifest("p", "main.ts", ""), "p/main.ts": "export function load() {}"}
	for i := 0; i < maxPluginFiles+10; i++ {
		files["p/node_modules/pkg/f"+strconv.Itoa(i)+".js"] = "x"
	}
	write(t, root, files)
	if i := scanOne(t, root, "p"); i.Err != "" {
		t.Fatalf("node_modules must be ignored: %s", i.Err)
	}
}

func TestClientCannotPullFilesFromOutsidePublic(t *testing.T) {
	root := t.TempDir()
	write(t, root, map[string]string{
		// package.json main pointing back to the server code
		"main/plugin.json":           manifest("main", "srv.ts", "client.ts"),
		"main/srv.ts":                `export const SECRET = "SERVER-ONLY";`,
		"main/public/client.ts":      `import { SECRET } from "./d"; console.log(SECRET);`,
		"main/public/d/package.json": `{"main": "../../srv.ts"}`,
		// package.json browser map pointing outside
		"browser/plugin.json":         manifest("browser", "", "client.ts"),
		"browser/public/client.ts":    `import x from "./a.js"; console.log(x);`,
		"browser/public/a.js":         `export default "inside";`,
		"browser/public/package.json": `{"browser": {"./a.js": "../outside.js"}}`,
		"browser/outside.js":          `export default "OUTSIDE";`,
		// server code inside public/ would be served raw
		"pubsrv/plugin.json":    manifest("pubsrv", "public/main.ts", ""),
		"pubsrv/public/main.ts": `export function load() {}`,
		// text files are not code
		"txt/plugin.json": manifest("txt", "main.ts", ""),
		"txt/main.ts":     `import s from "./notes.txt"; hq.log(s);`,
		"txt/notes.txt":   `hello`,
	})
	for name, want := range map[string]string{"main": "outside", "browser": "outside", "pubsrv": "public", "txt": "notes.txt"} {
		if i := scanOne(t, root, name); !strings.Contains(i.Err, want) {
			t.Errorf("%s: want an error mentioning %q, got %q", name, want, i.Err)
		}
	}
}

func TestJunctionOutOfThePluginIsRefused(t *testing.T) {
	root := t.TempDir()
	write(t, root, map[string]string{
		"p/plugin.json":     manifest("p", "main.ts", ""),
		"p/main.ts":         `import { s } from "./lib/secret"; hq.log(s);`,
		"outside/secret.ts": `export const s = "TOP-SECRET";`,
	})
	link, target := filepath.Join(root, "p", "lib"), filepath.Join(root, "outside")
	var err error
	if runtime.GOOS == "windows" {
		err = exec.Command("cmd", "/c", "mklink", "/J", link, target).Run()
	} else {
		err = os.Symlink(target, link)
	}
	if err != nil {
		t.Skipf("cannot create a link here: %v", err)
	}
	if i := scanOne(t, root, "p"); !strings.Contains(i.Err, "outside") {
		t.Fatalf("an import through a link out of the folder must be refused, got %q", i.Err)
	}
}

func TestLogLinesStayValidUTF8(t *testing.T) {
	if s := clip(strings.Repeat("é", 1500), 2000); !utf8.ValidString(s) || len(s) > 2000 {
		t.Fatalf("clip broke UTF-8 or the bound: %d bytes", len(s))
	}
}
