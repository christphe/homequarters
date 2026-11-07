// @ts-check
// The view SDK. It runs INSIDE a plugin view's sandboxed iframe (sandbox="allow-scripts", opaque origin),
// before the view's own script, and gives it the `hqView` global and nothing else: no `hq`, no socket.
// Messages go to the page over a MessageChannel; the page checks their size and rate and relays them to
// the plugin's client code (the onMessage of the view element). Plain JavaScript, inlined into the
// iframe's srcdoc as text (see host.ts).
// Typed with JSDoc against the declared view API (plugins/sdk/view.d.ts): `hqView` must match it.
/// <reference path="../../../plugins/sdk/view.d.ts" />
/** @typedef {typeof hqView} HqView the declared global (the IIFE's own hqView shadows it) */
(() => {
  "use strict";
  const MAX_BYTES = 4096;
  const EARLY = 30; // messages sent before the page answered, held until it does
  /** @type {MessagePort | null} */
  let port = null;
  /** @type {unknown[]} */
  const early = [];
  /** @type {Array<(msg: unknown) => void>} */
  const handlers = [];

  const hqView = Object.freeze(/** @satisfies {HqView} */ ({
    /** Sends msg (JSON, at most 4096 bytes) to the plugin's client code. */
    send(msg) {
      let s;
      try {
        s = JSON.stringify(msg);
      } catch {
        s = undefined;
      }
      if (s === undefined || new TextEncoder().encode(s).length > MAX_BYTES) {
        console.warn("hqView.send: message dropped, it must be JSON of at most " + MAX_BYTES + " bytes");
        return;
      }
      const d = JSON.parse(s);
      if (port) port.postMessage({ t: "msg", d });
      else if (early.length < EARLY) early.push(d);
      else console.warn("hqView.send: message dropped, the view has not started yet");
    },
    /** fn(msg) for each message of the plugin's client code (hq.ui.post). */
    onMessage(fn) {
      if (typeof fn !== "function") throw new TypeError("expected a function");
      handlers.push(/** @type {(msg: unknown) => void} */ (fn)); // T is the plugin's own claim (view.d.ts)
    },
  }));
  Object.defineProperty(window, "hqView", { value: hqView });

  window.addEventListener("message", (ev) => {
    if (port || ev.source !== window.parent || ev.data !== "hq-view-port" || !ev.ports[0]) return;
    port = ev.ports[0];
    port.onmessage = (m) => {
      if (!m.data || m.data.t !== "msg") return;
      for (const f of handlers) {
        try {
          f(m.data.d);
        } catch (e) {
          console.error(e);
        }
      }
    };
    for (const d of early) port.postMessage({ t: "msg", d });
    early.length = 0;
  });
  // after the view's script ran, so its onMessage handlers are registered before the first message
  window.addEventListener("load", () => window.parent.postMessage("hq-view-ready", "*"));
})();
