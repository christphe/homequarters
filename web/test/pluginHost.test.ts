// @vitest-environment jsdom
// The page's side of a running plugin (web/src/plugins/host.ts, manager.ts): what it hands the plugin's hidden
// frame and the view of its modal, at what rate, and what it refuses, without a browser. The frames are jsdom
// iframes that run nothing: the test plays the plugin's SDK on the other end of each MessageChannel (a
// synchronous stand-in, so fake timers drive the update loop). The browser suite keeps what only a browser shows:
// the sandbox, the real SDK in a real frame, sprites drawn (plugins/e2e/plugin-host-e2e/host.ts).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PluginHost, type HostDeps } from "../src/plugins/host";
import { PluginManager } from "../src/plugins/manager";
import { frameHead } from "../src/plugins/frameDoc";
import { LIMITS } from "../src/plugins/commands";
import type { PluginLayer } from "../src/game/pluginLayer";
import type { PlacedObject } from "../src/game/pluginObjects";

/** One end of a MessageChannel that delivers at once, as a structured clone; what arrives before onmessage is set
 * waits for it, as on a real port. */
class Port {
  private handler: ((e: { data: unknown }) => void) | null = null;
  private queue: unknown[] = [];
  other!: Port;
  closed = false;
  get onmessage() {
    return this.handler;
  }
  set onmessage(f: ((e: { data: unknown }) => void) | null) {
    this.handler = f;
    const q = this.queue;
    this.queue = [];
    for (const d of q) f?.({ data: d });
  }
  postMessage(d: unknown) {
    if (this.closed || this.other.closed) return;
    const copy = structuredClone(d);
    if (this.other.handler) this.other.handler({ data: copy });
    else this.other.queue.push(copy);
  }
  close() {
    this.closed = true;
  }
}
class Channel {
  port1 = new Port();
  port2 = new Port();
  constructor() {
    this.port1.other = this.port2;
    this.port2.other = this.port1;
  }
}

type Msg = { t: string; [k: string]: unknown };

/** The fake layer: what the host asks of the PluginLayer, recorded. */
function fakeLayer() {
  return {
    added: [] as string[],
    dropped: [] as string[],
    applied: 0,
    addPlugin(name: string) { this.added.push(name); },
    dropPlugin(name: string) { this.dropped.push(name); },
    apply() { this.applied++; return null; },
    worldSnapshot() { return { me: 1, avatars: [] }; },
    sheetImage() { return null; },
    providerStarted() {},
    providerStopped() {},
    debug() { return null; },
    provider: null as unknown,
  };
}

/**
 * Connects a started host's hidden frame: says "hq-ready" from it, takes the port it is handed, and plays the
 * plugin's SDK on it (every message it gets is in `got`; it acks updates unless told not to).
 */
function connect(name: string, opts: { ack?: boolean } = {}) {
  const frame = document.querySelector<HTMLIFrameElement>(`iframe.plugin-frame[data-plugin="${name}"]`)!;
  let port: Port | null = null;
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(((_m: unknown, _o: unknown, transfer?: Port[]) => { port = transfer![0]; }) as never);
  const got: Msg[] = [];
  window.dispatchEvent(new MessageEvent("message", { data: "hq-ready", source: frame.contentWindow }));
  const p = port as Port | null;
  if (!p) throw new Error("the host handed no port");
  p.onmessage = (e) => {
    const m = e.data as Msg;
    got.push(m);
    if (m.t === "update" && opts.ack !== false) p.postMessage({ t: "ack" });
  };
  return { frame, port: p, got, cmds: (c: unknown[]) => p.postMessage({ t: "cmds", c }) };
}

/** A host with fake deps, started (its iframe in the document). */
function startHost(name = "ui-demo", views: string[] = ["echo"]) {
  const layer = fakeLayer();
  const sent: unknown[] = [];
  const stopped: string[] = [];
  const deps: HostDeps = {
    layer: layer as unknown as PluginLayer,
    send: (_p, d) => sent.push(d),
    uiChanged: () => {},
    stopped: (_p, reason) => stopped.push(reason),
    running: () => [name],
  };
  const h = new PluginHost(name, "UI demo", "/plugins/" + name + "/client.js", [], deps, views);
  h.start();
  return { h, layer, sent, stopped };
}

const orb = (x: number, y: number): PlacedObject => ({ kind: "orb", x, y, w: 1, h: 1, px: x * 16, py: y * 16 });

let warn: { mock: { calls: unknown[][] } };
beforeEach(() => {
  vi.stubGlobal("MessageChannel", Channel);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

test("on start the hidden frame is told load, then one init per object already placed and no destroy", () => {
  const { h } = startHost();
  h.setObjects([orb(10, 31)], [orb(10, 31)]);
  const p = connect("ui-demo");
  expect(p.got.map((m) => m.t)).toEqual(["load", "objs"]);
  expect(p.got[1]).toEqual({ t: "objs", init: [orb(10, 31)], destroy: [] });
});

test("a dynamic object rides on the updates, 10 a second; removed from the map, it is destroyed and its updates stop", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  const { h } = startHost();
  h.setObjects([orb(10, 31)], [orb(10, 31)]);
  const p = connect("ui-demo");
  vi.advanceTimersByTime(2000);
  const updates = p.got.filter((m) => m.t === "update");
  expect(updates.length).toBe(20);
  expect(updates.every((u) => JSON.stringify(u.objects) === JSON.stringify([orb(10, 31)]))).toBe(true);
  expect(updates[5].dt).toBeCloseTo(0.1, 5);
  // removed: one destroy, and the next updates carry nothing
  p.got.length = 0;
  h.setObjects([], []);
  vi.advanceTimersByTime(500);
  expect(p.got[0]).toEqual({ t: "objs", init: [], destroy: [orb(10, 31)] });
  const after = p.got.filter((m) => m.t === "update");
  expect(after.length).toBe(5);
  expect(after.every((u) => (u.objects as unknown[]).length === 0)).toBe(true);
  // moved: a destroy at the old place and an init at the new one, in one message
  h.setObjects([orb(10, 31)], [orb(10, 31)]);
  p.got.length = 0;
  h.setObjects([orb(11, 31)], [orb(11, 31)]);
  expect(p.got[0]).toEqual({ t: "objs", init: [orb(11, 31)], destroy: [orb(10, 31)] });
});

test("a plugin that does not answer an update skips the next ones instead of queueing them", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  startHost();
  const p = connect("ui-demo", { ack: false });
  vi.advanceTimersByTime(2000);
  expect(p.got.filter((m) => m.t === "update").length).toBe(1);
});

test("a batch over the limit stops the plugin on this page: its frame goes, and it says why", () => {
  const { h, layer, stopped } = startHost();
  const p = connect("ui-demo");
  // what 600 hq.remove in one go send: one batch, flushed once
  p.cmds(Array.from({ length: 600 }, (_, i) => ({ op: "remove", id: "x" + i })));
  expect(stopped).toHaveLength(1);
  expect(stopped[0]).toMatch(/512/);
  expect(h.stopReason).toMatch(/512/);
  expect(document.querySelector("iframe.plugin-frame")).toBeNull();
  expect(layer.dropped).toEqual(["ui-demo"]);
});

test("image data that is not a picture is refused as an invalid sheet, and the plugin goes on", async () => {
  const { h, stopped } = startHost("drawn-sheet", []);
  const p = connect("drawn-sheet");
  p.cmds([{ op: "provide" }]);
  const asked = h.requestSheet({ kind: 1 });
  const ask = p.got.find((m) => m.t === "sheet")!;
  p.port.postMessage({ t: "sheet", id: ask.id, image: "not a picture", frameW: 16, frameH: 16 });
  await expect(asked).rejects.toThrow(/image, frameW, frameH/);
  expect(stopped).toEqual([]);
  expect(document.querySelector('iframe.plugin-frame[data-plugin="drawn-sheet"]')).not.toBeNull();
});

/** Opens a modal with the echo view in it and connects the view's frame; returns the view's end. */
function openView(h: PluginHost, p: ReturnType<typeof connect>) {
  p.cmds([{ op: "modal", title: "UI demo", content: [{ type: "view", view: "echo", label: "Echo view", message: "c1" }] }]);
  const frame = document.createElement("iframe");
  frame.title = "Echo view";
  document.body.appendChild(frame);
  let port: Port | null = null;
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(((_m: unknown, _o: unknown, transfer?: Port[]) => { port = transfer![0]; }) as never);
  const failed: string[] = [];
  h.attachView("echo", frame, (r) => failed.push(r));
  window.dispatchEvent(new MessageEvent("message", { data: "hq-view-ready", source: frame.contentWindow }));
  const v = port as Port | null;
  if (!v) throw new Error("the view got no port");
  const got: Msg[] = [];
  v.onmessage = (e) => got.push(e.data as Msg);
  return { frame, port: v, got, failed };
}

test("the frames' documents: the hidden frame titled by the plugin, the view by its label, both in English", () => {
  const { h } = startHost();
  const hidden = document.querySelector<HTMLIFrameElement>("iframe.plugin-frame")!;
  expect(hidden.srcdoc.startsWith(frameHead("UI demo", "").split("<meta http-equiv")[0])).toBe(true);
  const p = connect("ui-demo");
  const v = openView(h, p);
  expect(v.frame.srcdoc.startsWith('<!doctype html><html lang="en"><meta charset="utf-8"><title>Echo view</title>')).toBe(true);
});

test("100 view messages in a second: 30 reach the client code, the rest are dropped with one warning; the plugin and its view go on", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  vi.advanceTimersByTime(10_000); // a page open for a while (its clock starts at 0 here)
  const { h, stopped } = startHost();
  const p = connect("ui-demo", { ack: true });
  const v = openView(h, p);
  p.got.length = 0;
  for (let i = 0; i < 100; i++) v.port.postMessage({ t: "msg", d: { t: "flood", i } });
  const cbs = p.got.filter((m) => m.t === "cb");
  expect(cbs).toHaveLength(LIMITS.viewRate);
  expect(cbs[0]).toEqual({ t: "cb", id: "c1", v: { t: "flood", i: 0 } });
  const warned = warn.mock.calls.filter((c) => String(c[0]).includes("view message dropped: more than 30 a second from the view"));
  expect(warned).toHaveLength(1);
  expect(stopped).toEqual([]);
  expect(h.stopReason).toBe("");
  // a second later the window has moved: messages go through again
  vi.advanceTimersByTime(1000);
  v.port.postMessage({ t: "msg", d: { t: "later" } });
  expect(p.got.at(-1)).toEqual({ t: "cb", id: "c1", v: { t: "later" } });
});

test("100 hq.ui.post in a second: 30 reach the view, the rest are dropped with one warning; the plugin goes on", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  vi.advanceTimersByTime(10_000); // a page open for a while (its clock starts at 0 here)
  const { h, stopped } = startHost();
  const p = connect("ui-demo");
  const v = openView(h, p);
  p.cmds(Array.from({ length: 100 }, (_, i) => ({ op: "post", d: { t: "flood", i } })));
  expect(v.got).toHaveLength(LIMITS.viewRate);
  const warned = warn.mock.calls.filter((c) => String(c[0]).includes("view message dropped: more than 30 a second to the view"));
  expect(warned).toHaveLength(1);
  expect(stopped).toEqual([]);
});

test("a Map or an ArrayBuffer posted past the SDK reaches the view as {} (the page relays its JSON copy)", () => {
  const { h } = startHost();
  const p = connect("ui-demo");
  const v = openView(h, p);
  p.cmds([{ op: "post", d: { t: "raw", big: new Map([["a", 1]]), buf: new ArrayBuffer(8) } }]);
  expect(v.got).toHaveLength(1);
  const d = v.got[0].d as Record<string, unknown>;
  expect(d.big).toEqual({});
  expect(d.big instanceof Map).toBe(false);
  expect(d.buf instanceof ArrayBuffer).toBe(false);
});

test("a view the manifest does not declare is left out (the frame is told so), and the plugin runs", () => {
  const { h, stopped } = startHost("ui-demo", ["echo"]);
  connect("ui-demo");
  const frame = document.createElement("iframe");
  const failed: string[] = [];
  h.attachView("missing", frame, (r) => failed.push(r));
  expect(failed).toEqual(["not declared"]);
  expect(frame.srcdoc).toBe("");
  expect(stopped).toEqual([]);
  expect(warn.mock.calls.some((c) => String(c[0]).includes("view missing removed: the manifest declares no such view"))).toBe(true);
});

/** A manager whose /api/plugins lists one plugin with browser code. */
function managerWith(name: string) {
  const layer = fakeLayer();
  const socket: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ name, title: "UI demo", client: "/plugins/" + name + "/client.js" }]))));
  const m = new PluginManager(layer as unknown as PluginLayer, (_p, d) => socket.push(d));
  return { m, socket };
}

test("a message the server code sent before this page started the plugin (its onJoin) reaches it once it runs", async () => {
  const { m } = managerWith("ui-demo");
  m.deliver("ui-demo", { t: "welcome" }); // the page has not fetched the plugin list yet
  await m.refresh();
  m.deliver("ui-demo", { t: "second" }); // started, its frame not connected yet
  const p = connect("ui-demo");
  expect(p.got.filter((x) => x.t === "msg").map((x) => x.d)).toEqual([{ t: "welcome" }, { t: "second" }]);
  expect(p.got[0].t).toBe("load");
});

test("a flood of plugin messages to the server is held under the socket's rate: the member is never disconnected for it", async () => {
  vi.useFakeTimers({ toFake: ["performance"] });
  vi.advanceTimersByTime(10_000); // a page open for a while (its clock starts at 0 here)
  const { m, socket } = managerWith("hq-pets");
  await m.refresh();
  const p = connect("hq-pets");
  // what 300 hq.send in a loop send: one batch
  p.cmds(Array.from({ length: 300 }, (_, i) => ({ op: "send", d: { t: "flood", i } })));
  expect(socket.length).toBe(LIMITS.sendBurst); // and LIMITS stays below the server's bucket: pluginCommands.test.ts
  expect(m.stopReasons.get("hq-pets")).toBeUndefined();
  expect(warn.mock.calls.some((c) => String(c[0]).includes("messages to the server dropped"))).toBe(true);
});
