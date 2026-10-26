// People on the map: their sprites (sorted by their feet in the shared entLayer), name tags with status
// dots and badges, raised hands, emote bubbles, dances and the ring under whoever speaks. Remote people
// are dead-reckoned between server updates (motion.ts); I am drawn where LocalPlayer says.
import { BitmapText, Container, Graphics, Sprite, Text } from "pixi.js";
import type { AvatarSpec, Person, WorldDelta } from "../net/protocol";
import { DANCE, EMOTES } from "./emotes";
import { avatarFramesFor, releaseAvatar, FEET_Y, CELL_H, type AvatarFrames } from "./avatars";
import { retarget, stepRemote, type Remote } from "./motion";
import { TAG_STYLE } from "./mapText";
import type { Layer, ViewContext } from "./layer";
import type { LocalPlayer } from "./localPlayer";
import type { Avatar, HeadPoint, Owner } from "./pluginLayer";

const STATUS_COLOR: Record<string, number> = { available: 0x5ec26a, busy: 0xe5584f, away: 0xf2d14b, offline: 0x8e8e9a, invisible: 0x8e8e9a };
// Name tags sit where they always did (just over a plain head, whose drawing rises 22 px above the feet),
// plus whatever a hat or tall hair adds on top.
const extraHeight = (f: AvatarFrames) => Math.max(0, f.tall - 22);

const DEFAULT_AV: AvatarSpec = { sk: 1, hs: 0, hc: 1, sh: 4, pa: 1 };

/** A person on the map: where they are (Remote, dead-reckoned when they are not me) and what draws them. */
export interface Ent extends Remote {
  id: number;
  key: string;
  frames: AvatarFrames;
  spr: Sprite;
  label: Container;
  text: BitmapText;
  dot: Graphics;
  ring: Graphics | null;
  hand: Text | null;
  danceUntil: number;
  dir: number;
  moving: boolean;
  run: boolean;
  speaking: boolean;
  sharing: boolean;
  inConv: boolean;
  status: string;
  name: string;
  drawnStatus: string;
  drawnConv: boolean;
  drawnShare: boolean;
}

export class AvatarLayer implements Layer {
  private ctx!: ViewContext;
  ents = new Map<number, Ent>();
  /** My own entry in ents, once hello placed me. */
  me: Ent | null = null;
  emotes = new Map<number, { text: Text; until: number }>();
  /** People drawn on screen in the last frame (stats). */
  visible = 0;

  constructor(private player: LocalPlayer) {}

  init(ctx: ViewContext) {
    this.ctx = ctx;
  }

  /** Hello: my own avatar, created once and placed at (x, y). */
  placeMe(id: number, x: number, y: number) {
    if (!this.me) {
      this.me = this.makeEnt(id);
      this.ents.set(id, this.me);
    }
    this.me.x = x;
    this.me.y = y;
  }

  /** The roster changed: looks, names, statuses and hands follow it. */
  setPeople(people: Map<number, Person>) {
    this.ctx.dirty = true;
    // someone who left the office frees their look (once their sprite is gone too); leaving the screen does not
    for (const id of this.ctx.people.keys()) if (!people.has(id) && !this.ents.has(id)) releaseAvatar(id);
    this.ctx.people = people;
    for (const e of this.ents.values()) this.refreshEnt(e);
  }

  setSpeaking(ids: Set<number>) {
    this.ctx.dirty = true;
    for (const e of this.ents.values()) e.speaking = ids.has(e.id);
  }

  setInConversation(ids: Set<number>) {
    this.ctx.dirty = true;
    for (const e of this.ents.values()) e.inConv = ids.has(e.id);
  }

  setSharing(ids: Set<number>) {
    this.ctx.dirty = true;
    for (const e of this.ents.values()) e.sharing = ids.has(e.id);
  }

  showEmote(id: number, kind: number) {
    this.ctx.dirty = true;
    if (kind === DANCE) {
      const e = this.ents.get(id);
      if (e) e.danceUntil = performance.now() + 2400;
      return;
    }
    const emoji = EMOTES[kind - 1];
    if (!emoji || !this.ents.has(id)) return;
    this.emotes.get(id)?.text.destroy();
    const text = new Text({ text: emoji, style: { fontSize: 32 } });
    text.anchor.set(0.5, 1);
    this.ctx.hud.addChild(text);
    this.emotes.set(id, { text, until: performance.now() + 2500 });
  }

  /** Positions of other people from the server (10-15 Hz), and who left the area of interest. */
  applyWorld(m: WorldDelta) {
    const meId = this.ctx.meId;
    if (m.m) {
      for (const [id, x, y, d] of m.m) {
        if (id === meId) continue;
        const dx = ((d >> 2) & 3) - 1;
        const dy = ((d >> 4) & 3) - 1;
        let e = this.ents.get(id);
        if (!e) {
          e = this.makeEnt(id);
          e.tx = e.x = x;
          e.ty = e.y = y;
          this.ents.set(id, e);
        } else {
          retarget(e, x, y); // keep the picture continuous: the difference to the new truth fades out
        }
        e.dir = d & 3;
        e.dx = dx;
        e.dy = dy;
        e.run = ((d >> 6) & 1) === 1;
        e.moving = dx !== 0 || dy !== 0;
      }
    }
    if (m.l) for (const id of m.l) if (id !== meId) this.removeEnt(id);
  }

  clearRemote() {
    for (const id of [...this.ents.keys()]) if (id !== this.ctx.meId) this.removeEnt(id);
  }

  debugEntities() {
    return [...this.ents.values()].filter((e) => e.id !== this.ctx.meId).map((e) => ({ id: e.id, x: e.x, y: e.y }));
  }

  // ---- what the plugin layer reads (pluginLayer.ts, LayerHost) ----
  owner(id: number): Owner | null {
    const e = this.ents.get(id);
    if (!e) return null;
    const p = this.player;
    const fast = e.id === this.ctx.meId ? p.fast : e.run;
    return { x: e.x, y: e.y, dir: e.dir, v: (fast ? p.runMul : 1) * p.speed, visible: e.spr.visible };
  }

  avatars(): Avatar[] {
    return [...this.ents.values()].filter((e) => e.spr.visible).map((e) => ({ id: e.id, name: e.name, x: Math.round(e.x), y: Math.round(e.y), dir: e.dir, moving: e.moving }));
  }

  headPoint(id: number, out: HeadPoint): boolean {
    const e = this.ents.get(id);
    if (!e || !e.spr.visible) return false;
    // the name tag is in screen pixels, over the drawing's real top; the sprite goes 2 px above its top
    out.x = e.x;
    out.y = e.y - (24 * 0.9 + extraHeight(e.frames) + (e.text.height + 2) / this.ctx.cam.S);
    out.feetY = e.y;
    return true;
  }

  // ---- entities ----
  private makeEnt(id: number): Ent {
    const p = this.ctx.people.get(id);
    const frames = avatarFramesFor(id, p?.av ?? DEFAULT_AV);
    const spr = new Sprite(frames[0][0]);
    spr.anchor.set(0.5, FEET_Y / CELL_H);
    this.ctx.entLayer.addChild(spr);
    const label = new Container();
    const dot = new Graphics();
    const text = new BitmapText({ text: p?.n ?? "…", style: TAG_STYLE });
    text.anchor.set(0.5, 1);
    label.addChild(dot, text);
    this.ctx.hud.addChild(label);
    const e: Ent = {
      id, key: "", frames, spr, label, text, dot, ring: null, hand: null, danceUntil: 0, tx: 0, ty: 0, ox: 0, oy: 0, dx: 0, dy: 0, x: 0, y: 0, dir: 0, moving: false, run: false,
      speaking: false, sharing: false, inConv: false, status: p?.s ?? "available", name: p?.n ?? "", drawnStatus: "", drawnConv: false, drawnShare: false,
    };
    this.refreshEnt(e);
    return e;
  }

  private refreshEnt(e: Ent) {
    this.ctx.dirty = true;
    const p = this.ctx.people.get(e.id);
    if (!p) return;
    const frames = avatarFramesFor(e.id, p.av);
    if (frames !== e.frames) {
      // the previous look may just have been destroyed: switch the sprite now, not on the next tick
      e.frames = frames;
      e.spr.texture = frames[e.dir]?.[0] ?? frames[0][0];
    }
    if (e.name !== p.n || e.text.text !== p.n) {
      e.name = p.n;
      e.text.text = p.n;
    }
    e.status = p.s;
    e.spr.alpha = p.s === "offline" ? 0.5 : 1;
    const up = p.h === 1;
    if (up !== !!e.hand) {
      if (up) {
        e.hand = new Text({ text: "✋", style: { fontSize: 15 } });
        e.hand.anchor.set(0, 1);
        e.label.addChild(e.hand);
      } else {
        e.hand!.destroy();
        e.hand = null;
      }
      e.drawnStatus = ""; // re-lay out the badges
    }
  }

  private removeEnt(id: number) {
    this.ctx.dirty = true;
    const e = this.ents.get(id);
    if (!e) return;
    e.spr.destroy();
    e.label.destroy({ children: true });
    e.ring?.destroy();
    this.ents.delete(id);
    this.emotes.get(id)?.text.destroy();
    this.emotes.delete(id);
    if (!this.ctx.people.has(id)) releaseAvatar(id);
  }

  /** Walks remote people on, draws everyone in view (walk cycle, dance, name tag, ring) and the emote bubbles. */
  update(dt: number, now: number): boolean {
    const ctx = this.ctx, cam = ctx.cam, S = cam.S, player = this.player;
    const { width: W, height: H } = ctx.app.screen;
    let changed = false;
    const walkRate = ctx.eco ? 5 : 8;
    let visible = 0;
    for (const e of this.ents.values()) {
      const isMe = e.id === ctx.meId;
      if (isMe) {
        e.x = player.rx; e.y = player.ry; e.dir = player.mdir; e.moving = !!(player.dx || player.dy);
      } else {
        stepRemote(e, ctx.grid, dt, player.speed * (e.run ? player.runMul : 1));
      }
      const sx = Math.round(e.x * S + cam.x);
      const sy = Math.round(e.y * S + cam.y);
      const on = sx > -40 && sx < W + 40 && sy > -60 && sy < H + 60;
      if (e.spr.visible !== on) changed = true;
      e.spr.visible = on;
      e.label.visible = on;
      if (e.ring) e.ring.visible = on && e.speaking;
      if (!on) continue;
      visible++;
      const fast = isMe ? player.fast : e.run;
      let phase = e.moving ? [1, 0, 2, 0][Math.floor((now / 1000) * walkRate * (fast ? 1.6 : 1)) & 3] : 0;
      let dir = e.dir;
      let hop = 0;
      if (e.danceUntil > now && !e.moving) {
        // a little spin-and-step dance: turn every beat, alternate feet, hop on the off-beat
        const beat = Math.floor(now / 170);
        dir = [0, 2, 3, 1][beat & 3];
        phase = (beat & 1) + 1;
        hop = beat & 1 ? -1 : 0;
      }
      const tex = e.frames[dir]?.[phase] ?? e.frames[0][0];
      const px = Math.round(e.x), py = Math.round(e.y) + hop;
      if (tex !== e.spr.texture || px !== e.spr.x || py !== e.spr.y) changed = true;
      e.spr.texture = tex;
      e.spr.position.set(px, py);
      e.spr.zIndex = e.y;
      const ly = sy - (24 * 0.9 + extraHeight(e.frames)) * S;
      if (e.label.x !== sx || e.label.y !== ly) changed = true; // name tags move in screen pixels
      e.label.position.set(sx, ly);
      if (e.drawnStatus !== e.status || e.drawnConv !== e.inConv || e.drawnShare !== e.sharing) this.drawDot(e);
      if (e.speaking) {
        if (!e.ring) { e.ring = new Graphics(); ctx.world.addChildAt(e.ring, 1); }
        e.ring.clear().ellipse(0, 0, 9, 4).stroke({ color: 0x3cc9b0, width: 1.5 });
        e.ring.position.set(Math.round(e.x), Math.round(e.y) - 1);
        e.ring.visible = true;
      }
    }
    this.visible = visible;

    for (const [id, bubble] of this.emotes) {
      const e = this.ents.get(id);
      if (!e || now >= bubble.until) { bubble.text.destroy(); this.emotes.delete(id); changed = true; continue; }
      bubble.text.visible = e.label.visible;
      bubble.text.position.set(e.x * S + cam.x, e.y * S + cam.y - (26 + extraHeight(e.frames)) * S - 28);
    }
    // emote bubbles redraw on their own every frame while one is shown
    return changed || this.emotes.size > 0;
  }

  private drawDot(e: Ent) {
    this.ctx.dirty = true;
    e.drawnStatus = e.status;
    e.drawnConv = e.inConv;
    e.drawnShare = e.sharing;
    const w = e.text.width;
    e.dot.clear().circle(-w / 2 - 6, -6, 3).fill(STATUS_COLOR[e.status] ?? 0x8e8e9a);
    if (e.inConv) e.dot.roundRect(w / 2 + 3, -10, 6, 8, 2).fill(0x3cc9b0);
    if (e.sharing) {
      // a tiny monitor: everybody in the call can see who is presenting
      const x = w / 2 + (e.inConv ? 12 : 3);
      e.dot.roundRect(x, -12, 12, 9, 1).fill(0x1a1526).roundRect(x + 1.5, -10.5, 9, 6, 1).fill(0x6ec8ff).rect(x + 4, -3, 4, 2).fill(0x1a1526);
    }
    if (e.hand) e.hand.position.set(w / 2 + 3 + (e.inConv ? 9 : 0) + (e.sharing ? 15 : 0), 0);
  }

  /** The stage's children go with the application. */
  destroy() {}
}
