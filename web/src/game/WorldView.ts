// The PixiJS world view: the orchestrator of the layers that draw the office (layer.ts and
// docs/decisions/0033-world-view-layers.md). It owns the application and the ViewContext, hands events to the
// layers as direct calls, and on each frame advances me, places the camera, updates every layer in a
// fixed order and draws only when one of them changed (render on demand). Nothing here draws itself.
import { Application, Container, Rectangle } from "pixi.js";
import type { Ack, MapData, Person, PluginObjectSpec, Prop, SelfPosition, WorldDelta } from "../net/protocol";
import { bakeMapCanvas } from "./art/tiles";
import { AvatarLayer } from "./avatarLayer";
import { areaGrid, shownAreas } from "./areas";
import { Camera, zoomStore } from "./camera";
import { HudLayer } from "./hudLayer";
import { InputController } from "./input";
import { LabelLayer } from "./labelLayer";
import { shouldRender, updateLayers, type Layer, type ViewContext } from "./layer";
import { LocalPlayer } from "./localPlayer";
import { MapLayer } from "./mapLayer";
import { canStandStatic, solidGrid } from "./motion";
import { ObjectLayer } from "./objectLayer";
import { PluginLayer } from "./pluginLayer";

export { bitmapFonts } from "./mapText";

const T = 16;

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

  // Not layers: me (what the camera follows) and the keyboard and mouse.
  /** Held direction, running, server-steered walks, my predicted position and area (localPlayer.ts). */
  private player: LocalPlayer;
  /** Keys, wheel, drag and the mouse over the map (input.ts). */
  private input: InputController;

  // The layers, each a module of its own (see `layers` for their order).
  /** The baked map and the desks and pcs drawn over it (mapLayer.ts). */
  private mapLayer = new MapLayer();
  /** People: sprites, name tags, badges, emotes, speaking rings (avatarLayer.ts). */
  private avatars: AvatarLayer;
  /** Plugin map objects, editor placeholders and the object within reach (objectLayer.ts). */
  private objects: ObjectLayer;
  /** Sprites drawn for plugins (src/plugins): they sort with avatars. Given its parent now: the session
   *  hands it to the PluginManager before the view starts. */
  readonly plugins = new PluginLayer(this.ctx.entLayer, {
    owner: (id) => this.avatars.owner(id),
    canStand: (x, y) => !!this.ctx.map && canStandStatic(this.ctx.grid, x, y),
    avatars: () => this.avatars.avatars(),
    me: () => this.ctx.meId,
    headPoint: (id, out) => this.avatars.headPoint(id, out),
  });
  /** Markers: hover rectangle, destination, locate pulse, hover tag (hudLayer.ts). */
  private hudLayer: HudLayer;
  /** Area and desk names, and the location signboard (labelLayer.ts). */
  private labelLayer = new LabelLayer();
  /**
   * Initialised, updated each frame and destroyed in this order. The order is part of the contract:
   * init adds Containers in it (world: entLayer, placeholders, markers; hud: arrow, hover tag, banner),
   * plugin sprites follow the avatars they are pinned to, and the hover tag looks for plugin sprites
   * where they were just drawn.
   */
  private layers: readonly Layer[];

  private destroyed = false;

  // stats
  private nFrames = 0;
  private msFrames = 0;
  private lastStat = performance.now();
  private nWorld = 0;
  stats: ViewStats = { fps: 0, frameMs: 0, worldMsgs: 0, entities: 0, visible: 0, renders: 0 };
  private nRenders = 0;
  rendersTotal = 0; // frames drawn since start (tests)
  private lastRender = 0;

  /** The props of the map shown changed (a new map or an editor draft): plugins hear of their objects. */
  onProps: ((props: Prop[]) => void) | null = null;
  private cleanup: (() => void)[] = [];

  constructor(private hooks: ViewHooks) {
    this.player = new LocalPlayer(this.ctx, hooks, (name) => this.labelLayer.showBanner(name));
    this.input = new InputController(this.ctx, this.player, hooks, this);
    this.avatars = new AvatarLayer(this.player);
    this.objects = new ObjectLayer(this.player.self, (prop) => hooks.onNearby?.(prop));
    this.hudLayer = new HudLayer(this.player, this.input, this.plugins);
    this.layers = [this.mapLayer, this.avatars, this.objects, this.plugins, this.hudLayer, this.labelLayer];
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
    for (const l of this.layers) l.init(this.ctx);
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
    for (const l of this.layers) l.destroy();
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

  // ---- me ----
  /** Public so tests can drive movement without synthesising key events. */
  setDirection(dx: number, dy: number) {
    this.player.setDirection(dx, dy);
  }

  /** Shift inverts "always run", so either habit works. */
  get running() {
    return this.player.running;
  }
  /** Public: the HUD button and tests switch "always run". */
  toggleRun(on?: boolean) {
    this.player.toggleRun(on);
  }

  /** Run to a tile; the server finds the path (walls, locked rooms) and steers. */
  goTo(tx: number, ty: number) {
    this.player.goTo(tx, ty);
  }

  setMe(id: number, x: number, y: number, speed: number, runMul = 2) {
    this.ctx.meId = id;
    this.player.setMe(x, y, speed, runMul);
    this.avatars.placeMe(id, x, y);
    // A reconnect must never leave the player "stuck walking".
    this.player.dx = this.player.dy = 0;
    this.input.keys.clear();
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

  applySelf(m: SelfPosition) {
    if (this.player.applySelf(m)) this.input.keys.clear(); // a teleport
  }

  /** Server reconciliation (motion.ts, LocalMotion.ack). */
  applyAck(a: Ack) {
    this.player.ack(a.s, a.x, a.y);
  }

  position() {
    return { x: this.player.self.x, y: this.player.self.y };
  }

  interact() {
    this.objects.updateNearby();
    if (this.objects.nearby) this.hooks.onInteract?.(this.objects.nearby);
  }

  // ---- data ----
  /** A new map: each layer that depends on it hears of it, in this order (the order labels join the hud). */
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
    if (this.avatars.me) this.player.recount();
    this.layout();
  }

  setPeople(people: Map<number, Person>) {
    this.avatars.setPeople(people);
    this.relabel(); // an online person names a place the server has not named yet (an editor preview)
  }

  setSpeaking(ids: Set<number>) {
    this.avatars.setSpeaking(ids);
  }

  setInConversation(ids: Set<number>) {
    this.avatars.setInConversation(ids);
  }

  setSharing(ids: Set<number>) {
    this.avatars.setSharing(ids);
  }

  showEmote(id: number, kind: number) {
    this.avatars.showEmote(id, kind);
  }

  applyWorld(m: WorldDelta) {
    this.ctx.dirty = true;
    this.nWorld++;
    this.avatars.applyWorld(m);
  }

  clearRemote() {
    this.avatars.clearRemote();
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

  private relabel() {
    if (!this.ctx.map) return;
    this.ctx.dirty = true;
    this.labelLayer.relabel();
    if (this.avatars.me) this.player.tellArea();
  }

  /** Public: the text of every desk and area label on the map, as drawn (tests read it). */
  labels() {
    return this.labelLayer.labels();
  }

  /** The map objects of the running plugins (PluginManager): drawn on the map, and X uses them. */
  setPluginObjects(specs: PluginObjectSpec[]) {
    this.objects.setSpecs(specs);
  }

  showLocation(x: number, y: number) {
    this.hudLayer.showLocation(x, y);
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
  setHover(h: { x: number; y: number; w: number; h: number } | null) {
    this.hudLayer.setHover(h);
  }
  screenToTile(clientX: number, clientY: number): [number, number] {
    const r = this.app.canvas.getBoundingClientRect();
    const wx = (clientX - r.left - this.ctx.cam.x) / this.ctx.cam.S;
    const wy = (clientY - r.top - this.ctx.cam.y) / this.ctx.cam.S;
    return [Math.floor(wx / T), Math.floor(wy / T)];
  }

  /** The baked office picture (shared with the minimap, never re-rendered for it). */
  mapImage() {
    return this.mapLayer.baked;
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

  /** Smallest and largest scale for this window. */
  scaleRange(width = this.app.screen.width, height = this.app.screen.height): [number, number] {
    return this.ctx.cam.range(width, height);
  }

  get scale() {
    return this.ctx.cam.S;
  }

  /** Whether a box may stand at (x, y) on walls alone (motion.ts), as plugin sprites walk. */
  canStandStatic(x: number, y: number) {
    return canStandStatic(this.ctx.grid, x, y);
  }

  // ---- layout / frame ----
  private layout() {
    this.ctx.dirty = true;
    if (!this.app) return;
    const { width, height } = this.app.screen;
    this.ctx.world.scale.set(this.ctx.cam.fit(width, height));
  }

  private frame(deltaMS: number) {
    const map = this.ctx.map;
    if (this.destroyed || !map) return;
    const t0 = performance.now();
    const dt = Math.min(deltaMS / 1000, 0.1);
    const now = t0;
    const ctx = this.ctx, cam = ctx.cam, player = this.player;
    const { width: W, height: H } = this.app.screen;

    // me first: the camera follows where I am drawn
    player.update(dt, now);
    if (player.steering && (cam.panX || cam.panY || this.input.pressed)) {
      // moving recentres the camera on me, and ends a drag in progress
      this.input.dropDrag();
      cam.panX = cam.panY = 0;
    }
    let changed = ctx.dirty;
    ctx.dirty = false;
    const mapW = map.w * T, mapH = map.h * T;
    if (cam.follow(W, H, player.rx, player.ry, mapW, mapH)) changed = true;
    const need = cam.view(W, H, player.rx, player.ry, mapW, mapH);
    if (need >= 0) this.hooks.onView?.(need);
    ctx.world.position.set(cam.x, cam.y);

    // every layer, in order; each says whether it changed something on screen
    if (updateLayers(this.layers, dt, now)) changed = true;
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
        entities: this.avatars.ents.size,
        visible: this.avatars.visible,
        renders: Math.round(this.nRenders / secs),
      };
      this.nRenders = 0;
      this.nFrames = 0; this.msFrames = 0; this.nWorld = 0; this.lastStat = now;
    }
  }

  // ---- tests (window.__hq.view) and the art scripts read these, as they read the fields they once were ----
  /** My id (0 before hello). */
  get meId() {
    return this.ctx.meId;
  }
  set meId(v: number) {
    this.ctx.meId = v;
  }
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
  get ents() {
    return this.avatars.ents;
  }
  get emotes() {
    return this.avatars.emotes;
  }
  /** Whether my avatar goes at run speed now, as the server moves it. */
  get fast() {
    return this.player.fast;
  }
  /** The direction held, whether the server steers me, and where a walk-to is heading. */
  get dx() {
    return this.player.dx;
  }
  get dy() {
    return this.player.dy;
  }
  get guided() {
    return this.player.guided;
  }
  get dest() {
    return this.player.dest;
  }
  /** The area index I am in (room access), and the areas I may not enter. */
  get mArea() {
    return this.player.where.area;
  }
  get deny() {
    return this.ctx.grid.deny;
  }
  /** The spot located (cleared when its pulse ends; tests clear it to wait for the next one). */
  get locate() {
    return this.hudLayer.locate;
  }
  set locate(v: { x: number; y: number; until: number } | null) {
    this.hudLayer.locate = v;
  }
  get areaLabels() {
    return this.labelLayer.areaLabels;
  }
  get deskLabels() {
    return this.labelLayer.deskLabels;
  }
  get banner() {
    return this.labelLayer.banner;
  }
  /** The sprites drawn for plugin objects, and the editor's placeholder labels. */
  get objSprites() {
    return this.objects.sprites;
  }
  get placeholderLabels() {
    return this.objects.placeholderLabels;
  }
  /** Camera pan in world px. */
  get pan() {
    return { x: this.ctx.cam.panX, y: this.ctx.cam.panY };
  }
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
  /** Where world point (x, y) is in the page, and the hover tag's text ("" while hidden). */
  pageOf(x: number, y: number): { x: number; y: number } {
    const r = this.app.canvas.getBoundingClientRect();
    return { x: r.left + this.ctx.cam.x + x * this.ctx.cam.S, y: r.top + this.ctx.cam.y + y * this.ctx.cam.S };
  }
  hoverText(): string {
    return this.hudLayer.hoverText();
  }

  /** How many depth sprites stand for desks and for pcs. */
  debugDepth() {
    return this.mapLayer.debugDepth();
  }

  /** A hash of the world's pixels over rect (world px, 1:1), with or without the depth sprites and
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

  /** A hash of what the bake paints for a map. */
  debugBakeHash(map: MapData) {
    const c = bakeMapCanvas(map);
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let h = 0x811c9dc5;
    for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 0x01000193);
    return (h >>> 0).toString(16);
  }

  debugEntities() {
    return this.avatars.debugEntities();
  }
}
