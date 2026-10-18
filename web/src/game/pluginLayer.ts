import { Container, Rectangle, Sprite, Texture } from "pixi.js";
import type { Anim, Cmd } from "../plugins/commands";
import { LIMITS, framesFit } from "../plugins/commands";
import { followOwner, newPet, type PetState } from "./petFollow";
import { clearLine, findPath, type Point } from "./tilePath";

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
  /** x of the owner's own (built-in) pet when it is drawn: a resting creature sits on the other side */
  petX?: number;
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
}

interface Sheet {
  frames: Texture[][] | null; // [row][col], null while loading
  anims: Record<string, Anim>;
  failed: boolean;
}

interface PEnt {
  spr: Sprite;
  key: string;
  mode: "still" | "move" | "follow";
  x: number;
  y: number;
  tx: number;
  ty: number;
  speed: number;
  player: number;
  gap: number;
  ps: PetState;
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

const facing = (dx: number, dy: number) => (Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : 2) : dy < 0 ? 3 : 0);

export class PluginLayer {
  private plugins = new Map<string, Gfx>();
  /** Set when an image finished loading, so the next frame draws it. */
  private loaded = false;

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
    for (const s of g.sheets.values()) s.frames?.[0]?.[0]?.source.destroy();
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
          const sheet: Sheet = { frames: null, anims: c.anims, failed: false };
          g.sheets.set(c.key, sheet);
          this.load(g, sheet, g.base + c.url, c.frameW, c.frameH);
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
            e = { spr, key: c.key, mode: "still", x: x0, y: y0, tx: x0, ty: y0, speed: DEFAULT_SPEED, player: 0, gap: DEFAULT_GAP, ps: newPet(), dir: 0, moving: false, manual: null, animStart: now, shown: true, placed: false, path: null, pathTo: null, pathAt: 0, rejoin: false };
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
          if (!e) break;
          e.mode = "move";
          e.tx = c.x;
          e.ty = c.y;
          e.speed = c.speed ?? DEFAULT_SPEED;
          break;
        }
        case "follow": {
          const e = g.ents.get(c.id);
          if (!e) break;
          if (e.mode !== "follow" || e.player !== c.player) {
            e.ps = newPet();
            e.rejoin = e.placed; // already on the map: walk back to the owner around walls, no jump
            e.path = null;
          }
          e.mode = "follow";
          e.player = c.player;
          e.gap = c.gap ?? DEFAULT_GAP;
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
        default:
          break; // buttons and messages are the host's
      }
    }
    return null;
  }

  private setManual(e: PEnt, name: string, now: number) {
    if (e.manual !== name) e.animStart = now;
    e.manual = name;
  }

  private async load(g: Gfx, sheet: Sheet, url: string, fw: number, fh: number) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const bmp = await createImageBitmap(await res.blob());
      if (bmp.width > LIMITS.image || bmp.height > LIMITS.image || bmp.width < fw || bmp.height < fh || !framesFit(bmp.width, bmp.height, fw, fh)) {
        bmp.close();
        throw new Error("image size");
      }
      if (![...this.plugins.values()].includes(g)) {
        bmp.close();
        return; // the plugin stopped meanwhile
      }
      const base = Texture.from(bmp);
      base.source.scaleMode = "nearest";
      const rows = Math.floor(bmp.height / fh), cols = Math.floor(bmp.width / fw);
      sheet.frames = Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => new Texture({ source: base.source, frame: new Rectangle(c * fw, r * fh, fw, fh) })));
      this.loaded = true;
    } catch (err) {
      sheet.failed = true;
      console.warn("plugin sprite failed to load", url, err);
    }
  }

  /** Moves and animates every plugin sprite; returns whether anything on screen changed. */
  step(dtMs: number, now: number): boolean {
    let changed = this.loaded;
    this.loaded = false;
    const dt = Math.min(dtMs / 1000, 0.1);
    for (const g of this.plugins.values()) {
      for (const e of g.ents.values()) {
        let on = e.shown;
        if (e.mode === "follow") {
          const o = this.host.owner(e.player);
          if (!o || !o.visible) {
            on = false;
            e.ps.px = NaN; // reappears behind its owner
          } else if (e.rejoin || e.path) {
            this.walkBack(e, o, dt, now);
          } else {
            followOwner(e.ps, o.x, o.y, o.dir, o.v, dt, now, (x, y) => this.host.canStand(x, y), e.gap, { beside: REST_BESIDE, avoid: o.petX });
            e.x = e.ps.px;
            e.y = e.ps.py;
            e.dir = e.ps.dir;
            this.setMoving(e, e.ps.moving, now);
          }
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
        e.spr.zIndex = e.y;
      }
    }
    return changed;
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

  /** For tests: the sprites of a plugin, by id. */
  debug(plugin: string) {
    const g = this.plugins.get(plugin);
    if (!g) return null;
    return [...g.ents.entries()].map(([id, e]) => ({ id, x: e.x, y: e.y, visible: e.spr.visible, mode: e.mode, player: e.player, key: e.key, moving: e.moving }));
  }
}
