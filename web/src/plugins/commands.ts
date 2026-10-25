// The commands a plugin's sandboxed iframe sends to the page, and their validation. Pure (no DOM, no
// PixiJS) so it runs under node --test. A batch that fails validation stops the plugin on this page.

export interface Anim {
  row: number;
  frames: number[];
  fps: number;
}

export type Cmd =
  | { op: "sprite"; key: string; url?: string; image?: Blob | ImageBitmap; provided?: { from: string; metadata: unknown }; frameW: number; frameH: number; anims: Record<string, Anim>; from?: string }
  | { op: "provide" }
  | { op: "spawn"; id: string; key: string; x?: number; y?: number; anim?: string }
  | { op: "remove"; id: string }
  | { op: "moveTo"; id: string; x: number; y: number; speed?: number }
  | { op: "follow"; id: string; player?: number; sprite?: string; gap?: number; beside?: number; roam?: number }
  | { op: "tint"; id: string; colour: string | null }
  | { op: "label"; id: string; text: string | null; owner?: number }
  | { op: "walkTo"; id: string; x: number; y: number; speed?: number }
  | { op: "stop"; id: string }
  | { op: "anim"; id: string; name: string }
  | { op: "flip"; id: string; on: boolean }
  | { op: "visible"; id: string; on: boolean }
  | { op: "slot"; id: string; anchor: Anchor; label?: string; icon?: string; click?: string; pressed?: boolean; corner?: Corner; dx?: number; dy?: number; content?: UINode[] }
  | { op: "unslot"; id: string }
  | { op: "modal"; title: string; size: "small" | "medium" | "large"; place: "center" | "right"; close?: string; content: UINode[] }
  | { op: "close" }
  | { op: "send"; d: unknown }
  | { op: "post"; d: unknown };

/** Where a plugin may put things: buttons in Home Quarters' bars, or a floating box on the map (screen). */
export const ANCHORS = ["topbar", "topright", "bottombar", "sidebar", "minimap", "screen"] as const;
export type Anchor = (typeof ANCHORS)[number];
export const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type Corner = (typeof CORNERS)[number];

/** Plugin UI, drawn by Home Quarters. Callbacks are ids the page sends back to the plugin's iframe. */
/** One cell of a PNG of the plugin's public/ folder, scaled up with crisp pixels and optionally tinted. */
export interface SpriteSpec { src?: string; sheet?: string; frame: [number, number, number, number]; scale: number; tint?: string }

export type UINode =
  | { type: "text"; text: string; muted?: boolean }
  | { type: "button"; label: string; click?: string; primary?: boolean; pressed?: boolean; sprite?: SpriteSpec }
  | { type: "sprite"; sprite: SpriteSpec; alt: string }
  | { type: "copy"; label: string; value: string }
  | { type: "image"; src: string; alt: string }
  | { type: "row"; children: UINode[] }
  | { type: "appToken" }
  | { type: "color"; label: string; value: string; change?: string; hideLabel?: boolean }
  | { type: "number"; label: string; value: number; min: number; max: number; change?: string }
  | { type: "field"; label: string; value: string; maxLength: number; placeholder?: string; change?: string; hideLabel?: boolean }
  | { type: "view"; view: string; label: string; height: ViewHeight; message?: string };

export const VIEW_HEIGHTS = ["small", "medium", "large"] as const;
export type ViewHeight = (typeof VIEW_HEIGHTS)[number];

export const LIMITS = {
  batch: 512, // commands per batch
  batchesPerSec: 30,
  idLen: 64,
  label: 40,
  sprites: 32, // loaded sprite sheets per plugin
  entities: 256, // live sprites per plugin
  image: 2048, // px, each side of a sheet
  anims: 32,
  frames: 64,
  sendBytes: 1500, // a message to the plugin's server code, as JSON
  // messages to the server, all plugins of the page together: below the socket's own bucket (10/s,
  // burst 20), so a plugin can never earn its member strikes and a disconnection
  sendRate: 8,
  sendBurst: 16,
  framesPerSheet: 4096,
  slots: 8, // per plugin
  nodes: 64, // per tree
  depth: 4,
  text: 500,
  hoverLabel: 24, // characters of a sprite's hover label
  imageBytes: 1 << 20, // a sprite sheet the plugin hands over as image data
  metadataBytes: 256, // a sheet asked for by metadata (hq-pets guest pets drawn by their plugin)
  field: 200, // characters of a text field
  copy: 2000,
  callbacks: 256,
  screenOffset: 200, // px from the chosen corner
  viewBytes: 4096, // a message between a view and its plugin's client code, as JSON, each way
  viewRate: 30, // such messages a second, each way per view; the rest are dropped
};

class Bad extends Error {}

const str = (v: unknown, what: string, max = LIMITS.idLen): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new Bad(`${what} must be a string of 1 to ${max} characters`);
  return v;
};

const num = (v: unknown, what: string, min: number, max: number, int = false): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) throw new Bad(`${what} must be a number in ${min}..${max}`);
  return v;
};

const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== "boolean") throw new Bad(`${what} must be true or false`);
  return v;
};

const opt = <T>(v: unknown, f: (v: unknown) => T): T | undefined => (v === undefined ? undefined : f(v));

const COORD = 1e5;

/** A path inside the plugin's public/ folder: no scheme, no leading slash, no "..", a .png file. */
const url = (v: unknown): string => {
  const s = str(v, "url", 200);
  if (!/^[A-Za-z0-9_\-./]+\.png$/.test(s) || s.startsWith("/") || s.split("/").some((p) => p === ".." || p === "" || p.startsWith("."))) {
    throw new Bad("url must be a .png path inside the plugin's public/ folder");
  }
  return s;
};

/** A colour as the picker gives it: #rrggbb, lower case. */
const colour = (v: unknown, what = "colour"): string => {
  if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new Bad(`${what} must be a colour like #3fa7d6`);
  return v.toLowerCase();
};

/** A cell of a sheet: src, frame [x, y, w, h] (a cell at most 128 px a side), scale 1-6, tint. */
const sprite = (v: unknown): SpriteSpec => {
  const o = (v ?? {}) as Record<string, unknown>;
  const f = o.frame;
  if (!Array.isArray(f) || f.length !== 4) throw new Bad("frame must be [x, y, w, h]");
  const frame: [number, number, number, number] = [num(f[0], "x", 0, LIMITS.image, true), num(f[1], "y", 0, LIMITS.image, true), num(f[2], "w", 1, 128, true), num(f[3], "h", 1, 128, true)];
  // a PNG of public/ (src), or a sheet the plugin loaded (sheet: its key, maybe made from image data)
  if ((o.src === undefined) === (o.sheet === undefined)) throw new Bad("a sprite needs src or sheet, not both");
  return { src: opt(o.src, url), sheet: opt(o.sheet, (x) => str(x, "sheet")), frame, scale: num(o.scale ?? 2, "scale", 1, 6, true), tint: opt(o.tint, (x) => colour(x, "tint")) };
};

const isImage = (v: unknown) => (typeof Blob !== "undefined" && v instanceof Blob) || (typeof ImageBitmap !== "undefined" && v instanceof ImageBitmap);

const pluginName = (v: unknown): string => {
  if (typeof v !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(v)) throw new Bad("from must be a plugin name");
  return v;
};

/** Another plugin whose shared/ images a plugin may draw (only those: the rest of its public/ is its own). */
const from = (v: unknown, path: unknown): string => {
  if (typeof v !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(v)) throw new Bad("from must be a plugin name");
  if (typeof path !== "string" || !path.startsWith("shared/")) throw new Bad("an image of another plugin must be in its shared/ folder");
  return v;
};

const label = (v: unknown, what = "label"): string => {
  const s = str(v, what, LIMITS.label).trim();
  if (!s) throw new Bad(`${what} must not be blank`);
  return s;
};

const cb = (v: unknown) => str(v, "callback", 16);

const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T => {
  if (!list.includes(v as T)) throw new Bad(`${what} must be one of ${list.join(", ")}`);
  return v as T;
};

const VIEW_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** A UI tree: at most LIMITS.nodes nodes, LIMITS.depth deep; in a modal (views), at most one view. */
function tree(v: unknown, views = false): UINode[] {
  let count = 0, viewCount = 0;
  const walk = (list: unknown, depth: number): UINode[] => {
    if (!Array.isArray(list)) throw new Bad("content must be an array");
    if (depth > LIMITS.depth) throw new Bad(`content deeper than ${LIMITS.depth}`);
    return list.map((n): UINode => {
      if (++count > LIMITS.nodes) throw new Bad(`more than ${LIMITS.nodes} UI elements`);
      const o = (n ?? {}) as Record<string, unknown>;
      switch (o.type) {
        case "text": return { type: "text", text: str(o.text, "text", LIMITS.text), muted: opt(o.muted, (x) => bool(x, "muted")) };
        case "button": return { type: "button", label: label(o.label), click: opt(o.click, cb), primary: opt(o.primary, (x) => bool(x, "primary")), pressed: opt(o.pressed, (x) => bool(x, "pressed")), sprite: opt(o.sprite, sprite) };
        case "sprite": return { type: "sprite", sprite: sprite(o.sprite), alt: str(o.alt, "alt", LIMITS.label) };
        case "copy": return { type: "copy", label: label(o.label), value: str(o.value, "value", LIMITS.copy) };
        case "image": return { type: "image", src: url(o.src), alt: str(o.alt, "alt", LIMITS.label) };
        case "row": return { type: "row", children: walk(o.children, depth + 1) };
        case "appToken": return { type: "appToken" };
        case "color": return { type: "color", label: label(o.label), value: colour(o.value, "value"), change: opt(o.change, cb), hideLabel: opt(o.hideLabel, (x) => bool(x, "hideLabel")) };
        case "field": {
          const maxLength = num(o.maxLength ?? LIMITS.field, "maxLength", 1, LIMITS.field, true);
          const value = o.value ?? "";
          if (typeof value !== "string" || value.length > maxLength) throw new Bad(`value must be text of at most ${maxLength} characters`);
          return { type: "field", label: label(o.label), value, maxLength, placeholder: opt(o.placeholder, (x) => str(x, "placeholder", LIMITS.label)), change: opt(o.change, cb), hideLabel: opt(o.hideLabel, (x) => bool(x, "hideLabel")) };
        }
        case "number": {
          const min = num(o.min, "min", -1e6, 1e6, true), max = num(o.max, "max", min, 1e6, true);
          return { type: "number", label: label(o.label), value: num(o.value, "value", min, max, true), min, max, change: opt(o.change, cb) };
        }
        case "view": {
          if (!views) throw new Bad("a view goes in a modal");
          if (++viewCount > 1) throw new Bad("at most one view per modal");
          if (typeof o.view !== "string" || !VIEW_NAME.test(o.view)) throw new Bad("view must be the name of a view of the manifest");
          return { type: "view", view: o.view, label: label(o.label), height: oneOf(o.height ?? "medium", VIEW_HEIGHTS, "height"), message: opt(o.message, cb) };
        }
      }
      throw new Bad(`unknown UI element ${String(o.type).slice(0, 20)}`);
    });
  };
  return walk(v, 1);
}

const clampOffset = (v: unknown, what: string) => Math.max(0, Math.min(LIMITS.screenOffset, num(v ?? 0, what, -1e6, 1e6)));

const anims = (v: unknown): Record<string, Anim> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Bad("anims must be an object");
  const entries = Object.entries(v);
  if (entries.length > LIMITS.anims) throw new Bad(`at most ${LIMITS.anims} animations`);
  const out: Record<string, Anim> = {};
  for (const [name, a] of entries) {
    str(name, "animation name");
    const o = a as Record<string, unknown>;
    if (!Array.isArray(o?.frames) || o.frames.length === 0 || o.frames.length > LIMITS.frames) throw new Bad(`animation ${name}: 1 to ${LIMITS.frames} frames`);
    out[name] = {
      row: num(o.row, "row", 0, 255, true),
      frames: o.frames.map((f) => num(f, "frame", 0, 255, true)),
      fps: num(o.fps ?? 0, "fps", 0, 60),
    };
  }
  return out;
};

function parseOne(c: unknown): Cmd {
  if (typeof c !== "object" || c === null) throw new Bad("a command must be an object");
  const o = c as Record<string, unknown>;
  switch (o.op) {
    case "provide":
      return { op: "provide" };
    case "sprite":
      if (o.provided !== undefined) {
        // a sheet another plugin's browser code draws from metadata (hq.provideSheet); its size comes with it
        if (o.url !== undefined || o.image !== undefined || o.from !== undefined) throw new Bad("{ from, metadata } goes alone, without a path, image data or from");
        const p = o.provided as Record<string, unknown>;
        const json = typeof p === "object" && p !== null ? JSON.stringify(p.metadata) : undefined;
        if (json === undefined || new TextEncoder().encode(json).length > LIMITS.metadataBytes) throw new Bad(`metadata must be JSON of at most ${LIMITS.metadataBytes} bytes`);
        return { op: "sprite", key: str(o.key, "key"), provided: { from: pluginName(p.from), metadata: JSON.parse(json) }, frameW: 0, frameH: 0, anims: anims(o.anims ?? {}) };
      }
      if ((o.url === undefined) === (o.image === undefined)) throw new Bad("loadSprite needs a path or image data, not both");
      // image data (a Blob or an ImageBitmap the plugin made): its size and type are checked when it is decoded
      if (o.image !== undefined && !isImage(o.image)) throw new Bad("image must be a Blob or an ImageBitmap");
      if (o.image !== undefined && o.from !== undefined) throw new Bad("from goes with a path, not image data");
      return { op: "sprite", key: str(o.key, "key"), url: opt(o.url, url), image: o.image as Blob | ImageBitmap | undefined, frameW: num(o.frameW, "frameW", 1, 256, true), frameH: num(o.frameH, "frameH", 1, 256, true), anims: anims(o.anims ?? {}), from: opt(o.from, (v) => from(v, o.url)) };
    case "spawn": {
      // without a position an existing sprite keeps its place (only its picture changes)
      if ((o.x === undefined) !== (o.y === undefined)) throw new Bad("spawn needs both x and y, or neither");
      return { op: "spawn", id: str(o.id, "id"), key: str(o.key, "key"), x: opt(o.x, (v) => num(v, "x", -COORD, COORD)), y: opt(o.y, (v) => num(v, "y", -COORD, COORD)), anim: opt(o.anim, (v) => str(v, "anim")) };
    }
    case "remove":
    case "stop":
    case "unslot":
      return { op: o.op, id: str(o.id, "id") };
    case "slot": {
      const anchor = oneOf(o.anchor, ANCHORS, "anchor");
      if (anchor === "screen") {
        return { op: "slot", id: str(o.id, "id"), anchor, corner: oneOf(o.corner, CORNERS, "corner"), dx: clampOffset(o.dx, "dx"), dy: clampOffset(o.dy, "dy"), content: tree(o.content) };
      }
      // without a label the button is named after the plugin (its title)
      return { op: "slot", id: str(o.id, "id"), anchor, label: opt(o.label, label), icon: opt(o.icon, url), click: opt(o.click, cb), pressed: opt(o.pressed, (x) => bool(x, "pressed")) };
    }
    case "modal":
      return { op: "modal", title: label(o.title, "title"), size: oneOf(o.size ?? "medium", ["small", "medium", "large"] as const, "size"), place: oneOf(o.place ?? "center", ["center", "right"] as const, "place"), close: opt(o.close, cb), content: tree(o.content, true) };
    case "close":
      return { op: "close" };
    case "moveTo":
      return { op: "moveTo", id: str(o.id, "id"), x: num(o.x, "x", -COORD, COORD), y: num(o.y, "y", -COORD, COORD), speed: opt(o.speed, (v) => num(v, "speed", 1, 1000)) };
    case "follow": {
      // a member's trail, or another sprite of the same plugin (one of the two)
      const id = str(o.id, "id");
      if ((o.player === undefined) === (o.sprite === undefined)) throw new Bad("follow needs a player or a sprite, not both");
      const sprite = opt(o.sprite, (v) => str(v, "sprite"));
      if (sprite === id) throw new Bad("a sprite cannot follow itself");
      return { op: "follow", id, player: opt(o.player, (v) => num(v, "player", 1, 2 ** 32 - 1, true)), sprite, gap: opt(o.gap, (v) => num(v, "gap", 0, 200)), beside: opt(o.beside, (v) => num(v, "beside", 0, 120)), roam: opt(o.roam, (v) => num(v, "roam", 0, 48)) };
    }
    case "label": {
      if (o.text !== null && (typeof o.text !== "string" || /[\u0000-\u001f\u007f]/.test(o.text))) throw new Bad("text must be one line of text or null");
      const text = o.text === null ? null : str(o.text, "text", LIMITS.hoverLabel);
      return { op: "label", id: str(o.id, "id"), text, owner: opt(o.owner, (v) => num(v, "owner", 1, 2 ** 32 - 1, true)) };
    }
    case "walkTo":
      return { op: "walkTo", id: str(o.id, "id"), x: num(o.x, "x", -COORD, COORD), y: num(o.y, "y", -COORD, COORD), speed: opt(o.speed, (v) => num(v, "speed", 1, 1000)) };
    case "tint":
      return { op: "tint", id: str(o.id, "id"), colour: o.colour === null ? null : colour(o.colour) };
    case "anim":
      return { op: "anim", id: str(o.id, "id"), name: str(o.name, "name") };
    case "flip":
    case "visible":
      return { op: o.op, id: str(o.id, "id"), on: bool(o.on, "on") };
    case "send":
      return { op: "send", d: o.d };
    case "post":
      // to the open view: checked (checkViewMessage) and rate limited when the page relays it, dropped if bad
      return { op: "post", d: o.d };
  }
  throw new Bad(`unknown command ${String(o.op).slice(0, 20)}`);
}

/** Whether a w x h image cut into fw x fh frames stays within LIMITS.framesPerSheet. */
export const framesFit = (w: number, h: number, fw: number, fh: number) => Math.floor(w / fw) * Math.floor(h / fh) <= LIMITS.framesPerSheet;

/** Token bucket for the page's plugin messages to the server (LIMITS.sendRate a second, LIMITS.sendBurst). */
export class SendBudget {
  private tokens: number = LIMITS.sendBurst;
  private at = -1;
  allow(now: number): boolean {
    if (this.at >= 0) this.tokens = Math.min(LIMITS.sendBurst, this.tokens + ((now - this.at) / 1000) * LIMITS.sendRate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

/** Why a message between a view and its plugin's client code cannot go through (not JSON, or over
 *  LIMITS.viewBytes), or null. Such a message is dropped; the view and the plugin go on. */
export function checkViewMessage(d: unknown): string | null {
  let s: string | undefined;
  try {
    s = JSON.stringify(d);
  } catch {
    return "the message is not JSON";
  }
  if (s === undefined) return "the message is not JSON";
  if (new TextEncoder().encode(s).length > LIMITS.viewBytes) return `the message is over ${LIMITS.viewBytes} bytes`;
  return null;
}

/** LIMITS.viewRate messages in any second, one direction of one view. Dropped messages do not count. */
export class ViewRate {
  private times: number[] = [];
  allow(now: number): boolean {
    while (this.times.length > 0 && now - this.times[0] >= 1000) this.times.shift();
    if (this.times.length >= LIMITS.viewRate) return false;
    this.times.push(now);
    return true;
  }
}

/** Validates a batch. Returns the commands, or the reason to stop the plugin. */
export function parseBatch(raw: unknown): Cmd[] | string {
  if (!Array.isArray(raw)) return "a batch must be an array";
  if (raw.length > LIMITS.batch) return `more than ${LIMITS.batch} commands in one batch`;
  try {
    return raw.map(parseOne);
  } catch (e) {
    if (e instanceof Bad) return e.message;
    throw e;
  }
}
