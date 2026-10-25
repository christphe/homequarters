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
  /** hq.provideSheet: draws a sheet another plugin asked for by metadata (a guest pet of hq-pets) */
  let provider = null;

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
      if (n && n.type === "button") return { type: "button", label: n.label, click: reg(owner, n.onClick), primary: n.primary, pressed: n.pressed, sprite: n.sprite };
      if (n && n.type === "row") return { type: "row", children: ser(owner, n.children) };
      if (n && (n.type === "color" || n.type === "number" || n.type === "field")) {
        const { onChange, ...rest } = n;
        return { ...rest, change: reg(owner, onChange) };
      }
      // what the view sends reaches onMessage as this callback's value (the page relays it)
      if (n && n.type === "view") return { type: "view", view: n.view, label: n.label, height: n.height, message: reg(owner, n.onMessage) };
      return n;
    });

  const ui = Object.freeze({
    text: (text, opts = {}) => ({ type: "text", text: String(text), muted: opts.muted ? true : undefined }),
    button: (opts) => ({ type: "button", label: opts.label, onClick: opts.onClick, primary: opts.primary, pressed: opts.pressed, sprite: opts.sprite }),
    /** One cell of a PNG of public/: { src, frame: [x, y, w, h], scale, tint, alt }. */
    sprite: (opts) => ({ type: "sprite", sprite: { src: opts.src, sheet: opts.sheet, frame: opts.frame, scale: opts.scale, tint: opts.tint }, alt: opts.alt }),
    copy: (opts) => ({ type: "copy", label: opts.label, value: String(opts.value) }),
    image: (opts) => ({ type: "image", src: opts.src, alt: opts.alt }),
    row: (children) => ({ type: "row", children }),
    /** A colour picker; onChange(colour) gets "#rrggbb" while it is being chosen (at most 4 a second) and once chosen. */
    color: (opts) => ({ type: "color", label: opts.label, value: opts.value, onChange: opts.onChange, hideLabel: opts.hideLabel }),
    /** One line of text; onChange(text) once it is entered (Enter or leaving the field). */
    field: (opts) => ({ type: "field", label: opts.label, value: opts.value ?? "", maxLength: opts.maxLength, placeholder: opts.placeholder, onChange: opts.onChange, hideLabel: opts.hideLabel }),
    /** A whole number in min..max; onChange(value) once it is entered. */
    number: (opts) => ({ type: "number", label: opts.label, value: opts.value, min: opts.min, max: opts.max, onChange: opts.onChange }),
    /** Home Quarters' own widget to create, copy (once) and revoke this member's token for this plugin. */
    appToken: () => ({ type: "appToken" }),
    /** A view of the manifest ("views") in a sandboxed iframe, at most one per modal; onMessage(msg) gets what it sends. */
    view: (opts) => ({ type: "view", view: opts.view, label: opts.label, height: opts.height ?? "medium", onMessage: opts.onMessage }),
    /** Sends msg (JSON, at most 4096 bytes) to the open view's hqView.onMessage; nothing without an open view. */
    post(msg) {
      let s;
      try {
        s = JSON.stringify(msg);
      } catch {
        s = undefined;
      }
      if (s === undefined || new TextEncoder().encode(s).length > 4096) {
        console.warn("hq.ui.post: message dropped, it must be JSON of at most 4096 bytes");
        return;
      }
      push({ op: "post", d: JSON.parse(s) });
    },
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
      // a path of public/ (or of another plugin's shared/ with from), image data the plugin made (Blob,
      // ImageBitmap), or { from, metadata }: a sheet that plugin's browser code draws (hq.provideSheet)
      const provided = typeof path === "object" && path !== null && !(path instanceof Blob) && !(typeof ImageBitmap !== "undefined" && path instanceof ImageBitmap);
      const data = !provided && typeof path !== "string";
      push({
        op: "sprite", key, url: data || provided ? undefined : path, image: data ? path : undefined,
        provided: provided ? { from: path.from, metadata: path.metadata } : undefined,
        frameW: opts.frameW, frameH: opts.frameH, anims: opts.anims || {}, from: opts.from,
      });
    },
    /** fn(metadata) draws the sheet of a pet this plugin put with hq-pets' setPet({ metadata }): returns
     *  { image: Blob | ImageBitmap, frameW, frameH }, or a promise of it. */
    provideSheet(fn) {
      if (typeof fn !== "function") throw new TypeError("expected a function");
      provider = fn;
      push({ op: "provide" });
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
    /** Walks there along a path around walls; somewhere it cannot reach, it stays where it is. */
    walkTo(id, x, y, opts = {}) {
      push({ op: "walkTo", id, x, y, speed: opts.speed });
    },
    /** Follows a member (their id), or another sprite of this plugin ({ sprite: id }), as a pet does. */
    follow(id, who, opts = {}) {
      const target = typeof who === "object" && who !== null ? { sprite: who.sprite } : { player: who };
      push({ op: "follow", id, ...target, gap: opts.gap, beside: opts.beside, roam: opts.roam });
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
    /** Text shown above the sprite while the mouse is over it (null: none); opts.owner adds that member's name under it. */
    setLabel(id, text, opts = {}) {
      push({ op: "label", id, text: text === null || text === undefined ? null : String(text), owner: opts.owner });
    },
    /** Multiplies the sprite's colours by "#rrggbb" (draw it light grey to give it any colour); null removes it. */
    setTint(id, colour) {
      push({ op: "tint", id, colour: colour === null || colour === undefined ? null : colour });
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
      else if (d.t === "sheet") {
        // the page asks for a sheet by metadata: answer it (or say why not), whenever it is drawn
        const reply = (r) => port && port.postMessage({ t: "sheet", id: d.id, ...r });
        Promise.resolve()
          .then(() => {
            if (!provider) throw new Error("no hq.provideSheet");
            return provider(d.metadata);
          })
          .then((r) => reply({ image: r && r.image, frameW: r && r.frameW, frameH: r && r.frameH }))
          .catch((e) => {
            report(e);
            reply({ error: String((e && e.message) || e).slice(0, 200) });
          });
      }
      else if (d.t === "cb") {
        const f = callbacks.get(d.id);
        if (d.closed) own("modal"); // the person closed the modal: its callbacks are gone after this one
        if (f) call([f], d.v); // a colour or number field's new value; nothing for a click
      }
      flush();
      if (d.t === "update") port.postMessage({ t: "ack" });
    };
  });
  // after every script of the page ran (the plugin's included), so its handlers are registered
  window.addEventListener("load", () => window.parent.postMessage("hq-ready", "*"));
})();
