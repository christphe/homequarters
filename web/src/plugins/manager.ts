import { PluginHost, type ProvidedSheet } from "./host";
import { LIMITS, SendBudget } from "./commands";
import type { PluginLayer } from "../game/pluginLayer";
import { setState, type PluginSlot } from "../store";
import type { PluginObjectSpec, Prop } from "../net/protocol";
import { dynamicObjects, placedObjects } from "../game/pluginObjects";

const EARLY_PLUGINS = 16;
const EARLY_MESSAGES = 64;

interface Entry {
  name: string;
  title: string;
  client: string | null;
  hosts?: string[]; // externalHosts of its manifest: what its iframe may fetch
  objects?: Omit<PluginObjectSpec, "plugin">[]; // map objects of its manifest
  views?: string[]; // names of the views of its manifest
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
  /** Tests only (window.__hq): how many of a plugin's next messages to the server are dropped, as over the budget. */
  private dropping = new Map<string, number>();

  /** Sheets drawn by a plugin for metadata, by "<plugin>|<metadata JSON>": asked once per page. */
  private provided = new Map<string, Promise<ProvidedSheet>>();

  /** The props of the map the page shows, and the map objects of the running plugins. */
  private props: Prop[] = [];
  private specs: PluginObjectSpec[] = [];
  /** Plugins already warned about having more dynamic objects than get updates. */
  private warnedDynamic = new Set<string>();

  constructor(
    private layer: PluginLayer,
    private socketSend: (plugin: string, d: unknown) => void,
    /** The map objects of the running plugins changed (the world view draws them). */
    private objectsChanged: (specs: PluginObjectSpec[]) => void = () => {},
  ) {
    layer.provider = (from, metadata) => {
      const k = from + "|" + JSON.stringify(metadata);
      let p = this.provided.get(k);
      if (!p) {
        const h = this.hosts.get(from);
        p = h ? h.requestSheet(metadata) : Promise.reject(new Error(`${from} is not running on this page`));
        this.provided.set(k, p);
        p.catch(() => { if (this.provided.get(k) === p) this.provided.delete(k); }); // asked again next time
      }
      return p;
    };
  }

  /** Plugin messages to the server, held under the socket's rate limit (excess dropped, with a warning). */
  private send = (plugin: string, d: unknown) => {
    const now = performance.now();
    const drop = this.dropping.get(plugin) ?? 0;
    if (drop > 0) {
      if (drop > 1) this.dropping.set(plugin, drop - 1);
      else this.dropping.delete(plugin);
    } else if (this.budget.allow(now)) return this.socketSend(plugin, d);
    if (now - this.warnedAt > 5000) {
      this.warnedAt = now;
      console.warn(`[plugin ${plugin}] messages to the server dropped: more than ${LIMITS.sendRate} a second`);
    }
  };

  /** Tests only (window.__hq): drops the next n messages this plugin sends to the server, as a spent budget does. */
  dropNext(plugin: string, n: number) {
    if (n > 0) this.dropping.set(plugin, Math.floor(n));
    else this.dropping.delete(plugin);
  }

  /** A plugin's decoded sheet (hq.ui.sprite with sheet), or null. */
  sheetImage(plugin: string, key: string) {
    return this.layer.sheetImage(plugin, key);
  }

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
    this.setObjects(list);
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
      const h = new PluginHost(e.name, e.title, e.client!, e.hosts ?? [], {
        layer: this.layer,
        send: this.send,
        uiChanged: (name) => this.uiChanged(name),
        stopped: (name, reason) => {
          this.stopReasons.set(name, reason);
          for (const k of [...this.provided.keys()]) if (k.startsWith(name + "|")) this.provided.delete(k);
          if (this.hosts.get(name) === h) this.hosts.delete(name);
          this.layer.providerStopped(name);
        },
      }, e.views ?? []);
      this.hosts.set(e.name, h);
      h.start();
      this.layer.providerStarted(e.name); // sheets asked for before it ran, or while it was off
      for (const d of this.early.get(e.name) ?? []) h.deliver(d);
      this.early.delete(e.name);
    }
    this.tellObjects();
  }

  /** The map the page shows changed (a new map, a reload, an editor draft). */
  setProps(props: Prop[]) {
    this.props = props;
    this.tellObjects();
  }

  /** Gives each running plugin its placed objects: they say what changed to its browser code. */
  private tellObjects() {
    for (const h of this.hosts.values()) {
      const own = this.specs.filter((s) => s.plugin === h.name);
      const placed = placedObjects(this.props, own, h.name);
      const { objects, over } = dynamicObjects(placed, own);
      if (over > 0 && !this.warnedDynamic.has(h.name)) {
        this.warnedDynamic.add(h.name);
        console.warn(`[plugin ${h.name}] ${objects.length + over} dynamic objects on the map: only the first ${objects.length} get onObjectUpdate`);
      }
      h.setObjects(placed, objects);
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

  /** Connects the view iframe of a plugin's modal (PluginViewFrame); returns what disconnects it. */
  attachView(plugin: string, view: string, frame: HTMLIFrameElement, fail: (reason: string) => void): () => void {
    const h = this.hosts.get(plugin);
    if (!h) return () => {};
    return h.attachView(view, frame, fail);
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
    this.setObjects([]);
  }

  /** Map objects come from every running plugin, browser code or not. */
  private setObjects(list: Entry[]) {
    const specs: PluginObjectSpec[] = [];
    const titles: Record<string, string> = {};
    for (const e of list) {
      if (!Array.isArray(e.objects) || e.objects.length === 0) continue;
      titles[e.name] = e.title;
      for (const o of e.objects) specs.push({ ...o, plugin: e.name });
    }
    this.specs = specs;
    setState({ pluginObjects: { specs, titles } });
    this.objectsChanged(specs);
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
