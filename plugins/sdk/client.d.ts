// Types of the Home Quarters plugin API in the browser: the global `hq` a plugin's client code gets inside its
// sandboxed iframe. Reference: docs/plugin-api.md. Use it from public/tsconfig.json:
//   { "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2020", "lib": ["ES2020"], "types": [] },
//     "include": ["*.ts", "../../sdk/client.d.ts"] }
// The server compiles TypeScript without checking types: run tsc (or your editor) to check them.

declare global {
  namespace HQ {
    type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

    /** 0 down, 1 left, 2 right, 3 up. */
    type Facing = 0 | 1 | 2 | 3;

    interface Avatar {
      id: number;
      name: string;
      /** World pixels, at the feet. */
      x: number;
      y: number;
      dir: Facing;
      moving: boolean;
    }

    interface World {
      /** My member id (0 until the page knows it). */
      me: number;
      /** The avatars on screen. */
      avatars: Avatar[];
    }

    interface Animation {
      /** Row of the sheet. */
      row: number;
      /** Columns of the sheet, played in order. */
      frames: number[];
      /** Frames a second, 0 for a still frame. */
      fps: number;
    }

    /** Played while moving: walk-<facing> or walk; standing: the one set with setAnim, else idle-<facing> or idle. */
    type Anims = Record<string, Animation>;

    /** An element of a modal or a box on the map, made by hq.ui.text, button, copy, image, row or appToken. */
    interface UINode {
      readonly type: "text" | "button" | "copy" | "image" | "row" | "appToken";
    }

    type ButtonAnchor = "topbar" | "topright" | "bottombar" | "sidebar" | "minimap";
    type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

    interface UI {
      text(text: string, opts?: { muted?: boolean }): UINode;
      button(opts: { label: string; onClick?: () => void; primary?: boolean; pressed?: boolean }): UINode;
      copy(opts: { label: string; value: string }): UINode;
      /** A PNG of the plugin's public/ folder, shown at most 128 px. */
      image(opts: { src: string; alt: string }): UINode;
      row(children: UINode[]): UINode;
      /** Home Quarters' own app token widget (needs "appTokens": true in plugin.json). */
      appToken(): UINode;
      /** A button at an anchor. The label (1-40 characters) defaults to the plugin's title. */
      slot(id: string, anchor: ButtonAnchor, opts?: { label?: string; icon?: string; pressed?: boolean; onClick?: () => void }): void;
      /** A box on the map, at most 240 x 160 px, dx/dy 0-200 px from the corner. */
      slot(id: string, anchor: "screen", opts: { corner: Corner; dx?: number; dy?: number; content: UINode[] }): void;
      unslot(id: string): void;
      /** Opens the plugin's modal or redraws it. */
      modal(opts: { title: string; size?: "small" | "medium" | "large"; place?: "center" | "right"; onClose?: () => void }, content?: UINode[]): void;
      close(): void;
    }

    interface Client {
      /** Your code is ready (also after the page reconnects: the plugin restarts then). */
      onLoad(fn: () => void): void;
      /** About every 100 ms, skipped while the previous call runs. */
      onUpdate(fn: (dt: number, world: World) => void): void;
      /** A message from the plugin's server code (hq.send / hq.broadcast there). Name its type: onMessage<MyMessage>(...). */
      onMessage<T = unknown>(fn: (msg: T) => void): void;
      /** To the plugin's server onMessage (anything JSON.stringify accepts). Throws if over 1500 bytes. */
      send(msg: unknown): void;
      /** A PNG sheet of public/ (at most 2048 px a side), cut into frameW x frameH cells. */
      loadSprite(key: string, path: string, opts: { frameW: number; frameH: number; anims?: Anims }): void;
      /** Without x/y a new sprite waits for follow/moveTo, an existing one keeps its place (only its sheet changes). */
      spawn(id: string, key: string, opts?: { x?: number; y?: number; anim?: string }): void;
      remove(id: string): void;
      /** Walks there in a straight line (px/s, default 72), stopping at the first wall. */
      moveTo(id: string, x: number, y: number, opts?: { speed?: number }): void;
      /** Walks that member's trail gap px behind (default 36); walks back around walls when called from elsewhere. */
      follow(id: string, memberId: number, opts?: { gap?: number }): void;
      stop(id: string): void;
      setAnim(id: string, name: string): void;
      setFlip(id: string, on: boolean): void;
      setVisible(id: string, on: boolean): void;
      ui: UI;
    }
  }

  const hq: HQ.Client;
  /** The iframe's console: warnings and errors show in the browser's developer tools. */
  const console: { log(...parts: unknown[]): void; info(...parts: unknown[]): void; warn(...parts: unknown[]): void; error(...parts: unknown[]): void };
}

export {};
