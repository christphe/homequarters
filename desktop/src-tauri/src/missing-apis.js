// @ts-check
// What the office's web client uses and this web view lacks, done by the desktop app (src/main.rs adds
// this script on macOS and Linux; WebView2 has both). Each part replaces an API only where it is missing
// or refused, keeps its shape, and stays inert on a page that is not an office.
/**
 * @template T
 * @typedef {{ -readonly [K in keyof T]: T[K] }} Mutable
 */
(() => {
  let idleReplaced = false;
  // IdleDetector (Chromium only): the app reads how long the system has been idle and calls
  // __hqIdle(seconds) every few seconds. Only where the app measures it (__HQ_IDLE__ is set to true).
  if (__HQ_IDLE__ && !("IdleDetector" in window)) {
    /** @type {Set<IdleDetector>} */
    const detectors = new Set();
    let idleSeconds = 0;
    Object.defineProperty(window, "__hqIdle", {
      value: (/** @type {unknown} */ s) => {
        idleSeconds = Number(s) || 0;
        for (const d of detectors) d._update(false);
      },
    });
    class IdleDetector extends EventTarget {
      constructor() {
        super();
        /** @type {"active" | "idle" | null} */
        this.userState = null;
        /** @type {"locked" | "unlocked" | null} */
        this.screenState = null;
        /** @type {((e: Event) => void) | null} */
        this.onchange = null;
        this._threshold = 60000;
      }
      static async requestPermission() {
        return "granted";
      }
      /** @param {{ signal?: AbortSignal, threshold?: number }} [options] */
      async start(options = {}) {
        if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
        this._threshold = Math.max(60000, Number(options.threshold) || 60000);
        this.screenState = "unlocked";
        detectors.add(this);
        options.signal?.addEventListener("abort", () => detectors.delete(this));
        this._update(true);
      }
      /** @param {boolean} first */
      _update(first) {
        const state = idleSeconds * 1000 >= this._threshold ? "idle" : "active";
        if (state === this.userState) return;
        this.userState = state;
        if (first) return;
        const e = new Event("change");
        this.dispatchEvent(e);
        this.onchange?.(e);
      }
    }
    window.IdleDetector = IdleDetector;
    idleReplaced = true;
  }

  // navigator.keyboard.getLayoutMap (Chromium only): what is printed on the keys, so help texts show
  // "Z Q S D" on an AZERTY keyboard. The app reads the system's layout and calls __hqLayout({code: key})
  // when the page loads and when the layout changes. Only where the app reads it (__HQ_LAYOUT__).
  if (__HQ_LAYOUT__ && !navigator.keyboard?.getLayoutMap) {
    /** @type {Map<string, string> | null} */
    let layout = null;
    /** @type {Array<(layout: Map<string, string>) => void>} */
    const waiting = [];
    Object.defineProperty(window, "__hqLayout", {
      value: (/** @type {Record<string, string> | null | undefined} */ keys) => {
        layout = new Map(Object.entries(keys ?? {}));
        for (const resolve of waiting.splice(0)) resolve(layout);
      },
    });
    const keyboard = {
      getLayoutMap: () =>
        layout
          ? Promise.resolve(layout)
          : new Promise((resolve) => {
              waiting.push(resolve);
              setTimeout(() => resolve(layout ?? new Map()), 2000); // no answer: an empty map, like an unknown layout
            }),
      lock: async () => {},
      unlock: () => {},
    };
    Object.defineProperty(navigator, "keyboard", { value: keyboard, configurable: true });
  }

  // Notification: an embedded web view refuses it. A notification is shown by the system instead, through
  // the app's notify command (allowed to office pages only).
  if (!("Notification" in window) || Notification.permission !== "granted") {
    // read when used: the app's own scripts may run after this one
    /**
     * @param {string} cmd
     * @param {Record<string, unknown>} args
     */
    const invoke = (cmd, args) => window.__TAURI_INTERNALS__?.invoke(cmd, args) ?? Promise.reject(new Error("no app"));
    class HQNotification extends EventTarget {
      /**
       * @param {string} title
       * @param {NotificationOptions} [options]
       */
      constructor(title, options = {}) {
        super();
        this.title = String(title);
        this.body = String(options.body ?? "");
        this.tag = options.tag ?? "";
        this.onclick = this.onclose = this.onerror = this.onshow = null;
        invoke("notify", { title: this.title, body: this.body }).catch(() => {});
      }
      close() {}
      static get permission() {
        return window.__TAURI_INTERNALS__ ? "granted" : "denied";
      }
      static async requestPermission() {
        return this.permission;
      }
    }
    // the shape the client uses, not the whole Notification
    window.Notification = /** @type {typeof Notification} */ (/** @type {unknown} */ (HQNotification));
  }

  // Permissions: the client asks whether these are already granted (to resume watching after a reload).
  // Only for what is replaced above; anything else is the web view's own answer.
  const query = navigator.permissions?.query?.bind(navigator.permissions);
  if (query) {
    /** @type {Record<string, (() => boolean) | undefined>} */
    const ours = { notifications: () => Notification.permission === "granted" };
    if (idleReplaced) ours["idle-detection"] = () => true;
    navigator.permissions.query = (descriptor) => {
      const ok = ours[descriptor?.name];
      if (!ok) return query(descriptor);
      const status = /** @type {Mutable<PermissionStatus>} */ (new EventTarget());
      status.name = descriptor.name;
      status.state = ok() ? "granted" : "denied";
      status.onchange = null;
      return Promise.resolve(status);
    };
  }
})();
