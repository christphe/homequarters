// What the desktop shell gives the two plain JavaScript files checked by tsconfig.json.

/** Replaced with true or false by the shell before it inlines src-tauri/src/missing-apis.js (main.rs). */
declare const __HQ_IDLE__: boolean;
declare const __HQ_LAYOUT__: boolean;

/** The Tauri bridge, as the two scripts use it: only the calls they make, their results unchecked JSON. */
interface TauriInvoke {
  (cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface Window {
  /** Tauri's global API ("withGlobalTauri": true in tauri.conf.json), on the app's own pages (ui/setup.js). */
  readonly __TAURI__: { readonly core: { readonly invoke: TauriInvoke } };
  /** Tauri's internal bridge, on every page the shell opens; missing in a plain browser. */
  readonly __TAURI_INTERNALS__?: { readonly invoke: TauriInvoke };
  /** Chromium's IdleDetector; src-tauri/src/missing-apis.js puts its own where it is missing. */
  IdleDetector?: new () => EventTarget;
}

interface Navigator {
  /** Chromium's Keyboard API (not in TypeScript's DOM lib); missing-apis.js puts its own where it is missing. */
  readonly keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> };
}
