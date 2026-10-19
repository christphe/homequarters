// Types of the Home Quarters plugin API in the browser: the global `hq` a plugin's client code gets inside its
// sandboxed iframe. Reference: docs/plugin-api.md. Use it from public/tsconfig.json:
//   { "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2020", "lib": ["ES2020", "DOM"], "types": [] },
//     "include": ["*.ts", "../../sdk/client.d.ts"] }
// The iframe is a page: with "DOM" in lib, console, fetch, OffscreenCanvas and createImageBitmap are typed (and work).
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

    /** One cell of a PNG of public/: frame [x, y, w, h] (w, h at most 128), scale 1-6 (default 2), and a tint
     * "#rrggbb" that multiplies its colours, as hq.setTint does on the map. */
    interface SpriteCell {
      /** a PNG of public/, or sheet: the key of a sheet loaded with hq.loadSprite (image data included); one of the two */
      src?: string;
      sheet?: string;
      frame: [x: number, y: number, w: number, h: number];
      scale?: number;
      tint?: string;
    }

    /** An element of a modal or a box on the map, made by hq.ui.text, button, copy, image, row, appToken, color, number, field or sprite. */
    interface UINode {
      readonly type: "text" | "button" | "copy" | "image" | "row" | "appToken" | "color" | "number" | "field" | "sprite";
    }

    type ButtonAnchor = "topbar" | "topright" | "bottombar" | "sidebar" | "minimap";
    type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

    interface UI {
      text(text: string, opts?: { muted?: boolean }): UINode;
      /** A button; sprite shows a picture before its label. */
      button(opts: { label: string; onClick?: () => void; primary?: boolean; pressed?: boolean; sprite?: SpriteCell }): UINode;
      /** One cell of a sheet, for a preview; alt names it for screen readers. */
      sprite(opts: SpriteCell & { alt: string }): UINode;
      copy(opts: { label: string; value: string }): UINode;
      /** A PNG of the plugin's public/ folder, shown at most 128 px. */
      image(opts: { src: string; alt: string }): UINode;
      row(children: UINode[]): UINode;
      /** Home Quarters' own app token widget (needs "appTokens": true in plugin.json). */
      appToken(): UINode;
      /** A colour picker. value and the colour onChange gets are "#rrggbb" (lower case); onChange runs while the colour is
       * being chosen, at most 4 times a second, and with the final one. hideLabel keeps the label for screen readers only. */
      color(opts: { label: string; value: string; hideLabel?: boolean; onChange?: (colour: string) => void }): UINode;
      /** One line of text (maxLength 1-200, default 200); onChange runs once it is entered (Enter or leaving the field), if it changed. */
      field(opts: { label: string; value?: string; maxLength?: number; placeholder?: string; hideLabel?: boolean; onChange?: (text: string) => void }): UINode;
      /** A whole number in min..max; onChange runs once it is entered (Enter or leaving the field), clamped to the range. */
      number(opts: { label: string; value: number; min: number; max: number; onChange?: (value: number) => void }): UINode;
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
      /** With from, a PNG of that other plugin's public/shared/ folder (path starting with "shared/"). */
      loadSprite(key: string, path: string, opts: { frameW: number; frameH: number; anims?: Anims; from?: string }): void;
      /** A sheet from image data the plugin made or downloaded (from a host its manifest declares in externalHosts):
       * a Blob of an image of at most 1 MB, or an ImageBitmap; at most 2048 px a side. An invalid one is not drawn
       * (a console warning), like a missing PNG. */
      loadSprite(key: string, image: Blob | ImageBitmap, opts: { frameW: number; frameH: number; anims?: Anims }): void;
      /** A sheet another plugin's browser code draws for metadata (its hq.provideSheet), as hq-pets does for
       * guest pets put with setPet({ metadata }). Its size comes from that plugin; the sprite waits until it is drawn. */
      loadSprite(key: string, source: { from: string; metadata: Json }, opts: { anims?: Anims }): void;
      /** Draws, on this page, the sheet of a pet this plugin put with hq-pets' setPet({ metadata }): fn gets the
       * metadata and returns a sheet in hq-pets' format (4 rows of 3 cells: still, step A, step B). */
      provideSheet(fn: (metadata: any) => { image: Blob | ImageBitmap; frameW: number; frameH: number } | Promise<{ image: Blob | ImageBitmap; frameW: number; frameH: number }>): void;
      /** Without x/y a new sprite waits for follow/moveTo, an existing one keeps its place (only its sheet changes). */
      spawn(id: string, key: string, opts?: { x?: number; y?: number; anim?: string }): void;
      remove(id: string): void;
      /** Walks there in a straight line (px/s, default 72), stopping at the first wall. */
      moveTo(id: string, x: number, y: number, opts?: { speed?: number }): void;
      /** Walks that member's trail gap px behind (0-200, default 36); walks back around walls when called from elsewhere.
       * When the member stops it rests beside px to their side (0-120, default 22): give each follower its own.
       * With roam (0-48 px), it potters about their feet instead, a new spot about every 20 s, the same on every page. */
      follow(id: string, memberId: number, opts?: { gap?: number; beside?: number; roam?: number }): void;
      /** Follows another sprite of this plugin the same way, gap px behind; it waits while that sprite is gone or hidden. */
      follow(id: string, who: { sprite: string }, opts?: { gap?: number; beside?: number; roam?: number }): void;
      /** Walks there along a path around walls (px/s, default 72); somewhere it cannot reach, it stays where it is. */
      walkTo(id: string, x: number, y: number, opts?: { speed?: number }): void;
      stop(id: string): void;
      setAnim(id: string, name: string): void;
      setFlip(id: string, on: boolean): void;
      setVisible(id: string, on: boolean): void;
      /** One line (1-24 characters) shown above the sprite only while the mouse is over it; null removes it.
       * opts.owner adds that member's current name under it, in brackets. */
      setLabel(id: string, text: string | null, opts?: { owner?: number }): void;
      /** Multiplies the sprite's colours by "#rrggbb": draw a sheet in light greys to give it any colour. null removes the tint. */
      setTint(id: string, colour: string | null): void;
      ui: UI;
    }
  }

  const hq: HQ.Client;
}

export {};
