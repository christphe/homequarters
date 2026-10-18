import { PluginHost } from "./host";
import { LIMITS, SendBudget } from "./commands";
import type { PluginLayer } from "../game/pluginLayer";
import { setState, type PluginSlot } from "../store";

const EARLY_PLUGINS = 16;
const EARLY_MESSAGES = 64;

interface Entry {
  name: string;
  title: string;
  client: string | null;
}

/** Starts and stops plugin hosts to match GET /api/plugins, and routes messages to them. */
export class PluginManager {
  private hosts = new Map<string, PluginHost>();
  /** Messages for plugins this page has not started yet, by plugin (bounded). */
  private early = new Map<string, unknown[]>();
  /** The plugin whose modal is open: one plugin modal at a time on the page. */
  private modalOwner = "";
  private gen = 0;
  /** Why each plugin last stopped on this page (tests and diagnostics). */
  readonly stopReasons = new Map<string, string>();

  private budget = new SendBudget();
  private warnedAt = 0;

  constructor(private layer: PluginLayer, private socketSend: (plugin: string, d: unknown) => void) {}

  /** Plugin messages to the server, held under the socket's rate limit (excess dropped, with a warning). */
  private send = (plugin: string, d: unknown) => {
    const now = performance.now();
    if (this.budget.allow(now)) return this.socketSend(plugin, d);
    if (now - this.warnedAt > 5000) {
      this.warnedAt = now;
      console.warn(`[plugin ${plugin}] messages to the server dropped: more than ${LIMITS.sendRate} a second`);
    }
  };

  /** Fetches the running plugins and starts or stops hosts to match; restart: start every one afresh. */
  async refresh(restart = false) {
    const gen = ++this.gen;
    let list: Entry[];
    try {
      const r = await fetch("/api/plugins");
      if (!r.ok) return;
      list = (await r.json()) as Entry[];
    } catch {
      return; // offline: the next hello or plgs tries again
    }
    if (gen !== this.gen) return; // a newer refresh won
    const want = new Map(list.filter((e) => e.client).map((e) => [e.name, e]));
    for (const [name, h] of this.hosts) {
      if (restart || !want.has(name)) {
        this.hosts.delete(name);
        h.stop();
      }
    }
    for (const name of this.early.keys()) if (!want.has(name)) this.early.delete(name);
    for (const e of want.values()) {
      if (this.hosts.has(e.name)) continue;
      const h = new PluginHost(e.name, e.title, e.client!, {
        layer: this.layer,
        send: this.send,
        uiChanged: (name) => this.uiChanged(name),
        stopped: (name, reason) => {
          this.stopReasons.set(name, reason);
          if (this.hosts.get(name) === h) this.hosts.delete(name);
        },
      });
      this.hosts.set(e.name, h);
      h.start();
      for (const d of this.early.get(e.name) ?? []) h.deliver(d);
      this.early.delete(e.name);
    }
  }

  /** A message from a plugin's server code. One that arrives before this page started the plugin (its
   *  onJoin runs as soon as I connect, while the page still fetches the plugin list) waits for it. */
  deliver(plugin: string, d: unknown) {
    const h = this.hosts.get(plugin);
    if (h) return h.deliver(d);
    let q = this.early.get(plugin);
    if (!q) {
      if (this.early.size >= EARLY_PLUGINS) return;
      this.early.set(plugin, (q = []));
    }
    if (q.length < EARLY_MESSAGES) q.push(d);
    else console.warn(`[plugin ${plugin}] message dropped: the plugin has not started on this page yet`);
  }

  /** A click on something a plugin drew: runs its callback in the plugin's iframe. */
  event(plugin: string, callback: string | undefined, value?: string | number) {
    if (callback) this.hosts.get(plugin)?.callback(callback, value);
  }

  /** The person closed the plugin modal. */
  closeModal() {
    const h = this.hosts.get(this.modalOwner);
    this.modalOwner = "";
    if (h) h.modalClosed();
    else this.publish();
  }

  stopAll() {
    this.gen++;
    for (const h of this.hosts.values()) h.stop();
    this.hosts.clear();
    this.early.clear();
    this.modalOwner = "";
    setState({ pluginUI: { slots: [], modal: null } });
  }

  running() {
    return [...this.hosts.keys()];
  }

  private uiChanged(name: string) {
    const h = this.hosts.get(name);
    if (h?.modal && this.modalOwner !== name) {
      // a plugin opening its modal replaces another plugin's: that one is told it was closed
      const prev = this.hosts.get(this.modalOwner);
      this.modalOwner = name;
      prev?.modalClosed();
    } else if (!h?.modal && this.modalOwner === name) {
      this.modalOwner = "";
    }
    this.publish();
  }

  private publish() {
    const slots: PluginSlot[] = [];
    for (const h of this.hosts.values()) for (const s of h.slots.values()) {
      const { op: _op, ...rest } = s;
      slots.push({ ...rest, plugin: h.name, title: h.title, base: h.base });
    }
    const owner = this.hosts.get(this.modalOwner);
    const m = owner?.modal;
    let modal = null;
    if (owner && m) {
      const { op: _op, ...rest } = m;
      modal = { ...rest, plugin: owner.name, base: owner.base };
    }
    setState({ pluginUI: { slots, modal } });
  }

  /** For tests: what a plugin drew on this page. */
  debug(plugin: string) {
    return this.layer.debug(plugin);
  }
}
