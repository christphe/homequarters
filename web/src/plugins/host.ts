import SDK from "./sdk.js?raw";
import { parseBatch, LIMITS, type Cmd } from "./commands";
import type { PluginLayer } from "../game/pluginLayer";

// One running plugin on this page. Its JavaScript runs in a hidden iframe with sandbox="allow-scripts"
// only: an opaque origin, so it cannot read this page, its cookies, storage or media. It talks to the
// page over a MessageChannel handed over once the iframe says it is ready; the page validates every
// batch, draws the sprites (PluginLayer) and forwards messages to the plugin's server code over the socket.
// A plugin that breaks a limit is stopped on this page; the office goes on.

type SlotCmd = Extract<Cmd, { op: "slot" }>;
type ModalCmd = Extract<Cmd, { op: "modal" }>;

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

  constructor(readonly name: string, readonly title: string, private client: string, private deps: HostDeps) {}

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
    f.srcdoc = `<!doctype html><meta charset="utf-8"><script>${SDK.replace(/<\/script/gi, "<\\/script")}</script><script src="${src}"></script>`;
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

  private onPort(m: { t?: string; c?: unknown; m?: unknown }) {
    if (this.stoppedWith) return;
    if (m?.t === "ack") {
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
        ui = true;
      } else if (c.op === "close") {
        ui = this.modal !== null || ui;
        this.modal = null;
      }
    }
    const reason = this.deps.layer.apply(this.name, cmds, now);
    if (reason) return this.stop(reason);
    if (ui) this.deps.uiChanged(this.name);
  }

  /** A message from the plugin's server code. */
  deliver(d: unknown) {
    if (this.stoppedWith) return;
    if (this.port) this.port.postMessage({ t: "msg", d });
    else if (this.pending.length < PENDING_MAX) this.pending.push(d);
    else console.warn(`[plugin ${this.name}] message dropped: the plugin has not started yet`);
  }

  /** Runs one of the plugin's UI callbacks (a click). */
  callback(id: string) {
    this.port?.postMessage({ t: "cb", id });
  }

  /** The person closed the plugin's modal (Escape, Close, a click outside, or another modal replaced it). */
  modalClosed() {
    const close = this.modal?.close;
    this.modal = null;
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
