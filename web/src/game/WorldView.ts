import { Application, BitmapText, Cache, Container, Graphics, Rectangle, Sprite, Text, TextStyle, Texture } from "pixi.js";
import type { Ack, AvatarSpec, MapData, Person, PluginObjectSpec, Prop, SelfPosition, WorldDelta } from "../net/protocol";
import { DANCE, EMOTES } from "./emotes";
import { MOVE_KEYS, codeOf, digitOf, learnKey } from "../keys";
import { isBusyKey, isHomeKey } from "./home";
import { isPluginProp, propSize } from "./props";
import { nearestUsable, objectsFor } from "./pluginObjects";
import { ObjectPictures } from "./objectPictures";
import { t } from "../i18n";
import { avatarFramesFor, releaseAvatar, FEET_Y, CELL_H, type AvatarFrames } from "./avatars";
import { bakeMap } from "./mapArt";
import { bakeMapCanvas } from "./art/tiles";
import { depthAtlas } from "./art/objects";
import { PluginLayer } from "./pluginLayer";
import { areaTitle, deskTitle, type NameOf } from "./places";
import { SAME, SHOWN, Whereabouts, areaGrid, areaIndex, deskRoom, shownArea, shownAreas } from "./areas";

const T = 16;
// Reference view in world pixels. A 240x160 handheld screen would be 15x10 tiles; an office wants a little more room.
const VIEW_REF_W = 320;
const VIEW_REF_H = 200;
const MAX_SCALE = 8;
const WHEEL_GAP_MS = 120; // at most one zoom step per this long, so a trackpad or a free-spinning wheel does not race through every level
// world px kept inside the interest radius beyond what is visible: a sprite drawn above its feet,
// and my predicted position running ahead of the server's
const VIEW_PAD = 24;
const DRAG_PX = 4; // a mouse press moving less than this is a click, not a drag
// Jersey 10 is drawn on a 10 px grid and has a small x-height: map text uses twice its grid (20 px,
// 30 for the area banner), which stays crisp and reads like the interface.
const FONT = '"Jersey 10", ui-monospace, Menlo, monospace';
// One TextStyle per look, shared by every BitmapText that wears it: Pixi keys a stroked bitmap font
// (its own glyph atlas, never freed) by the TextStyle instance, so a style per label made a font per label.
// Never destroy a text with { style: true } (or destroy(true)): it would break every label sharing the style.
const OUTLINE = { color: 0x1a1526, width: 3 };
const TAG_STYLE = new TextStyle({ fontFamily: FONT, fontSize: 20, fill: 0xffffff, stroke: OUTLINE });
const DESK_STYLE = new TextStyle({ fontFamily: FONT, fontSize: 20, fill: 0xffe9a8, stroke: OUTLINE });
const NOTE_STYLE = new TextStyle({ fontFamily: FONT, fontSize: 18, fill: 0xffe9a8, align: "center", stroke: OUTLINE });
const PLUGIN_NOTE_STYLE = new TextStyle({ fontFamily: FONT, fontSize: 18, fill: 0x9fe0ff, align: "center", stroke: OUTLINE });
// no outline: on the light plate it only smeared the pixel letters
const BANNER_STYLE = new TextStyle({ fontFamily: FONT, fontSize: 30, fill: 0x383858 });
/** For tests: how many bitmap fonts Pixi holds (it keeps them in its asset cache under keys holding "-bitmap"). */
export const bitmapFonts = () => [...(Cache as unknown as { _cache: Map<unknown, unknown> })._cache.keys()].filter((k) => typeof k === "string" && k.includes("-bitmap")).length;
const BOX_HW = 5;
const BOX_HH = 3;
// Movement rules shared with the server (world.move): sub-steps of at most SUB_STEP_PX so no wall
// is skipped, and a blocked axis moves to the point of contact, so the result does not depend on
// how time was split into frames or ticks.
const SUB_STEP_PX = 4;
const MAX_ADVANCE = 1; // seconds integrated at most in one go (a backgrounded tab)
const OFFSET_TAU = 0.08; // seconds over which a remote correction blends in
const SELF_TAU = 0.12; // seconds over which a correction of my own position blends in
// ...but on each axis never faster than this fraction of the slowest per-axis walking speed (a diagonal
// walk), so a held key never draws a step back in any direction
const SELF_BLEND_FRAC = 0.6;
const SNAP_PX = 128; // larger corrections are not network jitter: no blending (teleports reset the offset anyway)
// Render on demand: a frame is drawn only when something on screen changed, plus this slow
// heartbeat as a safety net. An office is mostly people standing still; redrawing an unchanged
// scene 60 times a second kept the GPU awake for nothing.
const IDLE_RENDER_MS = 250;
const HEARTBEAT_MS = 400; // re-send held input so the server can correct drift
const STATUS_COLOR: Record<string, number> = { available: 0x5ec26a, busy: 0xe5584f, away: 0xf2d14b, offline: 0x8e8e9a, invisible: 0x8e8e9a };
// Name tags sit where they always did (just over a plain head, whose drawing rises 22 px above the feet),
// plus whatever a hat or tall hair adds on top.
const extraHeight = (f: AvatarFrames) => Math.max(0, f.tall - 22);

const DEFAULT_AV: AvatarSpec = { sk: 1, hs: 0, hc: 1, sh: 4, pa: 1 };

/** Where a box of half size `half` moving in direction v touches the tile edge it crosses reaching c (server: contact). */
function contact(c: number, v: number, half: number) {
  return v > 0 ? Math.floor((c + half - 0.001) / T) * T - half : (Math.floor((c - half) / T) + 1) * T + half;
}

interface Ent {
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
  // Remote entities are dead-reckoned: the server sends state changes (position + direction),
  // the client keeps walking the entity with the same collision rules. (tx,ty) is the extrapolated
  // truth, (ox,oy) a short-lived offset that hides corrections.
  tx: number;
  ty: number;
  ox: number;
  oy: number;
  dx: number;
  dy: number;
  x: number;
  y: number;
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

export interface ViewHooks {
  sendInput(seq: number, dx: number, dy: number, run: boolean): void;
  onArea(name: string, index: number): void;
  onResume(): void;
  onEmote?(kind: number): void;
  onHand?(): void;
  onInteract?(prop: Prop): void;
  onNearby?(prop: Prop | null): void;
  onGoto?(tx: number, ty: number): void;
  onRun?(on: boolean): void;
  /** Interest radius, in server cells, the visible map needs; called only when it changes. */
  onView?(cells: number): void;
  /** Ctrl+D / Cmd+D: go back to my desk. */
  onHome?(): void;
  onBusy?(): void;
}

export interface ViewStats {
  fps: number;
  frameMs: number;
  worldMsgs: number;
  entities: number;
  visible: number;
  /** Frames actually drawn per second (render on demand). */
  renders: number;
}

export class WorldView {
  private app!: Application;
  private world = new Container();
  private entLayer = new Container();
  private hud = new Container();
  private fxG = new Graphics();
  private hudG = new Graphics();
  private banner = new Container();
  private bannerG = new Graphics();
  private bannerText: BitmapText | null = null;
  private bannerT0 = -1e9;
  private bannerW = 0;
  private areaLabels: { text: BitmapText; ai: number }[] = [];
  private deskLabels: { text: BitmapText; x: number; y: number; p: Prop; ai: number }[] = [];
  private ents = new Map<number, Ent>();
  /** Sprites drawn for plugins (src/plugins): they sort with avatars. */
  readonly plugins = new PluginLayer(this.entLayer, {
    owner: (id) => {
      const e = this.ents.get(id);
      if (!e) return null;
      const fast = e.id === this.meId ? this.fast : e.run;
      return { x: e.x, y: e.y, dir: e.dir, v: (fast ? this.runMul : 1) * this.speed, visible: e.spr.visible };
    },
    canStand: (x, y) => !!this.map && this.canStandStatic(x, y),
    avatars: () => [...this.ents.values()].filter((e) => e.spr.visible).map((e) => ({ id: e.id, name: e.name, x: Math.round(e.x), y: Math.round(e.y), dir: e.dir, moving: e.moving })),
    me: () => this.meId,
    headPoint: (id, out) => {
      const e = this.ents.get(id);
      if (!e || !e.spr.visible) return false;
      // the name tag is in screen pixels, over the drawing's real top; the sprite goes 2 px above its top
      out.x = e.x;
      out.y = e.y - (24 * 0.9 + extraHeight(e.frames) + (e.text.height + 2) / this.S);
      out.feetY = e.y;
      return true;
    },
  });
  private people = new Map<number, Person>();
  /** Names of the members places belong to (the server's owner names); online people fill the gaps. */
  private owners = new Map<number, string>();
  private nameOf: NameOf = (id) => this.owners.get(id) ?? this.people.get(id)?.n;
  private map: MapData | null = null;
  private solid = new Uint8Array(0);
  /** The map's tiles: which area each is in. */
  private grid = { w: 0, h: 0, areaAt: new Int16Array(0) };
  // the area named to the player for each area: itself, or for a desk room the area it sits in
  private shownOf = new Int16Array(0);
  /** My area (room access) and the area named for it (the signboard). */
  private where = new Whereabouts();
  private deny = new Set<number>();
  private speed = 72;
  private runMul = 2;
  private runHeld = false; // Shift
  private runToggle = false; // "always run" (R or the HUD button)
  private dest: { x: number; y: number } | null = null;
  private baked: HTMLCanvasElement | null = null;
  private S = 3;
  private zoom = readZoom(); // whole steps away from the automatic scale (wheel); negative = farther
  private wheelAt = 0;
  // camera pan (left-drag with a mouse): world px added to the followed position; moving recentres
  private panX = 0;
  private panY = 0;
  private drag: { id: number; x: number; y: number; camX: number; camY: number; moved: boolean } | null = null;
  /** The mouse over the map (canvas pixels), for the name of a plugin sprite under it; null elsewhere or for touch. */
  private mouse: { x: number; y: number } | null = null;
  /** A plugin sprite's label and its owner's name, shown while the mouse is over the sprite. */
  private hoverTag = new BitmapText({ text: "", style: NOTE_STYLE });
  private dragEndAt = 0;
  // the server's area of interest (hello): its cell size, default and largest radius in cells
  private cellPx = 0;
  private aoi = 0;
  private aoiMax = 0;
  private viewCells = 0; // radius last asked for (0 = the server default)
  private camX = 0;
  private camY = 0;
  private mapSprite: Sprite | null = null;
  /** Desks and pcs drawn again over the bake, sorted with the avatars (art/objects.ts), and their atlas. */
  private depthSprites: Sprite[] = [];
  private depthTex: Texture | null = null;
  private keys = new Set<string>();
  private destroyed = false;

  // local player
  meId = 0;
  private meEnt: Ent | null = null;
  private mx = 0;
  private my = 0;
  private dx = 0;
  private dy = 0;
  private mdir = 0;
  private seq = 0;
  private hist = new Map<number, { x: number; y: number }>();
  private lastAck = 0; // newest acknowledgement sequence applied
  private lastBeat = 0;
  private lastLocal = 0; // performance.now() the local position was integrated to
  // visual offset that hides reconciliation: the avatar is drawn at (mx+vox, my+voy)
  private vox = 0;
  private voy = 0;

  // stats
  private nFrames = 0;
  private msFrames = 0;
  private lastStat = performance.now();
  private nWorld = 0;
  stats: ViewStats = { fps: 0, frameMs: 0, worldMsgs: 0, entities: 0, visible: 0, renders: 0 };
  private nRenders = 0;
  rendersTotal = 0; // frames drawn since start (tests)
  private dirty = true; // something changed outside frame(): draw the next frame
  private lastRender = 0;

  private locate: { x: number; y: number; until: number } | null = null;
  private hover: { x: number; y: number; w: number; h: number } | null = null;
  private eco = false;
  private guided = false;
  private guidedRun = false; // a walk-to runs; following a person goes at their pace (`self` tells)
  private nearby: Prop | null = null;
  /** Map objects of the running plugins, the sprites drawn for them and their pictures (by URL). */
  private objSpecs: PluginObjectSpec[] = [];
  private objSprites: Sprite[] = [];
  private objPictures = new ObjectPictures();
  /** The map editor is open: objects of plugins not running show as dashed placeholders. */
  private editing = false;
  private placeholderG = new Graphics();
  private placeholderLabels: { text: BitmapText; x: number; y: number }[] = [];
  private nearbyAt = 0;
  /** The props of the map shown changed (a new map or an editor draft): plugins hear of their objects. */
  onProps: ((props: Prop[]) => void) | null = null;
  private emotes = new Map<number, { text: Text; until: number }>();
  private cleanup: (() => void)[] = [];

  constructor(private hooks: ViewHooks) {}

  async init(host: HTMLElement, eco: boolean) {
    await document.fonts.load('16px "Jersey 10"').catch(() => []);
    this.eco = eco;
    const app = new Application();
    await app.init({
      resizeTo: host,
      background: 0x1b1830,
      antialias: false,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, eco ? 1 : 2),
      roundPixels: true,
      powerPreference: "low-power",
      preference: "webgl",
    });
    this.app = app;
    host.appendChild(app.canvas);
    app.canvas.style.display = "block";
    app.stage.addChild(this.world, this.hud);
    this.world.addChild(this.entLayer, this.placeholderG, this.fxG);
    this.entLayer.sortableChildren = true;
    this.hud.addChild(this.hudG);
    this.hoverTag.anchor.set(0.5, 1);
    this.hoverTag.visible = false;
    this.hud.addChild(this.hoverTag);
    this.bannerText = new BitmapText({ text: "", style: BANNER_STYLE });
    this.banner.addChild(this.bannerG, this.bannerText);
    this.banner.visible = false;
    this.hud.addChild(this.banner);
    app.ticker.maxFPS = eco ? 30 : 0;
    app.ticker.remove(app.render, app); // frame() draws, and only when something changed
    app.ticker.add((t) => this.frame(t.deltaMS));
    this.layout();
    app.renderer.on("resize", () => this.layout());

    const kd = (e: KeyboardEvent) => this.key(e, true);
    const ku = (e: KeyboardEvent) => this.key(e, false);
    const blur = () => { this.releaseKeys(); this.setRunHeld(false); this.stopDrag(); };
    const vis = () => {
      if (document.hidden) {
        this.releaseKeys();
        app.ticker.stop(); // no rendering in hidden tabs; sockets and calls keep running
      } else {
        app.ticker.start();
        this.hooks.onResume(); // extrapolation did not run while hidden: ask for fresh states
      }
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", vis);
    // Double-click (or double-tap) a spot on the map to run there along a server-computed path.
    const dbl = (e: MouseEvent) => {
      if (document.querySelector(".scrim, .editor") || performance.now() - this.dragEndAt < 500) return; // a drag's click is not a double-click
      const [tx, ty] = this.screenToTile(e.clientX, e.clientY);
      if (!this.map || tx < 0 || ty < 0 || tx >= this.map.w || ty >= this.map.h) return;
      this.goTo(tx, ty);
    };
    app.canvas.addEventListener("dblclick", dbl);
    // Ctrl+wheel zooms the map only, in whole steps (see below).
    const wheel = (e: WheelEvent) => {
      // Ctrl+wheel (Cmd+wheel on a Mac, and a trackpad pinch, which browsers send as Ctrl+wheel) zooms
      // the map, as in Gather; the plain wheel does nothing here. Every notch counts, whatever its size.
      if (!(e.ctrlKey || e.metaKey) || document.querySelector(".scrim, .editor")) return;
      e.preventDefault(); // not the browser's page zoom
      if (!e.deltaY) return;
      const now = performance.now();
      if (now - this.wheelAt < WHEEL_GAP_MS) return;
      this.wheelAt = now;
      const step = Math.sign(e.deltaY);
      this.zoomBy(-step);
      const d = this.drag;
      if (d?.moved) {
        // keep dragging from here, at the new scale (the camera is placed on the next frame)
        const { width: W, height: H } = app.screen;
        d.x = e.clientX;
        d.y = e.clientY;
        d.camX = W / 2 - (this.mx + this.vox + this.panX) * this.S;
        d.camY = H / 2 - (this.my + this.voy + this.panY) * this.S;
      }
    };
    app.canvas.addEventListener("wheel", wheel, { passive: false });
    // Left-drag with a mouse looks around; a press that moves less than DRAG_PX stays a click, so
    // double-click to run there still works. Touch keeps the browser's own gestures and the pad.
    const pdown = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType !== "mouse" || document.querySelector(".scrim, .editor")) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, camX: this.camX, camY: this.camY, moved: false };
    };
    const pmove = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      // released somewhere we did not hear about (outside the canvas before the drag began), or a
      // dialog opened: the drag is over
      if (!(e.buttons & 1) || document.querySelector(".scrim, .editor")) return this.stopDrag();
      const ox = e.clientX - d.x, oy = e.clientY - d.y;
      if (!d.moved) {
        if (Math.hypot(ox, oy) < DRAG_PX) return;
        d.moved = true;
        app.canvas.setPointerCapture(e.pointerId);
        app.canvas.style.cursor = "grabbing";
        document.body.style.userSelect = "none"; // no text selection in overlays the drag crosses
      }
      this.panTo(d.camX + ox, d.camY + oy);
    };
    const pup = (e: PointerEvent) => {
      if (this.drag && e.pointerId === this.drag.id) this.stopDrag();
    };
    const hoverMove = (e: PointerEvent) => {
      const r = app.canvas.getBoundingClientRect();
      this.mouse = e.pointerType === "mouse" ? { x: e.clientX - r.left, y: e.clientY - r.top } : null;
    };
    const hoverOut = () => { this.mouse = null; };
    app.canvas.addEventListener("pointermove", hoverMove);
    app.canvas.addEventListener("pointerleave", hoverOut);
    this.cleanup.push(() => {
      app.canvas.removeEventListener("pointermove", hoverMove);
      app.canvas.removeEventListener("pointerleave", hoverOut);
    });
    app.canvas.addEventListener("pointerdown", pdown);
    app.canvas.addEventListener("pointermove", pmove);
    app.canvas.addEventListener("pointerup", pup);
    app.canvas.addEventListener("pointercancel", pup);
    app.canvas.addEventListener("lostpointercapture", pup);
    this.cleanup.push(() => {
      app.canvas.removeEventListener("lostpointercapture", pup);
      app.canvas.removeEventListener("pointerdown", pdown);
      app.canvas.removeEventListener("pointermove", pmove);
      app.canvas.removeEventListener("pointerup", pup);
      app.canvas.removeEventListener("pointercancel", pup);
      app.canvas.removeEventListener("wheel", wheel);
      app.canvas.removeEventListener("dblclick", dbl);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", vis);
    });
  }

  destroy() {
    this.destroyed = true;
    this.cleanup.forEach((f) => f());
    this.app?.destroy(true, { children: true });
  }

  setEco(eco: boolean) {
    this.dirty = true;
    this.eco = eco;
    this.app.ticker.maxFPS = eco ? 30 : 0;
    const r = Math.min(window.devicePixelRatio || 1, eco ? 1 : 2);
    this.app.renderer.resolution = r;
    this.app.renderer.resize(this.app.screen.width, this.app.screen.height);
  }

  // ---- input ----
  private key(e: KeyboardEvent, down: boolean) {
    // Ctrl+D (Cmd+D on a Mac) goes back to my desk from anywhere, a text field included; it is the
    // browser's bookmark shortcut otherwise, so it is taken even while a dialog is open
    if (down && isHomeKey(e)) {
      e.preventDefault();
      if (!e.repeat && !document.querySelector(".scrim, .editor")) this.hooks.onHome?.();
      return;
    }
    // Ctrl+U (Cmd+U), "unavailable": busy, or available again; the browser's view-source otherwise
    if (down && isBusyKey(e)) {
      e.preventDefault();
      if (!e.repeat && !document.querySelector(".scrim, .editor")) this.hooks.onBusy?.();
      return;
    }
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
    if (e.key === "Shift") {
      this.setRunHeld(down);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (down) learnKey(e);
    // physical position: W A S D is Z Q S D on AZERTY (keys.ts); the keypad without Num Lock types arrows
    const k = e.code.startsWith("Numpad") && e.key.startsWith("Arrow") ? e.key : codeOf(e);
    // Modal controls and the editor own their keyboard interaction.
    if (document.querySelector(".scrim, .editor")) return;
    // Shift is the run key; with it held, keys type symbols ("?" is Shift + the M position on
    // AZERTY), so one-shot shortcuts ignore it and only movement goes on.
    const once = down && !e.repeat && !e.shiftKey;
    const n = digitOf(k, e.key);
    if (once && n >= 1 && n <= 7) {
      e.preventDefault();
      this.hooks.onEmote?.(n);
      return;
    }
    if (once && k === "KeyX") {
      e.preventDefault();
      this.interact();
      return;
    }
    if (once && k === "KeyR") {
      e.preventDefault();
      this.toggleRun();
      return;
    }
    if (once && k === "KeyZ") {
      e.preventDefault();
      this.hooks.onEmote?.(DANCE);
      return;
    }
    if (once && k === "KeyH") {
      e.preventDefault();
      this.hooks.onHand?.();
      return;
    }
    const m = MOVE_KEYS[k];
    if (!m) return;
    e.preventDefault();
    if (down) this.keys.add(m);
    else this.keys.delete(m);
    this.applyKeys();
  }

  private releaseKeys() {
    this.keys.clear();
    this.applyKeys();
  }

  private applyKeys() {
    const dx = (this.keys.has("r") ? 1 : 0) - (this.keys.has("l") ? 1 : 0);
    const dy = (this.keys.has("d") ? 1 : 0) - (this.keys.has("u") ? 1 : 0);
    this.setDirection(dx, dy);
  }

  /** Public so tests can drive movement without synthesising key events. */
  setDirection(dx: number, dy: number) {
    if (dx || dy) { this.guided = false; this.dest = null; }
    if (dx === this.dx && dy === this.dy) return;
    this.advanceLocal(performance.now()); // the old direction holds until this very moment, as on the server
    this.dx = dx;
    this.dy = dy;
    if (dx < 0) this.mdir = 1;
    else if (dx > 0) this.mdir = 2;
    else if (dy < 0) this.mdir = 3;
    else if (dy > 0) this.mdir = 0;
    this.sendDir();
  }

  private sendDir() {
    this.advanceLocal(performance.now());
    this.seq++;
    this.hist.set(this.seq, { x: this.mx, y: this.my });
    if (this.hist.size > 64) this.hist.delete(this.hist.keys().next().value!);
    this.hooks.sendInput(this.seq, this.dx, this.dy, this.running);
    this.lastBeat = performance.now();
  }

  // ---- running ----
  /** Shift inverts "always run", so either habit works. */
  get running() {
    return this.runHeld !== this.runToggle;
  }
  /** Whether my avatar goes at run speed now, as the server moves it. */
  private get fast() {
    return this.running || (this.guided && this.guidedRun);
  }
  private setRunHeld(on: boolean) {
    if (on === this.runHeld) return;
    this.advanceLocal(performance.now());
    const was = this.running;
    this.runHeld = on;
    if (was !== this.running) this.runChanged();
  }
  /** Public: the HUD button and tests switch "always run". */
  toggleRun(on = !this.runToggle) {
    if (on === this.runToggle) return;
    this.advanceLocal(performance.now());
    this.runToggle = on;
    this.runChanged();
  }
  private runChanged() {
    this.hooks.onRun?.(this.running);
    if (this.dx || this.dy || this.guided) this.sendDir(); // a stopped avatar sends it with its next input
  }

  /** Run to a tile; the server finds the path (walls, locked rooms) and steers. */
  goTo(tx: number, ty: number) {
    this.dest = { x: tx * T + T / 2, y: ty * T + T / 2 };
    this.hooks.onGoto?.(tx, ty);
  }

  // ---- data ----
  setMap(map: MapData, deny: number[]) {
    this.dirty = true;
    this.map = map;
    this.deny = new Set(deny);
    this.solid = new Uint8Array(map.w * map.h);
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) this.solid[y * map.w + x] = map.solid[y][x] === "1" ? 1 : 0;
    this.grid = { w: map.w, h: map.h, areaAt: areaGrid(map) };
    this.mapSprite?.destroy({ texture: true, textureSource: true }); // do not leak a GPU texture per edit
    const tex = bakeMap(this.app.renderer, map);
    this.baked = tex.source.resource as HTMLCanvasElement;
    this.mapSprite = new Sprite(tex);
    this.world.addChildAt(this.mapSprite, 0);
    this.buildDepth(map);
    this.areaLabels.forEach((l) => l.text.destroy());
    // desk rooms (derived from assigned desks, "auto") are named after the area under them
    this.shownOf = shownAreas(map);
    this.areaLabels = map.areas.flatMap((a, ai) => {
      if (a.auto) return []; // the desk's own label already names it
      const text = new BitmapText({ text: this.areaLabel(ai), style: TAG_STYLE });
      text.anchor.set(0.5, 0);
      text.alpha = 0.85;
      this.hud.addChild(text);
      return [{ text, ai }];
    });
    // assigned desks show their owner
    this.deskLabels.forEach((l) => l.text.destroy());
    this.deskLabels = map.props
      .filter((p) => p.t === "desk" && p.assign)
      .map((p) => {
        const ai = deskRoom(map, p); // the desk's own room
        const text = new BitmapText({ text: this.deskLabel(p, ai), style: DESK_STYLE });
        text.anchor.set(0.5, 1);
        text.alpha = 0.95;
        this.hud.addChild(text);
        // over the middle of the desk, whatever its width; the bottom desk of an island (another desk
        // right above it) is labelled under its seat, where the sitter's own name tag does not reach
        const back = map.props.some((q) => q.t === "desk" && q.up && q.y === p.y - 1 && q.x === p.x);
        return { text, x: (p.x + (p.w ?? 2) / 2) * T, y: back ? (p.y + 2) * T + 10 : p.y * T, p, ai };
      });
    this.drawObjects();
    this.onProps?.(map.props);
    // a new map may put a room under me (a desk just taken) or move area indexes: recount where I
    // stand, as the server does on a reload
    if (this.meEnt) {
      this.where.area = this.areaIndex(this.mx, this.my);
      this.hooks.onArea(this.areaName(this.where.area), this.where.area);
      this.where.shown = shownArea(this.shownOf, this.where.area);
    }
    this.layout();
  }

  setMe(id: number, x: number, y: number, speed: number, runMul = 2) {
    this.meId = id;
    this.panX = this.panY = 0;
    this.mx = x;
    this.my = y;
    this.vox = this.voy = 0;
    this.hist.clear();
    this.lastAck = 0;
    this.speed = speed;
    this.runMul = runMul;
    this.where.area = this.areaIndex(x, y);
    this.hooks.onArea(this.areaName(this.where.area), this.where.area);
    this.where.shown = shownArea(this.shownOf, this.where.area);
    if (this.where.shown >= 0) this.showBanner(this.areaName(this.where.area));
    if (!this.meEnt) {
      this.meEnt = this.makeEnt(id);
      this.ents.set(id, this.meEnt);
    }
    this.meEnt.x = x;
    this.meEnt.y = y;
    // A reconnect must never leave the player "stuck walking".
    this.dx = this.dy = 0;
    this.keys.clear();
  }

  setPeople(people: Map<number, Person>) {
    this.dirty = true;
    // someone who left the office frees their look (once their sprite is gone too); leaving the screen does not
    for (const id of this.people.keys()) if (!people.has(id) && !this.ents.has(id)) releaseAvatar(id);
    this.people = people;
    for (const e of this.ents.values()) this.refreshEnt(e);
    this.relabel(); // an online person names a place the server has not named yet (an editor preview)
  }

  setSpeaking(ids: Set<number>) {
    this.dirty = true;
    for (const e of this.ents.values()) e.speaking = ids.has(e.id);
  }

  setInConversation(ids: Set<number>) {
    this.dirty = true;
    for (const e of this.ents.values()) e.inConv = ids.has(e.id);
  }

  setSharing(ids: Set<number>) {
    this.dirty = true;
    for (const e of this.ents.values()) e.sharing = ids.has(e.id);
  }

  // ---- map editor support ----
  currentMap() {
    return this.map;
  }
  /** The map editor opened or closed: it shows objects of plugins that are not running. */
  setEditing(on: boolean) {
    if (this.editing === on) return;
    this.editing = on;
    this.drawObjects();
  }
  /** Re-render/re-collide with an unsaved draft (deny rules are kept). */
  previewMap(map: MapData) {
    this.setMap(map, [...this.deny]);
  }
  /** Shows the label of the plugin sprite under the mouse (and its owner's name), or hides it; true when it changed. */
  private placeHoverTag(): boolean {
    const tag = this.hoverTag;
    const m = !this.mouse || this.drag?.moved || document.querySelector(".scrim") ? null : this.mouse;
    const hit = m ? this.plugins.labelAt((m.x - this.camX) / this.S, (m.y - this.camY) / this.S) : null;
    if (!hit) {
      if (!tag.visible) return false;
      tag.visible = false;
      return true;
    }
    const owner = hit.owner ? this.people.get(hit.owner)?.n : undefined;
    const text = owner ? hit.text + "\n(" + owner + ")" : hit.text;
    const x = Math.round(this.camX + hit.x * this.S), y = Math.round(this.camY + hit.top * this.S - 2);
    if (tag.visible && tag.text === text && tag.x === x && tag.y === y) return false;
    tag.text = text;
    tag.position.set(x, y);
    if (!tag.visible) this.hud.addChild(tag); // above the name tags added since
    tag.visible = true;
    return true;
  }
  /** Tests: where world point (x, y) is in the page, and the hover tag's text ("" while hidden). */
  pageOf(x: number, y: number): { x: number; y: number } {
    const r = this.app.canvas.getBoundingClientRect();
    return { x: r.left + this.camX + x * this.S, y: r.top + this.camY + y * this.S };
  }
  hoverText(): string {
    return this.hoverTag.visible ? this.hoverTag.text : "";
  }
  screenToTile(clientX: number, clientY: number): [number, number] {
    const r = this.app.canvas.getBoundingClientRect();
    const wx = (clientX - r.left - this.camX) / this.S;
    const wy = (clientY - r.top - this.camY) / this.S;
    return [Math.floor(wx / T), Math.floor(wy / T)];
  }
  setHover(h: { x: number; y: number; w: number; h: number } | null) {
    this.dirty = true;
    this.hover = h;
  }
  teleport(x: number, y: number) {
    this.panX = this.panY = 0;
    this.mx = x;
    this.my = y;
    this.vox = this.voy = 0;
    this.dx = this.dy = 0;
    this.lastAck = 0;
    this.hist.clear();
    this.keys.clear();
    this.where.area = this.areaIndex(x, y);
    this.hooks.onArea(this.areaName(this.where.area), this.where.area);
  }

  /** The server steers me (a walk-to when run, else following a person) or stopped steering. */
  setGuided(on: boolean, run = true) {
    this.advanceLocal(performance.now()); // the old pace holds until this very moment
    this.guided = on;
    this.guidedRun = on && run;
    if (on) {
      this.keys.clear();
      return;
    }
    this.dest = null;
    // the server stopped steering: hand control back to whatever keys are held now
    this.dx = this.dy = 0;
    this.applyKeys();
  }

  /** The server refused or finished a walk-to. */
  clearDest() {
    this.dirty = true;
    this.dest = null;
  }

  /** Where a walk-to is heading (world px), for the minimap. */
  destination() {
    return this.dest;
  }

  /** The baked office picture (shared with the minimap, never re-rendered for it). */
  mapImage() {
    return this.baked;
  }

  applySelf(m: SelfPosition) {
    this.mdir = m.d;
    if (m.tp) {
      this.mx = m.x;
      this.my = m.y;
      this.lastLocal = performance.now();
      this.teleport(m.x, m.y);
    } else {
      // a server-steered walk: my avatar runs on between these 15 Hz positions (advanceLocal), and the
      // gap to each one fades in instead of jumping there, so it moves smoothly and its followers too
      this.advanceLocal(performance.now());
      if (this.guided) this.guidedRun = m.r; // a follower runs while the person it follows runs
      const ex = m.x - this.mx, ey = m.y - this.my;
      this.mx = m.x;
      this.my = m.y;
      if (Math.hypot(ex, ey) > SNAP_PX) this.vox = this.voy = 0;
      else {
        this.vox -= ex;
        this.voy -= ey;
      }
      this.dx = m.dx;
      this.dy = m.dy;
      this.where.area = this.areaIndex(m.x, m.y);
      this.hooks.onArea(this.areaName(this.where.area), this.where.area);
    }
  }

  setDeny(deny: number[]) {
    this.dirty = true;
    this.deny = new Set(deny);
    this.relabel();
  }

  /** Owner names changed (a new map, a rename): desks and offices show the current names. */
  setOwners(owners: Map<number, string>) {
    this.owners = owners;
    this.relabel();
  }

  /** Public: the text of every desk and area label on the map, as drawn (tests read it). */
  labels() {
    return [...this.areaLabels, ...this.deskLabels].map((l) => l.text.text);
  }

  private areaLabel(ai: number) {
    return areaTitle(this.map!.areas[ai], this.nameOf) + (this.deny.has(ai) ? " 🔒" : "");
  }

  private deskLabel(p: Prop, ai: number) {
    return deskTitle(p, this.nameOf) + (this.deny.has(ai) ? " 🔒" : ""); // a desk locked against me
  }

  private relabel() {
    if (!this.map) return;
    this.dirty = true;
    for (const l of this.areaLabels) {
      const s = this.areaLabel(l.ai);
      if (l.text.text !== s) l.text.text = s;
    }
    for (const l of this.deskLabels) {
      const s = this.deskLabel(l.p, l.ai);
      if (l.text.text !== s) l.text.text = s;
    }
    if (this.meEnt) this.hooks.onArea(this.areaName(this.where.area), this.where.area);
  }

  showEmote(id: number, kind: number) {
    this.dirty = true;
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
    this.hud.addChild(text);
    this.emotes.set(id, { text, until: performance.now() + 2500 });
  }

  interact() {
    this.updateNearby();
    if (this.nearby) this.hooks.onInteract?.(this.nearby);
  }

  private updateNearby() {
    const best = nearestUsable(this.map?.props ?? [], this.objSpecs, this.mx, this.my, 20);
    if (best !== this.nearby) { this.nearby = best; this.hooks.onNearby?.(best); }
  }

  /** The map objects of the running plugins (PluginManager): drawn on the map, and X uses them. */
  setPluginObjects(specs: PluginObjectSpec[]) {
    this.objSpecs = specs;
    this.drawObjects();
    this.objPictures.keepOnly(new Set(specs.map((s) => s.plugin))); // after their sprites are gone
    this.updateNearby();
  }

  /** Redraws plugin objects (and, in the editor, placeholders for those of plugins not running). */
  private drawObjects() {
    this.dirty = true;
    for (const s of this.objSprites) s.destroy(); // their textures are shared (objPictures)
    this.objSprites = [];
    this.placeholderG.clear();
    for (const l of this.placeholderLabels) l.text.destroy();
    this.placeholderLabels = [];
    if (!this.map) return;
    const drawn = objectsFor(this.map.props, this.objSpecs);
    for (const { prop, spec } of drawn) {
      const sprite = spec.sprite;
      if (!sprite) continue; // the plugin's browser code draws it (hq.spawn)
      const [, h] = propSize(prop);
      // bottom-left of the footprint, sorted by its bottom edge: an avatar north of the table it
      // stands on stays behind it
      const spr = new Sprite(Texture.EMPTY);
      spr.anchor.set(0, 1);
      spr.position.set(prop.x * T, (prop.y + h) * T);
      spr.zIndex = (prop.y + h) * T;
      this.entLayer.addChild(spr);
      this.objSprites.push(spr);
      void this.objPictures.frame(spec.plugin, sprite, spec.frame).then((tex) => {
        if (!tex || spr.destroyed) return;
        spr.texture = tex;
        this.dirty = true;
      });
    }
    if (!this.editing) return;
    const label = (text: string, style: TextStyle, p: Prop, w: number, h: number) => {
      const b = new BitmapText({ text, style });
      b.anchor.set(0.5, 0.5);
      this.hud.addChild(b);
      this.placeholderLabels.push({ text: b, x: (p.x + w / 2) * T, y: (p.y + h / 2) * T });
    };
    // objects the plugin draws itself: a solid labelled box of their size, so the editor can find them
    const plugin = drawn.filter((o) => !o.spec.sprite);
    for (const { prop: p, spec } of plugin) {
      const [w, h] = propSize(p);
      this.placeholderG.rect(p.x * T + 0.5, p.y * T + 0.5, w * T - 1, h * T - 1);
      label(t("editor.pluginDraws", { label: spec.label }), PLUGIN_NOTE_STYLE, p, w, h);
    }
    if (plugin.length > 0) this.placeholderG.fill({ color: 0x9fe0ff, alpha: 0.15 }).stroke({ color: 0x9fe0ff, width: 1 });
    // objects of plugins that are not running: a dashed box with their type
    const shown = new Set(drawn.map((o) => o.prop));
    for (const p of this.map.props) {
      if (!isPluginProp(p.t) || shown.has(p)) continue;
      const [w, h] = propSize(p);
      dashedRect(this.placeholderG, p.x * T + 0.5, p.y * T + 0.5, w * T - 1, h * T - 1);
      label(t("editor.pluginMissing", { type: p.t }), NOTE_STYLE, p, w, h);
    }
    this.placeholderG.stroke({ color: 0xffe9a8, width: 1 });
  }

  showLocation(x: number, y: number) {
    this.dirty = true;
    this.locate = { x, y, until: performance.now() + 5000 };
  }

  applyWorld(m: WorldDelta) {
    this.dirty = true;
    this.nWorld++;
    if (m.m) {
      for (const [id, x, y, d] of m.m) {
        if (id === this.meId) continue;
        const dx = ((d >> 2) & 3) - 1;
        const dy = ((d >> 4) & 3) - 1;
        let e = this.ents.get(id);
        if (!e) {
          e = this.makeEnt(id);
          e.tx = e.x = x;
          e.ty = e.y = y;
          this.ents.set(id, e);
        } else {
          // keep the picture continuous: the difference to the new truth fades out
          const ox = e.tx + e.ox - x;
          const oy = e.ty + e.oy - y;
          if (Math.hypot(ox, oy) > 24) {
            e.ox = 0;
            e.oy = 0;
          } else {
            e.ox = ox;
            e.oy = oy;
          }
          e.tx = x;
          e.ty = y;
        }
        e.dir = d & 3;
        e.dx = dx;
        e.dy = dy;
        e.run = ((d >> 6) & 1) === 1;
        e.moving = dx !== 0 || dy !== 0;
      }
    }
    if (m.l) for (const id of m.l) if (id !== this.meId) this.removeEnt(id);
  }

  /**
   * Server reconciliation: compare with where we were when that input was sent. The whole error
   * is applied, to the position and to every input still in flight (whose recorded positions
   * share the same error; leaving them alone applied it again on each later ack and overshot).
   * The avatar is drawn where it was and the offset fades, so jitter never shows as a step back.
   */
  applyAck(a: Ack) {
    let h = this.hist.get(a.s);
    if (!h) {
      // No record of this input: its acknowledgement arrived after newer ones already
      // cleared it (a delayed message after a stall). The effects of every input up to this
      // one are already in the live position, so compare against that — but only for acks
      // newer than anything applied so far.
      if (a.s <= this.lastAck) return;
      h = { x: this.mx, y: this.my };
    }
    this.lastAck = Math.max(this.lastAck, a.s);
    for (const k of this.hist.keys()) if (k <= a.s) this.hist.delete(k);
    const ex = a.x - h.x;
    const ey = a.y - h.y;
    if (Math.abs(ex) <= 0.1 && Math.abs(ey) <= 0.1) return; // the server rounds to 0.1 px
    this.mx += ex;
    this.my += ey;
    for (const p of this.hist.values()) {
      p.x += ex;
      p.y += ey;
    }
    if (Math.hypot(ex, ey) > SNAP_PX) this.vox = this.voy = 0;
    else {
      this.vox -= ex;
      this.voy -= ey;
    }
    this.syncArea();
  }

  clearRemote() {
    for (const id of [...this.ents.keys()]) if (id !== this.meId) this.removeEnt(id);
  }

  position() {
    return { x: this.mx, y: this.my };
  }

  /** Tests: the area index I am in (room access). */
  get mArea() {
    return this.where.area;
  }

  /** Rebuilt with the bake, never touched per frame: the sort they join already runs as avatars move. */
  private buildDepth(map: MapData) {
    for (const s of this.depthSprites) s.destroy();
    this.depthSprites = [];
    this.depthTex?.destroy(true);
    this.depthTex = null;
    if (!this.baked) return;
    const { canvas, pieces } = depthAtlas(map, this.baked);
    if (!pieces.length) return;
    const tex = Texture.from(canvas);
    tex.source.scaleMode = "nearest";
    this.depthTex = tex;
    for (const p of pieces) {
      const spr = new Sprite(new Texture({ source: tex.source, frame: new Rectangle(p.sx, p.sy, p.w, p.h) }));
      spr.position.set(p.x, p.y);
      spr.zIndex = p.z;
      spr.label = "depth-" + p.t;
      this.entLayer.addChild(spr);
      this.depthSprites.push(spr);
    }
  }

  /** Tests: how many depth sprites stand for desks and for pcs. */
  debugDepth() {
    const n = (t: string) => this.depthSprites.filter((s) => s.label === "depth-" + t).length;
    return { desks: n("desk"), pcs: n("pc") };
  }

  /** Tests: a hash of the world's pixels over rect (world px, 1:1), with or without the depth sprites and
   * the people (avatars, pets, plugin sprites, rings and effects). */
  async debugWorldPixels(o: { depth: boolean; ents: boolean; rect: { x: number; y: number; w: number; h: number } }) {
    const keep = new Set<Container>([...this.objSprites, ...(o.depth ? this.depthSprites : [])]);
    const depth = new Set<Container>(this.depthSprites);
    const shown: [Container, boolean][] = [];
    const set = (c: Container, v: boolean) => { shown.push([c, c.visible]); c.visible = v; };
    for (const c of this.entLayer.children) set(c, keep.has(c) || (o.ents && !depth.has(c)));
    for (const c of this.world.children) if (c !== this.mapSprite && c !== this.entLayer) set(c, o.ents && c.visible);
    try {
      const { pixels } = this.app.renderer.extract.pixels({ target: this.world, frame: new Rectangle(o.rect.x, o.rect.y, o.rect.w, o.rect.h), resolution: 1 });
      let h = 0x811c9dc5;
      for (let i = 0; i < pixels.length; i++) h = Math.imul(h ^ pixels[i], 0x01000193);
      return (h >>> 0).toString(16) + ":" + pixels.length;
    } finally {
      for (const [c, v] of shown.reverse()) c.visible = v;
    }
  }

  /** Tests: a hash of what the bake paints for a map. */
  debugBakeHash(map: MapData) {
    const c = bakeMapCanvas(map);
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let h = 0x811c9dc5;
    for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 0x01000193);
    return (h >>> 0).toString(16);
  }

  debugEntities() {
    return [...this.ents.values()].filter((e) => e.id !== this.meId).map((e) => ({ id: e.id, x: e.x, y: e.y }));
  }

  // ---- entities ----
  private makeEnt(id: number): Ent {
    const p = this.people.get(id);
    const frames = avatarFramesFor(id, p?.av ?? DEFAULT_AV);
    const spr = new Sprite(frames[0][0]);
    spr.anchor.set(0.5, FEET_Y / CELL_H);
    this.entLayer.addChild(spr);
    const label = new Container();
    const dot = new Graphics();
    const text = new BitmapText({ text: p?.n ?? "…", style: TAG_STYLE });
    text.anchor.set(0.5, 1);
    label.addChild(dot, text);
    this.hud.addChild(label);
    const e: Ent = {
      id, key: "", frames, spr, label, text, dot, ring: null, hand: null, danceUntil: 0, tx: 0, ty: 0, ox: 0, oy: 0, dx: 0, dy: 0, x: 0, y: 0, dir: 0, moving: false, run: false,
      speaking: false, sharing: false, inConv: false, status: p?.s ?? "available", name: p?.n ?? "", drawnStatus: "", drawnConv: false, drawnShare: false,
    };
    this.refreshEnt(e);
    return e;
  }

  private refreshEnt(e: Ent) {
    this.dirty = true;
    const p = this.people.get(e.id);
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
    this.dirty = true;
    const e = this.ents.get(id);
    if (!e) return;
    e.spr.destroy();
    e.label.destroy({ children: true });
    e.ring?.destroy();
    this.ents.delete(id);
    this.emotes.get(id)?.text.destroy();
    this.emotes.delete(id);
    if (!this.people.has(id)) releaseAvatar(id);
  }

  /** Location signboard that slides in from the top when entering an area (handheld-RPG style). */
  private showBanner(name: string) {
    this.dirty = true;
    const t = this.bannerText;
    if (!t || !name) return;
    t.text = name.toUpperCase();
    const w = Math.round(t.width) + 40, h = 38;
    this.bannerW = w;
    this.bannerG
      .clear()
      .roundRect(0, 0, w, h, 4).fill(0x383858)
      .roundRect(2, 2, w - 4, h - 4, 3).fill(0xa0a8e8)
      .roundRect(4, 4, w - 8, h - 8, 2).fill(0xf8f8ff)
      .rect(4, h - 8, w - 8, 3).fill(0xdcdcf0)
      .rect(4, 4, w - 8, 2).fill(0xffffff);
    // whole pixels: a centred anchor put odd-width text on half pixels and blurred it
    t.position.set(20, Math.round((h - t.height) / 2));
    this.bannerT0 = performance.now();
  }

  // ---- movement / collision (mirrors the server) ----
  private areaIndex(x: number, y: number) {
    return this.map ? areaIndex(this.grid, x, y) : -1;
  }

  private canStand(x: number, y: number) {
    const m = this.map!;
    const x0 = Math.floor((x - BOX_HW) / T), x1 = Math.floor((x + BOX_HW - 0.001) / T);
    const y0 = Math.floor((y - BOX_HH) / T), y1 = Math.floor((y + BOX_HH - 0.001) / T);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h || this.solid[ty * m.w + tx]) return false;
        const ai = this.grid.areaAt[ty * m.w + tx];
        if (ai !== this.where.area && this.deny.has(ai)) return false;
      }
    }
    return true;
  }

  private canStandStatic(x: number, y: number) {
    const m = this.map!;
    const x0 = Math.floor((x - BOX_HW) / T), x1 = Math.floor((x + BOX_HW - 0.001) / T);
    const y0 = Math.floor((y - BOX_HH) / T), y1 = Math.floor((y + BOX_HH - 0.001) / T);
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h || this.solid[ty * m.w + tx]) return false;
    return true;
  }

  /** Walks a remote entity along its last known direction (same rule as the server's shadow). */
  private extrapolate(e: Ent, dt: number) {
    const p = this.body;
    p.x = e.tx;
    p.y = e.ty;
    this.moveBody(p, e.dx, e.dy, this.speed * (e.run ? this.runMul : 1) * dt, true);
    e.tx = p.x;
    e.ty = p.y;
  }

  private body = { x: 0, y: 0 };
  /** world.move on the server: the same sub-steps and contact rule (see SUB_STEP_PX). */
  private moveBody(p: { x: number; y: number }, dx: number, dy: number, dist: number, isStatic: boolean) {
    let vx = dx, vy = dy;
    if (vx && vy) { vx *= 0.70710678; vy *= 0.70710678; }
    const n = Math.max(1, Math.ceil(dist / SUB_STEP_PX));
    const step = dist / n;
    for (let i = 0; i < n; i++) {
      if (vx) {
        const nx = p.x + vx * step;
        if (this.stand(nx, p.y, isStatic)) p.x = nx;
        else {
          const c = contact(nx, vx, BOX_HW);
          if ((vx > 0 ? c > p.x : c < p.x) && this.stand(c, p.y, isStatic)) p.x = c;
        }
      }
      if (vy) {
        const ny = p.y + vy * step;
        if (this.stand(p.x, ny, isStatic)) p.y = ny;
        else {
          const c = contact(ny, vy, BOX_HH);
          if ((vy > 0 ? c > p.y : c < p.y) && this.stand(p.x, c, isStatic)) p.y = c;
        }
      }
      if (!isStatic) this.where.area = this.areaIndex(p.x, p.y); // room access follows the walk, as on the server
    }
  }

  private stand(x: number, y: number, isStatic: boolean) {
    return isStatic ? this.canStandStatic(x, y) : this.canStand(x, y);
  }

  /** Integrates my own movement up to now (frames, and every input at the moment it is sent). */
  private advanceLocal(now: number) {
    const dt = Math.min(Math.max(now - this.lastLocal, 0) / 1000, MAX_ADVANCE);
    this.lastLocal = now;
    if (!this.map || (!this.dx && !this.dy) || dt === 0) return;
    const p = this.body;
    p.x = this.mx;
    p.y = this.my;
    const was = this.where.area;
    this.moveBody(p, this.dx, this.dy, this.speed * (this.fast ? this.runMul : 1) * dt, false);
    this.mx = p.x;
    this.my = p.y;
    this.where.area = was;
    this.syncArea();
  }

  private areaName(ai: number) {
    const i = shownArea(this.shownOf, ai);
    return this.map && i >= 0 ? areaTitle(this.map.areas[i], this.nameOf) : "";
  }

  private syncArea() {
    if (!this.map) return;
    const ai = this.areaIndex(this.mx, this.my);
    const change = this.where.enter(ai, this.shownOf);
    if (change === SAME) return;
    this.hooks.onArea(this.areaName(ai), ai);
    // a desk room is part of the desks around it: no banner walking in or out of one
    if (change === SHOWN && this.where.shown >= 0) this.showBanner(this.areaName(ai));
  }

  // ---- zoom / area of interest ----
  /** From hello: the server's interest grid, which bounds how far out the map may zoom. */
  setInterest(cellPx: number, aoi: number, aoiMax: number) {
    this.cellPx = cellPx;
    this.aoi = aoi;
    this.aoiMax = Math.max(aoi, aoiMax);
    this.viewCells = -1; // tell each new connection, even when it is the default
    this.layout();
  }

  /** Zooms by whole scale steps (positive = closer) and returns the scale in use. Public for tests. */
  zoomBy(steps: number) {
    if (!this.app) return this.S;
    const { width, height } = this.app.screen;
    this.zoom += steps;
    this.layout();
    if (!this.cellPx) return this.S; // limits are not known before hello: keep the remembered zoom
    this.zoom = this.S - autoScale(width, height); // forget steps past a limit
    writeZoom(this.zoom);
    return this.S;
  }

  /** Puts the camera at this screen offset (the frame keeps it on the map and within reach). */
  private panTo(camX: number, camY: number) {
    const { width: W, height: H } = this.app.screen;
    this.panX = (W / 2 - camX) / this.S - (this.mx + this.vox);
    this.panY = (H / 2 - camY) / this.S - (this.my + this.voy);
    this.dirty = true;
  }

  /** Ends a drag, wherever it is. */
  private stopDrag() {
    if (this.drag?.moved) this.endDrag();
    this.drag = null;
  }

  /** Keeps only the pan the camera could follow, so the next drag starts where the view is. */
  private endDrag() {
    this.app.canvas.style.cursor = "";
    document.body.style.userSelect = "";
    this.dragEndAt = performance.now();
    this.panTo(this.camX, this.camY);
  }

  /** Camera pan in world px (tests). */
  get pan() {
    return { x: this.panX, y: this.panY };
  }

  get scale() {
    return this.S;
  }

  /** Smallest and largest scale for this window. */
  scaleRange(width = this.app.screen.width, height = this.app.screen.height): [number, number] {
    const auto = autoScale(width, height);
    // Farthest out: half the visible map must fit the largest radius the server grants, or people
    // near the screen edge would be missing. Before hello (unknown radius) only the automatic scale.
    const reach = this.aoiMax * this.cellPx - VIEW_PAD;
    const lo = this.cellPx ? Math.min(auto, Math.max(1, Math.ceil(Math.max(width, height) / (2 * reach)))) : auto;
    return [lo, Math.max(auto, MAX_SCALE)];
  }

  /**
   * Asks the server for the interest radius that covers the visible part of the map. The server
   * subscribes whole cells around the player's cell, so a radius of r cells reaches at least r cells
   * of pixels from the player in every direction; asking for the distance to the farthest visible
   * map pixel keeps the request steady while walking (no flip-flop at cell boundaries).
   */
  private syncView(W: number, H: number, px: number, py: number) {
    if (!this.map || !this.cellPx) return;
    const S = this.S, mw = this.map.w * T, mh = this.map.h * T;
    const left = Math.max(0, -this.camX / S), right = Math.min(mw, (W - this.camX) / S);
    const top = Math.max(0, -this.camY / S), bottom = Math.min(mh, (H - this.camY) / S);
    const far = Math.max(px - left, right - px, py - top, bottom - py);
    const need = Math.max(this.aoi, Math.min(this.aoiMax, Math.ceil((far + VIEW_PAD) / this.cellPx - 1e-6)));
    if (need === (this.viewCells || this.aoi)) return;
    this.viewCells = need;
    this.hooks.onView?.(need);
  }

  // ---- layout / frame ----
  private layout() {
    this.dirty = true;
    if (!this.app) return;
    const { width, height } = this.app.screen;
    // integer zoom keeps pixel art crisp; the reference view is a handheld-style screen scaled by
    // whole numbers, then moved by the wheel within what the server's area of interest can fill
    const auto = autoScale(width, height);
    const [lo, hi] = this.scaleRange(width, height);
    this.S = Math.max(lo, Math.min(hi, auto + this.zoom));
    this.world.scale.set(this.S);
  }

  private frame(deltaMS: number) {
    if (this.destroyed || !this.map) return;
    const t0 = performance.now();
    const dt = Math.min(deltaMS / 1000, 0.1);
    const now = t0;
    const S = this.S;
    const { width: W, height: H } = this.app.screen;

    this.advanceLocal(now);
    if (!this.guided && (this.dx || this.dy) && now - this.lastBeat > HEARTBEAT_MS) this.sendDir();
    if (this.vox || this.voy) {
      const k = 1 - Math.exp(-dt / SELF_TAU);
      // fading the offset moves the drawn avatar by -b; only where that would go against the held
      // direction is it capped, below walking speed, so the avatar slows but never steps back
      const lim = SELF_BLEND_FRAC * this.speed * Math.SQRT1_2 * dt;
      let bx = this.vox * k, by = this.voy * k;
      if (this.dx && Math.sign(bx) === this.dx) bx = Math.sign(bx) * Math.min(Math.abs(bx), lim);
      if (this.dy && Math.sign(by) === this.dy) by = Math.sign(by) * Math.min(Math.abs(by), lim);
      this.vox -= bx;
      this.voy -= by;
      if (Math.hypot(this.vox, this.voy) < 0.02 || Math.hypot(this.vox, this.voy) > SNAP_PX) this.vox = this.voy = 0;
    }
    const rx = this.mx + this.vox, ry = this.my + this.voy; // where my avatar is drawn
    if (now - this.nearbyAt > 150) { this.nearbyAt = now; this.updateNearby(); }

    if ((this.dx || this.dy || this.guided) && (this.panX || this.panY || this.drag)) {
      // moving recentres the camera on me, and ends a drag in progress
      if (this.drag?.moved) {
        this.app.canvas.style.cursor = "";
        document.body.style.userSelect = "";
      }
      this.panX = this.panY = 0;
      this.drag = null;
    }
    // The middle of the screen may go anywhere on the office but never past its edges: at the top of
    // the office the open space sits mid-screen, clear of the toolbars, with at most half a screen of
    // margin beyond the map. Following me, I stay in the middle; a pan stops at the office's edge.
    const vx = Math.max(0, Math.min(this.map.w * T, rx + this.panX)), vy = Math.max(0, Math.min(this.map.h * T, ry + this.panY));
    let cx = W / 2 - vx * S, cy = H / 2 - vy * S;
    // Never show map farther from me than the server's largest interest radius reaches: zoomed far
    // out next to a map edge the camera stops following the edge and shows a margin instead of
    // people the server does not send. A no-op whenever the visible map is already within reach.
    if (this.cellPx) {
      const R = this.aoiMax * this.cellPx - VIEW_PAD;
      cx = reachClamp(cx, W, S, rx, R, this.map.w * T);
      cy = reachClamp(cy, H, S, ry, R, this.map.h * T);
    }
    let changed = this.dirty;
    this.dirty = false;
    if (Math.round(cx) !== this.camX || Math.round(cy) !== this.camY) changed = true;
    this.camX = Math.round(cx);
    this.camY = Math.round(cy);
    this.syncView(W, H, rx, ry);
    this.world.position.set(this.camX, this.camY);

    const walkRate = this.eco ? 5 : 8;
    let visible = 0;
    for (const e of this.ents.values()) {
      const isMe = e.id === this.meId;
      if (isMe) {
        e.x = rx; e.y = ry; e.dir = this.mdir; e.moving = !!(this.dx || this.dy);
      } else {
        if (e.dx || e.dy) this.extrapolate(e, dt);
        const k = Math.exp(-dt / OFFSET_TAU);
        e.ox *= k;
        e.oy *= k;
        e.x = e.tx + e.ox;
        e.y = e.ty + e.oy;
      }
      const sx = Math.round(e.x * S + this.camX);
      const sy = Math.round(e.y * S + this.camY);
      const on = sx > -40 && sx < W + 40 && sy > -60 && sy < H + 60;
      if (e.spr.visible !== on) changed = true;
      e.spr.visible = on;
      e.label.visible = on;
      if (e.ring) e.ring.visible = on && e.speaking;
      if (!on) continue;
      visible++;
      const fast = isMe ? this.fast : e.run;
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
        if (!e.ring) { e.ring = new Graphics(); this.world.addChildAt(e.ring, 1); }
        e.ring.clear().ellipse(0, 0, 9, 4).stroke({ color: 0x3cc9b0, width: 1.5 });
        e.ring.position.set(Math.round(e.x), Math.round(e.y) - 1);
        e.ring.visible = true;
      }
    }

    // area labels
    for (const [id, bubble] of this.emotes) {
      const e = this.ents.get(id);
      if (!e || now >= bubble.until) { bubble.text.destroy(); this.emotes.delete(id); changed = true; continue; }
      bubble.text.visible = e.label.visible;
      bubble.text.position.set(e.x * S + this.camX, e.y * S + this.camY - (26 + extraHeight(e.frames)) * S - 28);
    }

    // area labels
    for (const l of this.areaLabels) {
      const a = this.map.areas[l.ai];
      const sx = (a.x + a.w / 2) * T * S + this.camX;
      const sy = (a.y + 0.2) * T * S + this.camY;
      l.text.visible = sx > -100 && sx < W + 100 && sy > -20 && sy < H;
      l.text.position.set(Math.round(sx), Math.round(sy));
    }

    for (const l of this.placeholderLabels) {
      const sx = l.x * S + this.camX;
      const sy = l.y * S + this.camY;
      l.text.visible = sx > -100 && sx < W + 100 && sy > -20 && sy < H + 20;
      l.text.position.set(Math.round(sx), Math.round(sy));
    }

    for (const l of this.deskLabels) {
      const sx = l.x * S + this.camX;
      const sy = l.y * S + this.camY;
      l.text.visible = S >= 3 && sx > -60 && sx < W + 60 && sy > 0 && sy < H + 20;
      l.text.position.set(Math.round(sx), Math.round(sy));
    }

    // locate marker
    this.fxG.clear();
    if (this.hover) this.fxG.rect(this.hover.x * T, this.hover.y * T, this.hover.w * T, this.hover.h * T).stroke({ color: 0xffb84d, width: 1 }).fill({ color: 0xffb84d, alpha: 0.18 });
    if (this.dest) {
      const k = (now % 700) / 700;
      const r = 3 + k * 3;
      this.fxG.poly([this.dest.x, this.dest.y - r, this.dest.x + r, this.dest.y, this.dest.x, this.dest.y + r, this.dest.x - r, this.dest.y]).stroke({ color: 0x3cc9b0, width: 1, alpha: 1 - k * 0.6 });
      this.fxG.circle(this.dest.x, this.dest.y, 1.5).fill(0x3cc9b0);
    }
    this.hudG.clear();
    if (this.locate) {
      if (now > this.locate.until) { this.locate = null; changed = true; }
      else {
        const pulse = (now % 900) / 900;
        this.fxG.circle(this.locate.x, this.locate.y, 6 + pulse * 14).stroke({ color: 0xffb84d, width: 2, alpha: 1 - pulse });
        const sx = this.locate.x * S + this.camX, sy = this.locate.y * S + this.camY;
        if (sx < 0 || sy < 0 || sx > W || sy > H) {
          const ang = Math.atan2(sy - H / 2, sx - W / 2);
          const ex = Math.max(24, Math.min(W - 24, sx)), ey = Math.max(24, Math.min(H - 24, sy));
          this.hudG.poly([ex + Math.cos(ang) * 14, ey + Math.sin(ang) * 14, ex + Math.cos(ang + 2.5) * 10, ey + Math.sin(ang + 2.5) * 10, ex + Math.cos(ang - 2.5) * 10, ey + Math.sin(ang - 2.5) * 10]).fill(0xffb84d);
        }
      }
    }

    // location signboard animation: slide in, hold, slide out
    {
      const t = now - this.bannerT0;
      const h = 38, total = 2600, slide = 260;
      if (t < 0 || t > total) this.banner.visible = false;
      else {
        const k = t < slide ? t / slide : t > total - slide ? (total - t) / slide : 1;
        const e = 1 - (1 - k) * (1 - k);
        this.banner.visible = true;
        this.banner.position.set(Math.round((W - this.bannerW) / 2), Math.round(-h + (h + 60) * e));
      }
    }

    if (this.plugins.step(deltaMS, now)) changed = true;
    if (this.placeHoverTag()) changed = true;

    // animations that redraw on their own every frame
    if (this.emotes.size || this.dest || this.locate || this.banner.visible) changed = true;
    if (changed || now - this.lastRender >= IDLE_RENDER_MS) {
      this.app.render();
      this.lastRender = now;
      this.nRenders++;
      this.rendersTotal++;
    }

    // stats
    this.nFrames++;
    this.msFrames += performance.now() - t0;
    if (now - this.lastStat >= 1000) {
      const secs = (now - this.lastStat) / 1000;
      this.stats = {
        fps: Math.round(this.nFrames / secs),
        frameMs: +(this.msFrames / Math.max(1, this.nFrames)).toFixed(2),
        worldMsgs: Math.round(this.nWorld / secs),
        entities: this.ents.size,
        visible,
        renders: Math.round(this.nRenders / secs),
      };
      this.nRenders = 0;
      this.nFrames = 0; this.msFrames = 0; this.nWorld = 0; this.lastStat = now;
    }
  }

  private drawDot(e: Ent) {
    this.dirty = true;
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
}

/**
 * Camera offset c (screen px, one axis) moved as little as possible so the visible map stays within
 * R world px of the player at p; when the window is wider than 2R both ends cannot hold: centre on p.
 */
function reachClamp(c: number, W: number, S: number, p: number, R: number, mapLen: number) {
  const hi = p - R > 0 ? (R - p) * S : Infinity; // the map's near end is out of reach: c at most this
  const lo = p + R < mapLen ? W - (p + R) * S : -Infinity; // the far end is out of reach: c at least this
  if (lo > hi) return W / 2 - p * S;
  return Math.min(hi, Math.max(lo, c));
}

function autoScale(width: number, height: number) {
  return Math.max(2, Math.min(6, Math.floor(Math.min(width / VIEW_REF_W, height / VIEW_REF_H))));
}
function readZoom() {
  try {
    return Math.round(Number(localStorage.getItem("hq.zoom"))) || 0;
  } catch {
    return 0;
  }
}
function writeZoom(z: number) {
  try {
    localStorage.setItem("hq.zoom", String(z));
  } catch {
    // storage blocked: the zoom is just not remembered
  }
}

/** A dashed rectangle outline (2 px dashes) for the caller to stroke. */
function dashedRect(g: Graphics, x: number, y: number, w: number, h: number) {
  const DASH = 2;
  for (let i = 0; i < w; i += DASH * 2) {
    const e = Math.min(i + DASH, w);
    g.moveTo(x + i, y).lineTo(x + e, y);
    g.moveTo(x + i, y + h).lineTo(x + e, y + h);
  }
  for (let i = 0; i < h; i += DASH * 2) {
    const e = Math.min(i + DASH, h);
    g.moveTo(x, y + i).lineTo(x, y + e);
    g.moveTo(x + w, y + i).lineTo(x + w, y + e);
  }
}
