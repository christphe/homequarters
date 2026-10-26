import { Application, BitmapText, Container, Graphics, Rectangle, Sprite, Text } from "pixi.js";
import { NOTE_STYLE, TAG_STYLE } from "./mapText";
import { LabelLayer } from "./labelLayer";
import { shouldRender, type ViewContext } from "./layer";
import type { Ack, AvatarSpec, MapData, Person, PluginObjectSpec, Prop, SelfPosition, WorldDelta } from "../net/protocol";
import { DANCE, EMOTES } from "./emotes";
import { InputController } from "./input";
import { ObjectLayer } from "./objectLayer";
import { avatarFramesFor, releaseAvatar, FEET_Y, CELL_H, type AvatarFrames } from "./avatars";
import { bakeMapCanvas } from "./art/tiles";
import { MapLayer } from "./mapLayer";
import { PluginLayer } from "./pluginLayer";
import { LocalPlayer } from "./localPlayer";
import { canStandStatic, retarget, solidGrid, stepRemote, type Remote } from "./motion";
import { Camera, zoomStore } from "./camera";
import { areaGrid, shownAreas } from "./areas";

export { bitmapFonts } from "./mapText";

const T = 16;
const STATUS_COLOR: Record<string, number> = { available: 0x5ec26a, busy: 0xe5584f, away: 0xf2d14b, offline: 0x8e8e9a, invisible: 0x8e8e9a };
// Name tags sit where they always did (just over a plain head, whose drawing rises 22 px above the feet),
// plus whatever a hat or tall hair adds on top.
const extraHeight = (f: AvatarFrames) => Math.max(0, f.tall - 22);

const DEFAULT_AV: AvatarSpec = { sk: 1, hs: 0, hc: 1, sh: 4, pa: 1 };

/** A person on the map: where they are (Remote, dead-reckoned when they are not me) and what draws them. */
interface Ent extends Remote {
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
  app!: Application;
  /** What the layers share (layer.ts): the stage, the camera, the map, the people. */
  private ctx: ViewContext = {
    app: null as unknown as Application, // set in init(), before any layer's init
    world: new Container(),
    entLayer: new Container(),
    hud: new Container(),
    /** Scale, zoom, pan, where the world sits on screen, and the interest radius asked for (camera.ts). */
    cam: new Camera(zoomStore(() => localStorage)),
    dirty: true,
    eco: false,
    map: null,
    grid: { w: 0, h: 0, solid: new Uint8Array(0), areaAt: new Int16Array(0), deny: new Set() },
    shownOf: new Int16Array(0),
    people: new Map<number, Person>(),
    nameOf: (id) => this.owners.get(id) ?? this.ctx.people.get(id)?.n,
    meId: 0,
  };
  /** Names of the members places belong to (the server's owner names); online people fill the gaps. */
  private owners = new Map<number, string>();
  private fxG = new Graphics();
  private hudG = new Graphics();
  /** Area and desk names, and the location signboard (labelLayer.ts). */
  private labelLayer = new LabelLayer();
  private ents = new Map<number, Ent>();
  /** Sprites drawn for plugins (src/plugins): they sort with avatars. */
  readonly plugins = new PluginLayer(this.ctx.entLayer, {
    owner: (id) => {
      const e = this.ents.get(id);
      if (!e) return null;
      const fast = e.id === this.ctx.meId ? this.player.fast : e.run;
      return { x: e.x, y: e.y, dir: e.dir, v: (fast ? this.player.runMul : 1) * this.player.speed, visible: e.spr.visible };
    },
    canStand: (x, y) => !!this.ctx.map && canStandStatic(this.ctx.grid, x, y),
    avatars: () => [...this.ents.values()].filter((e) => e.spr.visible).map((e) => ({ id: e.id, name: e.name, x: Math.round(e.x), y: Math.round(e.y), dir: e.dir, moving: e.moving })),
    me: () => this.ctx.meId,
    headPoint: (id, out) => {
      const e = this.ents.get(id);
      if (!e || !e.spr.visible) return false;
      // the name tag is in screen pixels, over the drawing's real top; the sprite goes 2 px above its top
      out.x = e.x;
      out.y = e.y - (24 * 0.9 + extraHeight(e.frames) + (e.text.height + 2) / this.ctx.cam.S);
      out.feetY = e.y;
      return true;
    },
  });
  /** Me: held direction, running, server-steered walks, my predicted position and area (localPlayer.ts). */
  private player: LocalPlayer;
  /** Keys, wheel, drag and the mouse over the map (input.ts). */
  private input: InputController;
  /** A plugin sprite's label and its owner's name, shown while the mouse is over the sprite. */
  private hoverTag = new BitmapText({ text: "", style: NOTE_STYLE });
  /** The baked map and the desks and pcs drawn over it (mapLayer.ts). */
  private mapLayer = new MapLayer();
  private destroyed = false;

  // local player
  private meEnt: Ent | null = null;

  // stats
  private nFrames = 0;
  private msFrames = 0;
  private lastStat = performance.now();
  private nWorld = 0;
  stats: ViewStats = { fps: 0, frameMs: 0, worldMsgs: 0, entities: 0, visible: 0, renders: 0 };
  private nRenders = 0;
  rendersTotal = 0; // frames drawn since start (tests)
  private lastRender = 0;

  private locate: { x: number; y: number; until: number } | null = null;
  private hover: { x: number; y: number; w: number; h: number } | null = null;
  /** Plugin map objects, editor placeholders and the object within reach (objectLayer.ts). */
  private objects: ObjectLayer;
  /** The props of the map shown changed (a new map or an editor draft): plugins hear of their objects. */
  onProps: ((props: Prop[]) => void) | null = null;
  private emotes = new Map<number, { text: Text; until: number }>();
  private cleanup: (() => void)[] = [];

  constructor(private hooks: ViewHooks) {
    this.player = new LocalPlayer(this.ctx, hooks, (name) => this.labelLayer.showBanner(name));
    this.objects = new ObjectLayer(this.player.self, (prop) => hooks.onNearby?.(prop));
    this.input = new InputController(this.ctx, this.player, hooks, this);
  }

  /** My id (0 before hello). */
  get meId() {
    return this.ctx.meId;
  }
  /** The map shown (tests read view.map). */
  get map() {
    return this.ctx.map;
  }
  /** Something changed outside frame(): draw the next frame (the art scripts set it). */
  get dirty() {
    return this.ctx.dirty;
  }
  set dirty(v: boolean) {
    this.ctx.dirty = v;
  }

  async init(host: HTMLElement, eco: boolean) {
    await document.fonts.load('16px "Jersey 10"').catch(() => []);
    this.ctx.eco = eco;
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
    this.app = this.ctx.app = app;
    host.appendChild(app.canvas);
    app.canvas.style.display = "block";
    app.stage.addChild(this.ctx.world, this.ctx.hud);
    this.ctx.world.addChild(this.ctx.entLayer);
    this.ctx.entLayer.sortableChildren = true;
    this.mapLayer.init(this.ctx);
    this.objects.init(this.ctx);
    this.ctx.world.addChild(this.fxG);
    this.ctx.hud.addChild(this.hudG);
    this.hoverTag.anchor.set(0.5, 1);
    this.hoverTag.visible = false;
    this.ctx.hud.addChild(this.hoverTag);
    this.labelLayer.init(this.ctx);
    app.ticker.maxFPS = eco ? 30 : 0;
    app.ticker.remove(app.render, app); // frame() draws, and only when something changed
    app.ticker.add((t) => this.frame(t.deltaMS));
    this.layout();
    app.renderer.on("resize", () => this.layout());

    this.input.init();
    const vis = () => {
      if (document.hidden) {
        this.input.releaseKeys();
        app.ticker.stop(); // no rendering in hidden tabs; sockets and calls keep running
      } else {
        app.ticker.start();
        this.hooks.onResume(); // extrapolation did not run while hidden: ask for fresh states
      }
    };
    document.addEventListener("visibilitychange", vis);
    this.cleanup.push(() => document.removeEventListener("visibilitychange", vis));
  }

  destroy() {
    this.destroyed = true;
    this.input.destroy();
    this.cleanup.forEach((f) => f());
    this.app?.destroy(true, { children: true });
  }

  setEco(eco: boolean) {
    this.ctx.dirty = true;
    this.ctx.eco = eco;
    this.app.ticker.maxFPS = eco ? 30 : 0;
    const r = Math.min(window.devicePixelRatio || 1, eco ? 1 : 2);
    this.app.renderer.resolution = r;
    this.app.renderer.resize(this.app.screen.width, this.app.screen.height);
  }

  /** Public so tests can drive movement without synthesising key events. */
  setDirection(dx: number, dy: number) {
    this.player.setDirection(dx, dy);
  }

  // ---- running ----
  /** Shift inverts "always run", so either habit works. */
  get running() {
    return this.player.running;
  }
  /** Tests: whether my avatar goes at run speed now, as the server moves it. */
  get fast() {
    return this.player.fast;
  }
  /** Public: the HUD button and tests switch "always run". */
  toggleRun(on?: boolean) {
    this.player.toggleRun(on);
  }

  /** Run to a tile; the server finds the path (walls, locked rooms) and steers. */
  goTo(tx: number, ty: number) {
    this.player.goTo(tx, ty);
  }

  /** Tests: the direction held, and whether the server steers me. */
  get dx() {
    return this.player.dx;
  }
  get dy() {
    return this.player.dy;
  }
  get guided() {
    return this.player.guided;
  }
  /** Tests: where a walk-to is heading (world px), as destination(). */
  get dest() {
    return this.player.dest;
  }

  // ---- data ----
  setMap(map: MapData, deny: number[]) {
    this.ctx.dirty = true;
    this.ctx.map = map;
    this.ctx.grid = { w: map.w, h: map.h, solid: solidGrid(map), areaAt: areaGrid(map), deny: new Set(deny) };
    this.mapLayer.onMap(map);
    // desk rooms (derived from assigned desks, "auto") are named after the area under them
    this.ctx.shownOf = shownAreas(map);
    this.labelLayer.onMap(map);
    this.objects.onMap(map);
    this.onProps?.(map.props);
    // a new map may put a room under me (a desk just taken) or move area indexes: recount where I
    // stand, as the server does on a reload
    if (this.meEnt) this.player.recount();
    this.layout();
  }

  setMe(id: number, x: number, y: number, speed: number, runMul = 2) {
    this.ctx.meId = id;
    this.player.setMe(x, y, speed, runMul);
    if (!this.meEnt) {
      this.meEnt = this.makeEnt(id);
      this.ents.set(id, this.meEnt);
    }
    this.meEnt.x = x;
    this.meEnt.y = y;
    // A reconnect must never leave the player "stuck walking".
    this.player.dx = this.player.dy = 0;
    this.input.keys.clear();
  }

  setPeople(people: Map<number, Person>) {
    this.ctx.dirty = true;
    // someone who left the office frees their look (once their sprite is gone too); leaving the screen does not
    for (const id of this.ctx.people.keys()) if (!people.has(id) && !this.ents.has(id)) releaseAvatar(id);
    this.ctx.people = people;
    for (const e of this.ents.values()) this.refreshEnt(e);
    this.relabel(); // an online person names a place the server has not named yet (an editor preview)
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

  // ---- map editor support ----
  currentMap() {
    return this.ctx.map;
  }
  /** The map editor opened or closed: it shows objects of plugins that are not running. */
  setEditing(on: boolean) {
    this.objects.setEditing(on);
  }
  /** Re-render/re-collide with an unsaved draft (deny rules are kept). */
  previewMap(map: MapData) {
    this.setMap(map, [...this.ctx.grid.deny]);
  }
  /** Shows the label of the plugin sprite under the mouse (and its owner's name), or hides it; true when it changed. */
  private placeHoverTag(): boolean {
    const tag = this.hoverTag;
    const mouse = this.input.mouse;
    const m = !mouse || this.input.dragging || document.querySelector(".scrim") ? null : mouse;
    const hit = m ? this.plugins.labelAt((m.x - this.ctx.cam.x) / this.ctx.cam.S, (m.y - this.ctx.cam.y) / this.ctx.cam.S) : null;
    if (!hit) {
      if (!tag.visible) return false;
      tag.visible = false;
      return true;
    }
    const owner = hit.owner ? this.ctx.people.get(hit.owner)?.n : undefined;
    const text = owner ? hit.text + "\n(" + owner + ")" : hit.text;
    const x = Math.round(this.ctx.cam.x + hit.x * this.ctx.cam.S), y = Math.round(this.ctx.cam.y + hit.top * this.ctx.cam.S - 2);
    if (tag.visible && tag.text === text && tag.x === x && tag.y === y) return false;
    tag.text = text;
    tag.position.set(x, y);
    if (!tag.visible) this.ctx.hud.addChild(tag); // above the name tags added since
    tag.visible = true;
    return true;
  }
  /** Tests: where world point (x, y) is in the page, and the hover tag's text ("" while hidden). */
  pageOf(x: number, y: number): { x: number; y: number } {
    const r = this.app.canvas.getBoundingClientRect();
    return { x: r.left + this.ctx.cam.x + x * this.ctx.cam.S, y: r.top + this.ctx.cam.y + y * this.ctx.cam.S };
  }
  hoverText(): string {
    return this.hoverTag.visible ? this.hoverTag.text : "";
  }
  screenToTile(clientX: number, clientY: number): [number, number] {
    const r = this.app.canvas.getBoundingClientRect();
    const wx = (clientX - r.left - this.ctx.cam.x) / this.ctx.cam.S;
    const wy = (clientY - r.top - this.ctx.cam.y) / this.ctx.cam.S;
    return [Math.floor(wx / T), Math.floor(wy / T)];
  }
  setHover(h: { x: number; y: number; w: number; h: number } | null) {
    this.ctx.dirty = true;
    this.hover = h;
  }
  teleport(x: number, y: number) {
    this.player.teleport(x, y);
    this.input.keys.clear();
  }

  /** The server steers me (a walk-to when run, else following a person) or stopped steering. */
  setGuided(on: boolean, run = true) {
    this.player.setGuided(on, run);
    if (on) this.input.keys.clear();
    else this.input.applyKeys(); // the server stopped steering: hand control back to whatever keys are held now
  }

  /** The server refused or finished a walk-to. */
  clearDest() {
    this.ctx.dirty = true;
    this.player.dest = null;
  }

  /** Where a walk-to is heading (world px), for the minimap. */
  destination() {
    return this.player.dest;
  }

  /** The baked office picture (shared with the minimap, never re-rendered for it). */
  mapImage() {
    return this.mapLayer.baked;
  }

  applySelf(m: SelfPosition) {
    if (this.player.applySelf(m)) this.input.keys.clear(); // a teleport
  }

  setDeny(deny: number[]) {
    this.ctx.dirty = true;
    this.ctx.grid.deny = new Set(deny);
    this.relabel();
  }

  /** Owner names changed (a new map, a rename): desks and offices show the current names. */
  setOwners(owners: Map<number, string>) {
    this.owners = owners;
    this.relabel();
  }

  /** Public: the text of every desk and area label on the map, as drawn (tests read it). */
  labels() {
    return this.labelLayer.labels();
  }

  /** Tests and the art scripts: the label and banner texts. */
  get areaLabels() {
    return this.labelLayer.areaLabels;
  }
  get deskLabels() {
    return this.labelLayer.deskLabels;
  }
  get banner() {
    return this.labelLayer.banner;
  }

  private relabel() {
    if (!this.ctx.map) return;
    this.ctx.dirty = true;
    this.labelLayer.relabel();
    if (this.meEnt) this.player.tellArea();
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

  interact() {
    this.objects.updateNearby();
    if (this.objects.nearby) this.hooks.onInteract?.(this.objects.nearby);
  }

  /** The map objects of the running plugins (PluginManager): drawn on the map, and X uses them. */
  setPluginObjects(specs: PluginObjectSpec[]) {
    this.objects.setSpecs(specs);
  }

  /** Tests: the sprites drawn for plugin objects, and the editor's placeholder labels. */
  get objSprites() {
    return this.objects.sprites;
  }
  get placeholderLabels() {
    return this.objects.placeholderLabels;
  }

  showLocation(x: number, y: number) {
    this.ctx.dirty = true;
    this.locate = { x, y, until: performance.now() + 5000 };
  }

  applyWorld(m: WorldDelta) {
    this.ctx.dirty = true;
    this.nWorld++;
    if (m.m) {
      for (const [id, x, y, d] of m.m) {
        if (id === this.ctx.meId) continue;
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
    if (m.l) for (const id of m.l) if (id !== this.ctx.meId) this.removeEnt(id);
  }

  /** Server reconciliation (motion.ts, LocalMotion.ack). */
  applyAck(a: Ack) {
    this.player.ack(a.s, a.x, a.y);
  }

  clearRemote() {
    for (const id of [...this.ents.keys()]) if (id !== this.ctx.meId) this.removeEnt(id);
  }

  position() {
    return { x: this.player.self.x, y: this.player.self.y };
  }

  /** Tests: the area index I am in (room access). */
  get mArea() {
    return this.player.where.area;
  }

  /** Tests: the areas I may not enter. */
  get deny() {
    return this.ctx.grid.deny;
  }

  /** Tests: how many depth sprites stand for desks and for pcs. */
  debugDepth() {
    return this.mapLayer.debugDepth();
  }

  /** Tests: a hash of the world's pixels over rect (world px, 1:1), with or without the depth sprites and
   * the people (avatars, pets, plugin sprites, rings and effects). */
  async debugWorldPixels(o: { depth: boolean; ents: boolean; rect: { x: number; y: number; w: number; h: number } }) {
    const depthSprites = this.mapLayer.depthSprites;
    const keep = new Set<Container>([...this.objSprites, ...(o.depth ? depthSprites : [])]);
    const depth = new Set<Container>(depthSprites);
    const shown: [Container, boolean][] = [];
    const set = (c: Container, v: boolean) => { shown.push([c, c.visible]); c.visible = v; };
    for (const c of this.ctx.entLayer.children) set(c, keep.has(c) || (o.ents && !depth.has(c)));
    for (const c of this.ctx.world.children) if (c !== this.mapLayer.sprite && c !== this.ctx.entLayer) set(c, o.ents && c.visible);
    try {
      const { pixels } = this.app.renderer.extract.pixels({ target: this.ctx.world, frame: new Rectangle(o.rect.x, o.rect.y, o.rect.w, o.rect.h), resolution: 1 });
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
    return [...this.ents.values()].filter((e) => e.id !== this.ctx.meId).map((e) => ({ id: e.id, x: e.x, y: e.y }));
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

  // ---- zoom / area of interest ----
  /** From hello: the server's interest grid, which bounds how far out the map may zoom. */
  setInterest(cellPx: number, aoi: number, aoiMax: number) {
    this.ctx.cam.setInterest(cellPx, aoi, aoiMax);
    this.layout();
  }

  /** Zooms by whole scale steps (positive = closer) and returns the scale in use. Public for tests. */
  zoomBy(steps: number) {
    if (!this.app) return this.ctx.cam.S;
    const { width, height } = this.app.screen;
    this.ctx.cam.zoomBy(steps, width, height);
    this.layout();
    return this.ctx.cam.S;
  }

  /** Camera pan in world px (tests). */
  get pan() {
    return { x: this.ctx.cam.panX, y: this.ctx.cam.panY };
  }

  get scale() {
    return this.ctx.cam.S;
  }

  // Tests (window.__hq.view) read these, as they read the fields they once were.
  get S() {
    return this.ctx.cam.S;
  }
  get camX() {
    return this.ctx.cam.x;
  }
  get camY() {
    return this.ctx.cam.y;
  }
  get panX() {
    return this.ctx.cam.panX;
  }
  set panX(v: number) {
    this.ctx.cam.panX = v;
  }
  get panY() {
    return this.ctx.cam.panY;
  }
  set panY(v: number) {
    this.ctx.cam.panY = v;
  }
  get cellPx() {
    return this.ctx.cam.cellPx;
  }
  get aoiMax() {
    return this.ctx.cam.aoiMax;
  }
  /** Whether a box may stand at (x, y) on walls alone (motion.ts), as plugin sprites walk. */
  canStandStatic(x: number, y: number) {
    return canStandStatic(this.ctx.grid, x, y);
  }

  /** Smallest and largest scale for this window. */
  scaleRange(width = this.app.screen.width, height = this.app.screen.height): [number, number] {
    return this.ctx.cam.range(width, height);
  }

  // ---- layout / frame ----
  private layout() {
    this.ctx.dirty = true;
    if (!this.app) return;
    const { width, height } = this.app.screen;
    this.ctx.world.scale.set(this.ctx.cam.fit(width, height));
  }

  private frame(deltaMS: number) {
    if (this.destroyed || !this.ctx.map) return;
    const t0 = performance.now();
    const dt = Math.min(deltaMS / 1000, 0.1);
    const now = t0;
    const cam = this.ctx.cam, S = cam.S;
    const { width: W, height: H } = this.app.screen;

    const player = this.player;
    player.update(dt, now);
    const rx = player.rx, ry = player.ry; // where my avatar is drawn

    if (player.steering && (cam.panX || cam.panY || this.input.pressed)) {
      // moving recentres the camera on me, and ends a drag in progress
      this.input.dropDrag();
      cam.panX = cam.panY = 0;
    }
    let changed = this.ctx.dirty;
    this.ctx.dirty = false;
    const mapW = this.ctx.map.w * T, mapH = this.ctx.map.h * T;
    if (cam.follow(W, H, rx, ry, mapW, mapH)) changed = true;
    const need = cam.view(W, H, rx, ry, mapW, mapH);
    if (need >= 0) this.hooks.onView?.(need);
    this.ctx.world.position.set(cam.x, cam.y);

    const walkRate = this.ctx.eco ? 5 : 8;
    let visible = 0;
    for (const e of this.ents.values()) {
      const isMe = e.id === this.ctx.meId;
      if (isMe) {
        e.x = rx; e.y = ry; e.dir = player.mdir; e.moving = !!(player.dx || player.dy);
      } else {
        stepRemote(e, this.ctx.grid, dt, player.speed * (e.run ? player.runMul : 1));
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
        if (!e.ring) { e.ring = new Graphics(); this.ctx.world.addChildAt(e.ring, 1); }
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
      bubble.text.position.set(e.x * S + cam.x, e.y * S + cam.y - (26 + extraHeight(e.frames)) * S - 28);
    }

    if (this.objects.update(dt, now)) changed = true;

    // locate marker
    this.fxG.clear();
    if (this.hover) this.fxG.rect(this.hover.x * T, this.hover.y * T, this.hover.w * T, this.hover.h * T).stroke({ color: 0xffb84d, width: 1 }).fill({ color: 0xffb84d, alpha: 0.18 });
    const dest = player.dest;
    if (dest) {
      const k = (now % 700) / 700;
      const r = 3 + k * 3;
      this.fxG.poly([dest.x, dest.y - r, dest.x + r, dest.y, dest.x, dest.y + r, dest.x - r, dest.y]).stroke({ color: 0x3cc9b0, width: 1, alpha: 1 - k * 0.6 });
      this.fxG.circle(dest.x, dest.y, 1.5).fill(0x3cc9b0);
    }
    this.hudG.clear();
    if (this.locate) {
      if (now > this.locate.until) { this.locate = null; changed = true; }
      else {
        const pulse = (now % 900) / 900;
        this.fxG.circle(this.locate.x, this.locate.y, 6 + pulse * 14).stroke({ color: 0xffb84d, width: 2, alpha: 1 - pulse });
        const sx = this.locate.x * S + cam.x, sy = this.locate.y * S + cam.y;
        if (sx < 0 || sy < 0 || sx > W || sy > H) {
          const ang = Math.atan2(sy - H / 2, sx - W / 2);
          const ex = Math.max(24, Math.min(W - 24, sx)), ey = Math.max(24, Math.min(H - 24, sy));
          this.hudG.poly([ex + Math.cos(ang) * 14, ey + Math.sin(ang) * 14, ex + Math.cos(ang + 2.5) * 10, ey + Math.sin(ang + 2.5) * 10, ex + Math.cos(ang - 2.5) * 10, ey + Math.sin(ang - 2.5) * 10]).fill(0xffb84d);
        }
      }
    }

    if (this.labelLayer.update(dt, now)) changed = true; // the banner animates while shown
    if (this.plugins.update(dt, now)) changed = true;
    if (this.placeHoverTag()) changed = true;

    // animations that redraw on their own every frame
    if (this.emotes.size || player.dest || this.locate) changed = true;
    if (shouldRender(changed, now, this.lastRender)) {
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
}
