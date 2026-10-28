import { Container, Rectangle, Sprite, Texture } from "pixi.js";
import type { Anim, Cmd } from "../plugins/commands";
import { LIMITS, framesFit } from "../plugins/commands";
import { followOwner, newPet, type PetState } from "./petFollow";
import { clearLine, findPath, type Point } from "./tilePath";
import { SearchQueue } from "./searchQueue";

// Sprites that plugins ask for (see src/plugins/). The page draws and animates them: a plugin only
// says "load this sheet", "spawn it here", "walk there", "follow that member". Sprites sort with
// avatars and pets by their feet (zIndex = y) and are anchored at the bottom centre of a frame.

export interface Owner {
  x: number;
  y: number;
  dir: number; // 0 down, 1 left, 2 right, 3 up
  /** current speed in px/s (walk or run) */
  v: number;
  /** drawn on screen right now */
  visible: boolean;
}

export interface Avatar {
  id: number;
  name: string;
  x: number;
  y: number;
  dir: number;
  moving: boolean;
}

export interface LayerHost {
  owner(id: number): Owner | null;
  canStand(x: number, y: number): boolean;
  /** Visible avatars, drawn positions. */
  avatars(): Avatar[];
  me(): number;
  /** Where a sprite pinned to a member sits: bottom centre just above their name tag, and the member's feet y
   *  (for sorting). Fills out and returns false when the member is unknown or off screen. */
  headPoint(id: number, out: HeadPoint): boolean;
}

export interface HeadPoint {
  x: number;
  y: number;
  feetY: number;
}

interface Sheet {
  frames: Texture[][] | null; // [row][col], null while loading
  anims: Record<string, Anim>;
  failed: boolean;
  /** the decoded picture, for previews in the plugin's interface (hq.ui.sprite with sheet) */
  bitmap: ImageBitmap | null;
  /** drawn by another plugin's browser code for metadata (hq.provideSheet), and its latest ask */
  provided: { from: string; metadata: unknown } | null;
  ask: number;
}

interface PEnt {
  spr: Sprite;
  key: string;
  mode: "still" | "move" | "walk" | "follow";
  x: number;
  y: number;
  tx: number;
  ty: number;
  speed: number;
  player: number;
  /** the member whose head it is pinned above (hq.attach), 0 when free */
  attached: number;
  /** the sprite of the same plugin it follows instead of a member (follow with { sprite }) */
  target: string | null;
  /** measured speed in px/s, for sprites that follow this one, and where it was on the last step */
  vel: number;
  lastX: number;
  lastY: number;
  gap: number;
  /** px to the owner's side where it rests (plugins line several followers up) */
  beside: number;
  /** px it potters about the owner's feet while they stand still (0: it sits), and its pottering seed */
  roam: number;
  seed: number;
  ps: PetState;
  /** shown above the sprite while the mouse is over it (WorldView), with its owner's name under it */
  label: string | null;
  labelOwner: number;
  dir: number;
  moving: boolean;
  manual: string | null;
  animStart: number;
  shown: boolean; // the plugin's setVisible
  /** drawn somewhere on the map already (so a follow walks back instead of appearing behind the owner) */
  placed: boolean;
  /** waypoints back to the owner when it was told to follow from elsewhere; null when following */
  path: Point[] | null;
  pathTo: Point | null;
  pathAt: number;
  rejoin: boolean;
}

interface Gfx {
  base: string; // URL of the plugin's public/ folder, ending in /
  sheets: Map<string, Sheet>;
  ents: Map<string, PEnt>;
}

const DIRS = ["down", "left", "right", "up"];
const DEFAULT_SPEED = 72;
const DEFAULT_GAP = 36;
const REST_BESIDE = 22; // px to the owner's side where a follower rests

/** A number for a sprite, the same on every page: it seeds its pottering (petFollow.ts). */
function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const facing = (dx: number, dy: number) => (Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : 2) : dy < 0 ? 3 : 0);

export class PluginLayer {
  private plugins = new Map<string, Gfx>();
  /** Gets the sheet another plugin's browser code draws for metadata (set by the PluginManager). */
  provider: ((from: string, metadata: unknown) => Promise<{ image: Blob | ImageBitmap; frameW: number; frameH: number }>) | null = null;
  /** Set when an image finished loading, so the next frame draws it. */
  private loaded = false;
  /** walkTo path searches, a few per frame (a batch may ask for hundreds) */
  private head: HeadPoint = { x: 0, y: 0, feetY: 0 };
  private searches = new SearchQueue<{ e: PEnt; x: number; y: number }>(4);

  constructor(private parent: Container, private host: LayerHost) {}

  /** Starts drawing for a plugin whose assets live under base (".../assets/"). */
  addPlugin(plugin: string, base: string) {
    if (!this.plugins.has(plugin)) this.plugins.set(plugin, { base, sheets: new Map(), ents: new Map() });
  }

  /** Removes everything a plugin drew and the textures it loaded. */
  dropPlugin(plugin: string) {
    const g = this.plugins.get(plugin);
    if (!g) return;
    for (const e of g.ents.values()) e.spr.destroy();
    for (const s of g.sheets.values()) {
      s.frames?.[0]?.[0]?.source.destroy();
      s.bitmap?.close(); // destroying the texture leaves the decoded picture to the garbage collector
    }
    this.plugins.delete(plugin);
    this.loaded = true; // redraw without them
  }

  /** Applies drawing commands. Returns a reason to stop the plugin, or null. */
  apply(plugin: string, cmds: Cmd[], now: number): string | null {
    const g = this.plugins.get(plugin);
    if (!g) return null;
    for (const c of cmds) {
      switch (c.op) {
        case "sprite": {
          if (g.sheets.has(c.key)) break;
          if (g.sheets.size >= LIMITS.sprites) return `more than ${LIMITS.sprites} sprite sheets`;
          const sheet: Sheet = { frames: null, anims: c.anims, failed: false, bitmap: null, provided: c.provided ?? null, ask: 0 };
          g.sheets.set(c.key, sheet);
          // image data the plugin made, or a PNG: its own, or another plugin's shared/ one (same assets URL,
          // under that plugin's name)
          const base = c.from ? g.base.replace(/\/plugins\/[^/]+\/assets\/$/, "/plugins/" + c.from + "/assets/") : g.base;
          if (c.provided) this.askProvider(g, sheet);
          else void this.load(g, sheet, c.image ?? base + c.url, c.frameW, c.frameH); // load() reports its own failures
          break;
        }
        case "spawn": {
          if (!g.sheets.has(c.key)) return `spawn: no sprite sheet "${c.key}"`;
          let e = g.ents.get(c.id);
          if (!e) {
            if (g.ents.size >= LIMITS.entities) return `more than ${LIMITS.entities} sprites`;
            const spr = new Sprite(Texture.EMPTY);
            spr.anchor.set(0.5, 1);
            spr.visible = false;
            this.parent.addChild(spr);
            const x0 = c.x ?? 0, y0 = c.y ?? 0;
            e = { spr, key: c.key, mode: "still", x: x0, y: y0, tx: x0, ty: y0, speed: DEFAULT_SPEED, player: 0, attached: 0, target: null, vel: 0, lastX: x0, lastY: y0, gap: DEFAULT_GAP, beside: REST_BESIDE, roam: 0, seed: seedOf(plugin + "/" + c.id), ps: newPet(), label: null, labelOwner: 0, dir: 0, moving: false, manual: null, animStart: now, shown: true, placed: false, path: null, pathTo: null, pathAt: 0, rejoin: false };
            g.ents.set(c.id, e);
          }
          e.key = c.key;
          if (c.x !== undefined && c.y !== undefined) {
            // a placement: here, standing still; without one the sprite keeps its place and what it does
            e.mode = "still";
            e.x = e.tx = c.x;
            e.y = e.ty = c.y;
            e.moving = false;
          }
          if (c.anim) this.setManual(e, c.anim, now);
          break;
        }
        case "remove": {
          const e = g.ents.get(c.id);
          if (e) {
            e.spr.destroy();
            g.ents.delete(c.id);
            this.loaded = true;
          }
          break;
        }
        case "moveTo": {
          const e = g.ents.get(c.id);
          if (!e || e.attached) break;
          e.mode = "move";
          e.tx = c.x;
          e.ty = c.y;
          e.speed = c.speed ?? DEFAULT_SPEED;
          break;
        }
        case "attach": {
          const e = g.ents.get(c.id);
          if (!e) break;
          e.attached = c.player ?? 0;
          if (e.attached) {
            e.mode = "still"; // it ignores moveTo, walkTo and follow until let go
            e.path = null;
            e.moving = false;
          }
          this.loaded = true;
          break;
        }
        case "follow": {
          const e = g.ents.get(c.id);
          if (!e || e.attached) break;
          // a sprite following another sprite keeps the member it belongs to (debug, hover)
          const target = c.sprite ?? null, player = c.player ?? e.player;
          if (e.mode !== "follow" || e.player !== player || e.target !== target) {
            e.ps = newPet();
            e.rejoin = e.placed; // already on the map: walk back to the owner around walls, no jump
            e.path = null;
          }
          e.mode = "follow";
          e.player = player;
          e.target = target;
          e.gap = c.gap ?? DEFAULT_GAP;
          e.beside = c.beside ?? REST_BESIDE;
          e.roam = c.roam ?? 0;
          break;
        }
        case "stop": {
          const e = g.ents.get(c.id);
          if (e) {
            e.mode = "still";
            e.moving = false;
          }
          break;
        }
        case "anim": {
          const e = g.ents.get(c.id);
          if (e) this.setManual(e, c.name, now);
          break;
        }
        case "flip": {
          const e = g.ents.get(c.id);
          if (e) e.spr.scale.x = c.on ? -1 : 1;
          this.loaded = true;
          break;
        }
        case "visible": {
          const e = g.ents.get(c.id);
          if (e) e.shown = c.on;
          break;
        }
        case "walkTo": {
          // along a path around walls (tilePath.ts); somewhere it cannot reach (off the map, a wall), as close as it can
          const e = g.ents.get(c.id);
          if (!e || e.attached) break;
          // searched on a later frame, within the per-frame budget; until then it keeps what it does
          e.speed = c.speed ?? DEFAULT_SPEED;
          this.searches.request(plugin + "/" + c.id, { e, x: c.x, y: c.y }, ({ e, x, y }) => {
            if (!g.ents.has(c.id) || g.ents.get(c.id) !== e || e.attached) return; // removed, replaced or pinned since
            const walkable = (tx: number, ty: number) => this.host.canStand(tx * 16 + 8, ty * 16 + 8);
            const path = findPath(e.x, e.y, x, y, walkable, undefined, true);
            e.path = path;
            e.mode = path ? "walk" : "still";
            if (!path) this.setMoving(e, false, performance.now());
          });
          break;
        }
        case "label": {
          const e = g.ents.get(c.id);
          if (e) {
            e.label = c.text;
            e.labelOwner = c.owner ?? 0;
          }
          this.loaded = true; // a label under the mouse changes now
          break;
        }
        case "tint": {
          // multiplies the sheet's colours: a light grey sheet takes the colour, dark outlines stay dark
          const e = g.ents.get(c.id);
          if (e) e.spr.tint = c.colour === null ? 0xffffff : parseInt(c.colour.slice(1), 16);
          this.loaded = true;
          break;
        }
        default:
          break; // buttons and messages are the host's
      }
    }
    return null;
  }

  /** Asks the plugin that draws a sheet (hq.provideSheet) for it; an answer to an older ask is dropped. */
  private askProvider(g: Gfx, sheet: Sheet) {
    const { from, metadata } = sheet.provided!;
    const n = ++sheet.ask;
    const ask = this.provider ? this.provider(from, metadata) : Promise.reject(new Error("no provider"));
    // a copy for this sheet: the provider's image may be drawn by other sheets too, and dropping a
    // plugin destroys its textures
    ask.then((s) => createImageBitmap(s.image).then((bmp) => {
      if (sheet.ask !== n) return bmp.close();
      return this.load(g, sheet, bmp, s.frameW, s.frameH);
    })).catch((err) => {
      if (sheet.ask !== n) return;
      sheet.failed = true;
      console.warn(`plugin sprite failed to load: the sheet ${from} draws`, err);
    });
  }

  /** A plugin stopped on this page: the sheets it drew for other plugins go blank, and their sprites
   *  with them, until it runs again (a plugin that is off draws nothing). */
  providerStopped(from: string) {
    for (const g of this.plugins.values()) {
      for (const sheet of g.sheets.values()) {
        if (sheet.provided?.from !== from) continue;
        sheet.ask++; // an answer still on its way is stale
        sheet.frames?.[0]?.[0]?.source.destroy();
        sheet.frames = null;
        sheet.bitmap?.close();
        sheet.bitmap = null;
        sheet.failed = false;
        this.loaded = true;
      }
    }
  }

  /** A plugin started on this page: it is asked again for the sheets it draws that are blank. */
  providerStarted(from: string) {
    for (const g of this.plugins.values()) {
      for (const sheet of g.sheets.values()) {
        if (sheet.provided?.from !== from || sheet.frames) continue;
        sheet.failed = false;
        this.askProvider(g, sheet);
      }
    }
  }

  private setManual(e: PEnt, name: string, now: number) {
    if (e.manual !== name) e.animStart = now;
    e.manual = name;
  }

  /** Decodes a sheet: a URL of plugin assets, or image data the plugin handed over (at most 1 MB, an image). */
  private async load(g: Gfx, sheet: Sheet, from: string | Blob | ImageBitmap, fw: number, fh: number) {
    const what = typeof from === "string" ? from : "image data";
    try {
      let bmp: ImageBitmap;
      if (typeof from === "string") {
        const res = await fetch(from);
        if (!res.ok) throw new Error(String(res.status));
        bmp = await createImageBitmap(await res.blob());
      } else if (from instanceof Blob) {
        if (from.size > LIMITS.imageBytes || !from.type.startsWith("image/")) throw new Error("not an image of at most 1 MB");
        bmp = await createImageBitmap(from);
      } else bmp = from;
      if (bmp.width > LIMITS.image || bmp.height > LIMITS.image || bmp.width < fw || bmp.height < fh || !framesFit(bmp.width, bmp.height, fw, fh)) {
        bmp.close();
        throw new Error("image size");
      }
      if (![...this.plugins.values()].includes(g)) {
        bmp.close();
        return; // the plugin stopped meanwhile
      }
      sheet.bitmap = bmp;
      const base = Texture.from(bmp);
      base.source.scaleMode = "nearest";
      const rows = Math.floor(bmp.height / fh), cols = Math.floor(bmp.width / fw);
      sheet.frames = Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => new Texture({ source: base.source, frame: new Rectangle(c * fw, r * fh, fw, fh) })));
      this.loaded = true;
    } catch (err) {
      sheet.failed = true;
      console.warn("plugin sprite failed to load", what, err);
    }
  }

  /** Moves and animates every plugin sprite; returns whether anything on screen changed. */
  step(dtMs: number, now: number): boolean {
    let changed = this.loaded;
    this.loaded = false;
    this.searches.run();
    const dt = Math.min(dtMs / 1000, 0.1);
    for (const g of this.plugins.values()) {
      for (const e of g.ents.values()) {
        let on = e.shown;
        let z = NaN;
        if (e.attached) {
          // pinned above a member's name tag: it is where they are drawn this frame, and hidden while they are off screen
          if (this.host.headPoint(e.attached, this.head)) {
            e.x = this.head.x;
            e.y = this.head.y;
            z = this.head.feetY + 0.5; // over the member's own drawing
          } else on = false;
        } else if (e.mode === "follow" && e.target !== null) {
          // following another sprite of the plugin, as a pet follows its owner; it waits while that
          // sprite is gone or hidden
          const t = g.ents.get(e.target);
          if (!t || !t.spr.visible) this.setMoving(e, false, now);
          else this.followFrom(e, { x: t.x, y: t.y, dir: t.dir, v: t.vel, visible: true }, dt, now);
        } else if (e.mode === "follow") {
          const o = this.host.owner(e.player);
          if (!o || !o.visible) {
            on = false;
            e.ps.px = NaN; // reappears behind its owner
          } else this.followFrom(e, o, dt, now);
        } else if (e.mode === "walk") {
          let stepPx = e.speed * dt;
          while (stepPx > 0 && e.path?.length) {
            const p = e.path[0], dx = p.x - e.x, dy = p.y - e.y, d = Math.hypot(dx, dy);
            if (d > 0.01) e.dir = facing(dx, dy);
            if (d <= stepPx) {
              e.x = p.x;
              e.y = p.y;
              e.path.shift();
              stepPx -= d;
            } else {
              e.x += (dx / d) * stepPx;
              e.y += (dy / d) * stepPx;
              stepPx = 0;
            }
          }
          if (!e.path?.length) {
            e.mode = "still";
            e.path = null;
          }
          this.setMoving(e, e.mode === "walk", now);
        } else if (e.mode === "move") {
          const dx = e.tx - e.x, dy = e.ty - e.y, d = Math.hypot(dx, dy);
          const stepPx = e.speed * dt;
          if (d <= stepPx || d < 0.3) {
            e.x = e.tx;
            e.y = e.ty;
            e.mode = "still";
            this.setMoving(e, false, now);
          } else {
            const nx = e.x + (dx / d) * stepPx, ny = e.y + (dy / d) * stepPx;
            if (this.host.canStand(nx, ny)) {
              e.x = nx;
              e.y = ny;
              e.dir = facing(dx, dy);
              this.setMoving(e, true, now);
            } else {
              e.mode = "still"; // a wall: stop there rather than walk through it
              this.setMoving(e, false, now);
            }
          }
        }
        // measured only once it is on the map: a first placement is not a run
        const moved = e.placed ? Math.hypot(e.x - e.lastX, e.y - e.lastY) : 0;
        e.lastX = e.x;
        e.lastY = e.y;
        if (dt > 0) e.vel = e.vel * 0.7 + (moved / dt) * 0.3; // smoothed: frames are uneven
        const sheet = g.sheets.get(e.key);
        const tex = sheet?.frames ? this.frameOf(sheet, e, now) : null;
        if (!tex) on = false;
        if (e.spr.visible !== on) {
          e.spr.visible = on;
          changed = true;
        }
        if (!on || !tex) continue;
        const px = Math.round(e.x), py = Math.round(e.y);
        if (tex !== e.spr.texture || px !== e.spr.x || py !== e.spr.y) changed = true;
        e.spr.texture = tex;
        e.spr.position.set(px, py);
        e.placed = true;
        e.spr.zIndex = z === z ? z : e.y;
      }
    }
    return changed;
  }

  /** Follows o (a member, or a sprite standing in for one): back along a path first if it was told to. */
  private followFrom(e: PEnt, o: Owner, dt: number, now: number) {
    if (e.rejoin || e.path) return this.walkBack(e, o, dt, now);
    followOwner(e.ps, o.x, o.y, o.dir, o.v, dt, now, (x, y) => this.host.canStand(x, y), e.gap, { beside: e.beside, roam: e.roam, seed: e.seed, clock: Date.now() });
    e.x = e.ps.px;
    e.y = e.ps.py;
    e.dir = e.ps.dir;
    this.setMoving(e, e.ps.moving, now);
  }

  /** A follower told to follow from elsewhere walks back along a path (tilePath.ts), then follows. */
  private walkBack(e: PEnt, o: Owner, dt: number, now: number) {
    const walkable = (tx: number, ty: number) => this.host.canStand(tx * 16 + 8, ty * 16 + 8);
    const stale = e.pathTo && Math.hypot(o.x - e.pathTo.x, o.y - e.pathTo.y) > 64 && now - e.pathAt > 500;
    if (e.rejoin || stale) {
      e.rejoin = false;
      e.path = findPath(e.x, e.y, o.x, o.y, walkable);
      e.pathTo = { x: o.x, y: o.y };
      e.pathAt = now;
      if (!e.path) return this.startFollowing(e, o, now, true); // unreachable: appear behind the owner
    }
    // hand over to trail following only in a straight line that crosses no wall; out of path with the
    // owner behind a wall (they moved on): search again
    const line = clearLine(e.x, e.y, o.x, o.y, walkable);
    if (line && Math.hypot(o.x - e.x, o.y - e.y) <= e.gap + 6) return this.startFollowing(e, o, now, false);
    if (!e.path || e.path.length === 0) {
      if (line) return this.startFollowing(e, o, now, false);
      if (now - e.pathAt < 500) return; // wait a little before searching again
      e.rejoin = true;
      return;
    }
    let step = Math.max(o.v * 1.2, 60) * dt;
    while (step > 0 && e.path.length) {
      const p = e.path[0], dx = p.x - e.x, dy = p.y - e.y, d = Math.hypot(dx, dy);
      if (d > 0.01) e.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : 2) : dy < 0 ? 3 : 0;
      if (d <= step) {
        e.x = p.x;
        e.y = p.y;
        e.path.shift();
        step -= d;
      } else {
        e.x += (dx / d) * step;
        e.y += (dy / d) * step;
        step = 0;
      }
    }
    this.setMoving(e, true, now);
  }

  /** Hands over to the trail following of petFollow.ts from where the sprite stands. */
  private startFollowing(e: PEnt, o: Owner, now: number, jump: boolean) {
    e.path = null;
    e.pathTo = null;
    e.ps = newPet();
    if (!jump) {
      e.ps.px = e.x;
      e.ps.py = e.y;
      e.ps.trail.push(e.x, e.y, o.x, o.y);
      e.ps.ownerMoved = now;
    }
  }

  private setMoving(e: PEnt, moving: boolean, now: number) {
    if (moving !== e.moving) {
      e.moving = moving;
      e.animStart = now;
      if (moving) e.manual = null; // walking replaces a one-off animation
    }
  }

  /** While moving: walk-<facing> or walk; standing: the plugin's animation, else idle-<facing> or idle. */
  private frameOf(sheet: Sheet, e: PEnt, now: number): Texture | null {
    const a = sheet.anims, d = DIRS[e.dir];
    const anim = e.moving
      ? a["walk-" + d] ?? a.walk ?? a["idle-" + d] ?? a.idle
      : (e.manual ? a[e.manual] : undefined) ?? a["idle-" + d] ?? a.idle;
    const rows = sheet.frames!;
    if (!anim) return rows[0]?.[0] ?? null;
    const n = anim.frames.length;
    const i = anim.fps > 0 ? Math.floor(((now - e.animStart) / 1000) * anim.fps) % n : 0;
    return rows[anim.row]?.[anim.frames[i]] ?? null;
  }

  /** What a plugin's update() sees: the avatars on screen and who I am. */
  worldSnapshot() {
    return { me: this.host.me(), avatars: this.host.avatars() };
  }

  /** A plugin's decoded sheet, for a preview in its interface; null while it loads or if it failed. */
  sheetImage(plugin: string, key: string): ImageBitmap | null {
    return this.plugins.get(plugin)?.sheets.get(key)?.bitmap ?? null;
  }

  /** The labelled sprite drawn at world point (x, y), the front-most one, for the hover tag. */
  labelAt(x: number, y: number): { text: string; owner: number; x: number; top: number } | null {
    let best: PEnt | null = null;
    for (const g of this.plugins.values()) {
      for (const e of g.ents.values()) {
        if (!e.label || !e.spr.visible) continue;
        const w = Math.abs(e.spr.width), h = e.spr.height;
        if (x < e.spr.x - w / 2 || x > e.spr.x + w / 2 || y < e.spr.y - h || y > e.spr.y) continue;
        if (!best || e.spr.y > best.spr.y) best = e;
      }
    }
    return best ? { text: best.label!, owner: best.labelOwner, x: best.spr.x, top: best.spr.y - best.spr.height } : null;
  }

  /** For tests: the sprites of a plugin, by id. */
  debug(plugin: string) {
    const g = this.plugins.get(plugin);
    if (!g) return null;
    return [...g.ents.entries()].map(([id, e]) => ({ id, x: e.x, y: e.y, visible: e.spr.visible, mode: e.mode, player: e.player, key: e.key, moving: e.moving, tint: e.spr.tint, label: e.label, target: e.target, anim: e.manual }));
  }
}
