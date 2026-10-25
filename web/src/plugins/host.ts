import SDK from "./sdk.js?raw";
import VIEW_SDK from "./viewSdk.js?raw";
import { parseBatch, viewMessage, ViewRate, LIMITS, type Cmd, type UINode } from "./commands";
import type { PluginLayer } from "../game/pluginLayer";

// One running plugin on this page. Its JavaScript runs in a hidden iframe with sandbox="allow-scripts"
// only: an opaque origin, so it cannot read this page, its cookies, storage or media. It talks to the
// page over a MessageChannel handed over once the iframe says it is ready; the page validates every
// batch, draws the sprites (PluginLayer) and forwards messages to the plugin's server code over the socket.
// A plugin that breaks a limit is stopped on this page; the office goes on.

type SlotCmd = Extract<Cmd, { op: "slot" }>;
type ModalCmd = Extract<Cmd, { op: "modal" }>;
type ViewNode = Extract<UINode, { type: "view" }>;

/** The view node of a modal's tree (at most one: parseBatch checks it), or null. */
const findView = (nodes: UINode[]): ViewNode | null => {
  for (const n of nodes) {
    if (n.type === "view") return n;
    if (n.type === "row") {
      const v = findView(n.children);
      if (v) return v;
    }
  }
  return null;
};

/** The view iframe of the plugin's modal: its channel and its two rate windows. */
interface ViewConn {
  view: string;
  port: MessagePort | null;
  timer: number;
  fromView: ViewRate;
  toView: ViewRate;
  onWindow: (ev: MessageEvent) => void;
}

/** A sheet a plugin's browser code drew for metadata (hq.provideSheet). */
export interface ProvidedSheet { image: Blob | ImageBitmap; frameW: number; frameH: number }

const isImage = (v: unknown) => v instanceof Blob || (typeof ImageBitmap !== "undefined" && v instanceof ImageBitmap);

export interface HostDeps {
  layer: PluginLayer;
  /** Sends {t:"plg", pl, d} on the game socket. */
  send(plugin: string, d: unknown): void;
  /** The plugin's slots or modal changed. */
  uiChanged(plugin: string): void;
  stopped(plugin: string, reason: string): void;
}

const HANDSHAKE_MS = 10_000;
const UPDATE_MS = 100;
const PENDING_MAX = 64; // messages from the server code held until the handshake

export class PluginHost {
  /** The plugin's anchored buttons and screen boxes, by id, in insertion order. */
  readonly slots = new Map<string, SlotCmd>();
  /** The plugin's open modal, if any. */
  modal: ModalCmd | null = null;
  private frame: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;
  private pending: unknown[] = [];
  private timers: number[] = [];
  private waitingAck = false;
  private lastUpdate = 0;
  private batchTimes: number[] = [];
  private stoppedWith = "";
  /** hq.provideSheet was called: sheet requests go to the iframe; before that, they wait */
  private provides = false;
  private sheetAsks = new Map<number, { metadata: unknown; resolve: (s: ProvidedSheet) => void; reject: (e: Error) => void; sent: boolean }>();
  private nextAsk = 0;
  /** The connected view of the modal, if any (one modal per plugin, one view per modal). */
  private view: ViewConn | null = null;
  /** hq.ui.post made while the modal's view was still starting, delivered once it has (bounded). */
  private viewEarly: unknown[] = [];
  private viewWarnedAt = { from: 0, to: 0 };

  constructor(readonly name: string, readonly title: string, private client: string, private hosts: string[], private deps: HostDeps, private views: string[] = []) {}

  /**
   * What the iframe may load: its own folder (the browser code, its assets) and the hosts its manifest
   * declares (externalHosts, over https), nothing else. Administrators see those hosts before turning
   * the plugin on; without this policy a plugin could reach any server with every viewer's address.
   */
  private policy(): string {
    const own = new URL(`/plugins/${this.name}/`, location.href).href;
    const out = this.hosts.filter((h) => /^[a-z0-9.-]+$/.test(h)).map((h) => "https://" + h);
    return [
      "default-src 'none'",
      `script-src 'unsafe-inline' ${own}`,
      `connect-src ${[own, ...out].join(" ")}`,
      `img-src blob: data: ${[own, ...out].join(" ")}`,
      "style-src 'unsafe-inline'",
    ].join("; ");
  }

  /** URL of the plugin's public/ folder. */
  get base() {
    return new URL(`/plugins/${this.name}/assets/`, location.href).href;
  }

  start() {
    const base = this.base;
    this.deps.layer.addPlugin(this.name, base);
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("aria-hidden", "true");
    f.tabIndex = -1;
    f.title = this.title;
    f.className = "plugin-frame";
    f.dataset.plugin = this.name;
    const src = new URL(this.client, location.href).href.replace(/"/g, "%22");
    // "</script" cannot appear inside the inlined SDK; escape it anyway in case it ever does
    f.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${this.policy()}"><script>${SDK.replace(/<\/script/gi, "<\\/script")}</script><script src="${src}"></script>`;
    window.addEventListener("message", this.onWindowMessage);
    document.body.appendChild(f);
    this.frame = f;
    this.timers.push(window.setTimeout(() => {
      if (!this.port) this.stop("the plugin did not start within 10 s");
    }, HANDSHAKE_MS));
  }

  private onWindowMessage = (ev: MessageEvent) => {
    if (this.port || !this.frame || ev.source !== this.frame.contentWindow || ev.data !== "hq-ready") return;
    const ch = new MessageChannel();
    this.port = ch.port1;
    this.port.onmessage = (m) => this.onPort(m.data);
    this.frame.contentWindow!.postMessage("hq-port", "*", [ch.port2]);
    this.port.postMessage({ t: "load" });
    for (const d of this.pending) this.port.postMessage({ t: "msg", d });
    this.pending = [];
    this.lastUpdate = performance.now();
    this.timers.push(window.setInterval(() => this.update(), UPDATE_MS));
  };

  private update() {
    if (!this.port || this.waitingAck) return; // a slow plugin skips updates instead of queueing them
    const now = performance.now();
    const dt = (now - this.lastUpdate) / 1000;
    this.lastUpdate = now;
    this.waitingAck = true;
    this.port.postMessage({ t: "update", dt, world: this.deps.layer.worldSnapshot() });
  }

  private onPort(m: { t?: string; c?: unknown; m?: unknown; id?: unknown; image?: unknown; frameW?: unknown; frameH?: unknown; error?: unknown }) {
    if (this.stoppedWith) return;
    if (m?.t === "sheet") {
      const ask = this.sheetAsks.get(m.id as number);
      if (!ask) return;
      this.sheetAsks.delete(m.id as number);
      const ok = isImage(m.image) && [m.frameW, m.frameH].every((n) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 256);
      if (ok) ask.resolve({ image: m.image as Blob | ImageBitmap, frameW: m.frameW as number, frameH: m.frameH as number });
      else ask.reject(new Error(typeof m.error === "string" ? m.error : "hq.provideSheet must return { image, frameW, frameH }"));
    } else if (m?.t === "ack") {
      this.waitingAck = false;
    } else if (m?.t === "error") {
      console.warn(`[plugin ${this.name}]`, String(m.m).slice(0, 500));
    } else if (m?.t === "cmds") {
      const now = performance.now();
      this.batchTimes = this.batchTimes.filter((t) => now - t < 1000);
      this.batchTimes.push(now);
      if (this.batchTimes.length > LIMITS.batchesPerSec) return this.stop(`more than ${LIMITS.batchesPerSec} batches a second`);
      const cmds = parseBatch(m.c);
      if (typeof cmds === "string") return this.stop(cmds);
      this.run(cmds, now);
    }
  }

  private run(cmds: Cmd[], now: number) {
    let ui = false;
    for (const c of cmds) {
      if (c.op === "send") {
        const s = JSON.stringify(c.d);
        if (s !== undefined && s.length <= LIMITS.sendBytes) this.deps.send(this.name, c.d);
      } else if (c.op === "slot") {
        if (!this.slots.has(c.id) && this.slots.size >= LIMITS.slots) return this.stop(`more than ${LIMITS.slots} slots`);
        this.slots.set(c.id, c);
        ui = true;
      } else if (c.op === "unslot") {
        ui = this.slots.delete(c.id) || ui;
      } else if (c.op === "modal") {
        this.modal = c;
        if (!findView(c.content)) this.viewEarly = [];
        ui = true;
      } else if (c.op === "close") {
        ui = this.modal !== null || ui;
        this.modal = null;
        this.viewEarly = [];
      } else if (c.op === "post") {
        this.postToView(c.d, now);
      } else if (c.op === "provide") {
        this.provides = true;
        this.sendAsks();
      }
    }
    const reason = this.deps.layer.apply(this.name, cmds, now);
    if (reason) return this.stop(reason);
    if (ui) this.deps.uiChanged(this.name);
  }

  /** Asks the plugin's browser code for the sheet of that metadata (hq.provideSheet). It waits while the
   *  plugin has not started or not registered its provider yet; it fails when the plugin stops. */
  requestSheet(metadata: unknown): Promise<ProvidedSheet> {
    if (this.stoppedWith) return Promise.reject(new Error("the plugin is not running on this page"));
    if (this.sheetAsks.size >= LIMITS.sprites * 2) return Promise.reject(new Error("too many sheets asked for"));
    return new Promise((resolve, reject) => {
      this.sheetAsks.set(++this.nextAsk, { metadata, resolve, reject, sent: false });
      this.sendAsks();
    });
  }

  private sendAsks() {
    if (!this.port || !this.provides) return;
    for (const [id, ask] of this.sheetAsks) {
      if (ask.sent) continue;
      ask.sent = true;
      this.port.postMessage({ t: "sheet", id, metadata: ask.metadata });
    }
  }

  /**
   * Starts a view of this plugin in an iframe of its modal (PluginViewFrame), with the view SDK and the
   * hidden iframe's Content Security Policy, and relays its messages to and from the plugin's client
   * code. fail(reason) when it cannot run (not declared, or it did not start): the modal then drops it.
   * Returns the function that disconnects it (the iframe is unmounting).
   */
  attachView(view: string, frame: HTMLIFrameElement, fail: (reason: string) => void): () => void {
    if (this.stoppedWith) return () => {};
    if (!this.views.includes(view)) {
      console.warn(`[plugin ${this.name}] view ${view} removed: the manifest declares no such view`);
      fail("not declared");
      return () => {};
    }
    this.detachView();
    const conn: ViewConn = { view, port: null, timer: 0, fromView: new ViewRate(), toView: new ViewRate(), onWindow: () => {} };
    conn.onWindow = (ev: MessageEvent) => {
      if (conn.port || ev.source !== frame.contentWindow || ev.data !== "hq-view-ready") return;
      const ch = new MessageChannel();
      conn.port = ch.port1;
      conn.port.onmessage = (m) => this.fromView(conn, m.data);
      frame.contentWindow!.postMessage("hq-view-port", "*", [ch.port2]);
      window.clearTimeout(conn.timer);
      const early = this.viewEarly;
      this.viewEarly = [];
      for (const d of early) conn.port.postMessage({ t: "msg", d });
    };
    conn.timer = window.setTimeout(() => {
      if (conn.port || this.view !== conn) return;
      console.warn(`[plugin ${this.name}] view ${view} removed: it did not start within 10 s`);
      this.detachView();
      fail("did not start");
    }, HANDSHAKE_MS);
    window.addEventListener("message", conn.onWindow);
    this.view = conn;
    const src = new URL(`/plugins/${this.name}/views/${view}.js`, location.href).href.replace(/"/g, "%22");
    // the scripts run in <body>, so a view can add to document.body right away
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${this.policy()}"><style>html,body{margin:0}</style><body><script>${VIEW_SDK.replace(/<\/script/gi, "<\\/script")}</script><script src="${src}"></script>`;
    return () => {
      if (this.view === conn) this.detachView();
    };
  }

  private detachView() {
    const c = this.view;
    if (!c) return;
    this.view = null;
    window.clearTimeout(c.timer);
    window.removeEventListener("message", c.onWindow);
    c.port?.close();
  }

  /** At most one warning a second each way about dropped view messages: a flood must not flood the console. */
  private viewWarn(dir: "from" | "to", text: string) {
    const now = performance.now();
    if (now - this.viewWarnedAt[dir] < 1000) return;
    this.viewWarnedAt[dir] = now;
    console.warn(`[plugin ${this.name}] view message dropped: ${text}`);
  }

  /** hq.ui.post: to the open view, if any (silently nothing without one). */
  private postToView(raw: unknown, now: number) {
    const node = this.modal ? findView(this.modal.content) : null;
    if (!node) return;
    // the JSON copy, never the value itself: plugin code can post on its port past the SDK's own check
    const m = viewMessage(raw);
    if (typeof m === "string") return this.viewWarn("to", m + " (to the view)");
    const d = m.d;
    const c = this.view?.view === node.view ? this.view : null;
    if (c && !c.toView.allow(now)) return this.viewWarn("to", `more than ${LIMITS.viewRate} a second to the view`);
    if (c?.port) c.port.postMessage({ t: "msg", d });
    else if (this.viewEarly.length < LIMITS.viewRate) this.viewEarly.push(d); // the view is starting
    else this.viewWarn("to", "the view has not started yet");
  }

  /** hqView.send: to the onMessage of the view element of the modal. */
  private fromView(c: ViewConn, raw: unknown) {
    const msg = raw as { t?: unknown; d?: unknown } | null;
    if (this.view !== c || this.stoppedWith || msg?.t !== "msg") return;
    const m = viewMessage(msg.d);
    if (typeof m === "string") return this.viewWarn("from", m + " (from the view)");
    if (!c.fromView.allow(performance.now())) return this.viewWarn("from", `more than ${LIMITS.viewRate} a second from the view`);
    const node = this.modal ? findView(this.modal.content) : null;
    if (!node || node.view !== c.view || !node.message) return;
    this.port?.postMessage({ t: "cb", id: node.message, v: m.d });
  }

  /** A message from the plugin's server code. */
  deliver(d: unknown) {
    if (this.stoppedWith) return;
    if (this.port) this.port.postMessage({ t: "msg", d });
    else if (this.pending.length < PENDING_MAX) this.pending.push(d);
    else console.warn(`[plugin ${this.name}] message dropped: the plugin has not started yet`);
  }

  /** Runs one of the plugin's UI callbacks: a click, or a field's new value. */
  callback(id: string, value?: string | number) {
    this.port?.postMessage({ t: "cb", id, v: value });
  }

  /** The person closed the plugin's modal (Escape, Close, a click outside, or another modal replaced it). */
  modalClosed() {
    const close = this.modal?.close;
    this.modal = null;
    this.viewEarly = [];
    this.detachView();
    this.port?.postMessage({ t: "cb", id: close ?? "", closed: true });
    this.deps.uiChanged(this.name);
  }

  get stopReason() {
    return this.stoppedWith;
  }

  /** Removes the iframe, the sprites, the textures, the slots and the modal. reason: why (a limit), or "" (disabled). */
  stop(reason = "") {
    if (this.stoppedWith) return;
    this.stoppedWith = reason || "stopped";
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    window.removeEventListener("message", this.onWindowMessage);
    for (const ask of this.sheetAsks.values()) ask.reject(new Error("the plugin stopped on this page"));
    this.sheetAsks.clear();
    this.detachView();
    this.viewEarly = [];
    this.port?.close();
    this.port = null;
    this.frame?.remove();
    this.frame = null;
    this.deps.layer.dropPlugin(this.name);
    const hadUI = this.slots.size > 0 || this.modal !== null;
    this.slots.clear();
    this.modal = null;
    if (hadUI) this.deps.uiChanged(this.name);
    if (reason) console.warn(`[plugin ${this.name}] stopped on this page: ${reason}`);
    this.deps.stopped(this.name, this.stoppedWith);
  }
}
