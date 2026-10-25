// Types of the Home Quarters plugin API inside a plugin view: the script a manifest "views" entry names, run in the
// sandboxed iframe that hq.ui.view puts in a modal. It gets one global, `hqView`, and nothing of `hq`.
// Reference: docs/plugin-api.md. Use it from a tsconfig that covers the view files:
//   { "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2020", "lib": ["ES2020", "DOM"], "types": [] },
//     "include": ["board.ts", "../../sdk/view.d.ts"] }
// The view is a page: with "DOM" in lib, document, canvas and pointer events are typed (and work).

declare global {
  const hqView: {
    /** To the plugin's client code (the onMessage of the view element). JSON, at most 4096 bytes, 30 a second;
     * over the limit the message is dropped with a console warning. */
    send(msg: unknown): void;
    /** A message from the plugin's client code (hq.ui.post). Name its type: onMessage<MyMessage>(...). */
    onMessage<T = unknown>(fn: (msg: T) => void): void;
  };
}

export {};
