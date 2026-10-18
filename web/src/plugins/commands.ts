// The commands a plugin's sandboxed iframe sends to the page, and their validation. Pure (no DOM, no
// PixiJS) so it runs under node --test. A batch that fails validation stops the plugin on this page.

export interface Anim {
  row: number;
  frames: number[];
  fps: number;
}

export type Cmd =
  | { op: "sprite"; key: string; url: string; frameW: number; frameH: number; anims: Record<string, Anim> }
  | { op: "spawn"; id: string; key: string; x?: number; y?: number; anim?: string }
  | { op: "remove"; id: string }
  | { op: "moveTo"; id: string; x: number; y: number; speed?: number }
  | { op: "follow"; id: string; player: number; gap?: number }
  | { op: "stop"; id: string }
  | { op: "anim"; id: string; name: string }
  | { op: "flip"; id: string; on: boolean }
  | { op: "visible"; id: string; on: boolean }
  | { op: "slot"; id: string; anchor: Anchor; label?: string; icon?: string; click?: string; pressed?: boolean; corner?: Corner; dx?: number; dy?: number; content?: UINode[] }
  | { op: "unslot"; id: string }
  | { op: "modal"; title: string; size: "small" | "medium" | "large"; place: "center" | "right"; close?: string; content: UINode[] }
  | { op: "close" }
  | { op: "send"; d: unknown };

/** Where a plugin may put things: buttons in Home Quarters' bars, or a floating box on the map (screen). */
export const ANCHORS = ["topbar", "topright", "bottombar", "sidebar", "minimap", "screen"] as const;
export type Anchor = (typeof ANCHORS)[number];
export const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type Corner = (typeof CORNERS)[number];

/** Plugin UI, drawn by Home Quarters. Callbacks are ids the page sends back to the plugin's iframe. */
export type UINode =
  | { type: "text"; text: string; muted?: boolean }
  | { type: "button"; label: string; click?: string; primary?: boolean; pressed?: boolean }
  | { type: "copy"; label: string; value: string }
  | { type: "image"; src: string; alt: string }
  | { type: "row"; children: UINode[] }
  | { type: "appToken" };

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
  copy: 2000,
  callbacks: 256,
  screenOffset: 200, // px from the chosen corner
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

/** A UI tree: at most LIMITS.nodes nodes, LIMITS.depth deep. */
function tree(v: unknown): UINode[] {
  let count = 0;
  const walk = (list: unknown, depth: number): UINode[] => {
    if (!Array.isArray(list)) throw new Bad("content must be an array");
    if (depth > LIMITS.depth) throw new Bad(`content deeper than ${LIMITS.depth}`);
    return list.map((n): UINode => {
      if (++count > LIMITS.nodes) throw new Bad(`more than ${LIMITS.nodes} UI elements`);
      const o = (n ?? {}) as Record<string, unknown>;
      switch (o.type) {
        case "text": return { type: "text", text: str(o.text, "text", LIMITS.text), muted: opt(o.muted, (x) => bool(x, "muted")) };
        case "button": return { type: "button", label: label(o.label), click: opt(o.click, cb), primary: opt(o.primary, (x) => bool(x, "primary")), pressed: opt(o.pressed, (x) => bool(x, "pressed")) };
        case "copy": return { type: "copy", label: label(o.label), value: str(o.value, "value", LIMITS.copy) };
        case "image": return { type: "image", src: url(o.src), alt: str(o.alt, "alt", LIMITS.label) };
        case "row": return { type: "row", children: walk(o.children, depth + 1) };
        case "appToken": return { type: "appToken" };
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
    case "sprite":
      return { op: "sprite", key: str(o.key, "key"), url: url(o.url), frameW: num(o.frameW, "frameW", 1, 256, true), frameH: num(o.frameH, "frameH", 1, 256, true), anims: anims(o.anims ?? {}) };
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
      return { op: "modal", title: label(o.title, "title"), size: oneOf(o.size ?? "medium", ["small", "medium", "large"] as const, "size"), place: oneOf(o.place ?? "center", ["center", "right"] as const, "place"), close: opt(o.close, cb), content: tree(o.content) };
    case "close":
      return { op: "close" };
    case "moveTo":
      return { op: "moveTo", id: str(o.id, "id"), x: num(o.x, "x", -COORD, COORD), y: num(o.y, "y", -COORD, COORD), speed: opt(o.speed, (v) => num(v, "speed", 1, 1000)) };
    case "follow":
      return { op: "follow", id: str(o.id, "id"), player: num(o.player, "player", 1, 2 ** 32 - 1, true), gap: opt(o.gap, (v) => num(v, "gap", 0, 200)) };
    case "anim":
      return { op: "anim", id: str(o.id, "id"), name: str(o.name, "name") };
    case "flip":
    case "visible":
      return { op: o.op, id: str(o.id, "id"), on: bool(o.on, "on") };
    case "send":
      return { op: "send", d: o.d };
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
