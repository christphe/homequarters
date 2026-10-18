// The plugin SDK. It runs INSIDE a plugin's sandboxed iframe (sandbox="allow-scripts", opaque
// origin), before the plugin's own script, and gives it the `hq` global. Everything a plugin does
// goes to the page as batched commands over a MessageChannel; the page validates and draws them.
// Plain JavaScript: it is inlined into the iframe's srcdoc as text (see host.ts).
(() => {
  "use strict";
  /** @type {MessagePort | null} */
  let port = null;
  /** @type {object[]} */
  let queue = [];
  let scheduled = false;
  const on = { load: [], update: [], message: [] };

  const flush = () => {
    scheduled = false;
    if (!port || queue.length === 0) return;
    const c = queue;
    queue = [];
    port.postMessage({ t: "cmds", c });
  };
  // one batch per task: every call made in the same callback travels together
  const push = (cmd) => {
    queue.push(cmd);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };
  const report = (e) => {
    const text = String((e && e.stack) || e).slice(0, 500);
    if (port) port.postMessage({ t: "error", m: text });
  };
  const call = (list, ...args) => {
    for (const f of list) {
      try {
        f(...args);
      } catch (e) {
        report(e);
      }
    }
  };
  const handler = (list) => (f) => {
    if (typeof f !== "function") throw new TypeError("expected a function");
    list.push(f);
  };

  // UI callbacks stay here; the page only gets their ids. Each owner (a slot, the modal) frees its old
  // callbacks when it is drawn again, so they never pile up.
  const callbacks = new Map();
  const owners = new Map();
  let nextCb = 0;
  const own = (owner) => {
    for (const id of owners.get(owner) || []) callbacks.delete(id);
    owners.set(owner, []);
  };
  const reg = (owner, fn) => {
    if (fn === undefined || fn === null) return undefined;
    if (typeof fn !== "function") throw new TypeError("a callback must be a function");
    if (callbacks.size >= 256) throw new Error("hq.ui: more than 256 callbacks");
    const id = "c" + ++nextCb;
    callbacks.set(id, fn);
    owners.get(owner).push(id);
    return id;
  };
  const ser = (owner, nodes) =>
    (nodes || []).map((n) => {
      if (n && n.type === "button") return { type: "button", label: n.label, click: reg(owner, n.onClick), primary: n.primary, pressed: n.pressed };
      if (n && n.type === "row") return { type: "row", children: ser(owner, n.children) };
      return n;
    });

  const ui = Object.freeze({
    text: (text, opts = {}) => ({ type: "text", text: String(text), muted: opts.muted ? true : undefined }),
    button: (opts) => ({ type: "button", label: opts.label, onClick: opts.onClick, primary: opts.primary, pressed: opts.pressed }),
    copy: (opts) => ({ type: "copy", label: opts.label, value: String(opts.value) }),
    image: (opts) => ({ type: "image", src: opts.src, alt: opts.alt }),
    row: (children) => ({ type: "row", children }),
    /** Home Quarters' own widget to create, copy (once) and revoke this member's token for this plugin. */
    appToken: () => ({ type: "appToken" }),
    /** A button at an anchor (topbar, topright, bottombar, sidebar, minimap), or a box on the map (screen). */
    slot(id, anchor, opts = {}) {
      const owner = "slot:" + id;
      own(owner);
      push({
        op: "slot", id, anchor, label: opts.label, icon: opts.icon, pressed: opts.pressed, click: reg(owner, opts.onClick),
        corner: opts.corner, dx: opts.dx, dy: opts.dy, content: opts.content ? ser(owner, opts.content) : undefined,
      });
    },
    unslot(id) {
      own("slot:" + id);
      owners.delete("slot:" + id);
      push({ op: "unslot", id });
    },
    /** Opens this plugin's modal, or redraws it if it is open. opts: { title, size, place, onClose } */
    modal(opts, content = []) {
      own("modal");
      push({ op: "modal", title: opts.title, size: opts.size, place: opts.place, close: reg("modal", opts.onClose), content: ser("modal", content) });
    },
    close() {
      own("modal");
      push({ op: "close" });
    },
  });

  const hq = {
    onLoad: handler(on.load),
    /** fn(dt, world): about 10 times a second; world = { me, avatars: [{ id, name, x, y, dir, moving }] } */
    onUpdate: handler(on.update),
    /** fn(msg): a message from this plugin's server code (hq.send / hq.broadcast) */
    onMessage: handler(on.message),
    ui,
    /** Sends msg (JSON, at most 1500 bytes) to this plugin's server onMessage. */
    send(msg) {
      const s = JSON.stringify(msg);
      if (s === undefined || s.length > 1500) throw new Error("hq.send: the message must be JSON of at most 1500 bytes");
      push({ op: "send", d: JSON.parse(s) });
    },
    /** Loads a sprite sheet from the plugin's public/ folder. anims: { name: { row, frames: [..], fps } } */
    loadSprite(key, path, opts = {}) {
      push({ op: "sprite", key, url: path, frameW: opts.frameW, frameH: opts.frameH, anims: opts.anims || {} });
    },
    spawn(id, key, opts = {}) {
      push({ op: "spawn", id, key, x: opts.x, y: opts.y, anim: opts.anim });
    },
    remove(id) {
      push({ op: "remove", id });
    },
    moveTo(id, x, y, opts = {}) {
      push({ op: "moveTo", id, x, y, speed: opts.speed });
    },
    follow(id, player, opts = {}) {
      push({ op: "follow", id, player, gap: opts.gap });
    },
    stop(id) {
      push({ op: "stop", id });
    },
    setAnim(id, name) {
      push({ op: "anim", id, name });
    },
    setFlip(id, on) {
      push({ op: "flip", id, on: !!on });
    },
    setVisible(id, on) {
      push({ op: "visible", id, on: !!on });
    },
  };
  Object.defineProperty(window, "hq", { value: Object.freeze(hq) });

  window.addEventListener("error", (ev) => report(ev.error || ev.message));
  window.addEventListener("unhandledrejection", (ev) => report(ev.reason));
  window.addEventListener("message", (ev) => {
    if (port || ev.source !== window.parent || ev.data !== "hq-port" || !ev.ports[0]) return;
    port = ev.ports[0];
    port.onmessage = (m) => {
      const d = m.data;
      if (d.t === "load") call(on.load);
      else if (d.t === "update") call(on.update, d.dt, d.world);
      else if (d.t === "msg") call(on.message, d.d);
      else if (d.t === "cb") {
        const f = callbacks.get(d.id);
        if (d.closed) own("modal"); // the person closed the modal: its callbacks are gone after this one
        if (f) call([f]);
      }
      flush();
      if (d.t === "update") port.postMessage({ t: "ack" });
    };
  });
  // after every script of the page ran (the plugin's included), so its handlers are registered
  window.addEventListener("load", () => window.parent.postMessage("hq-ready", "*"));
})();
