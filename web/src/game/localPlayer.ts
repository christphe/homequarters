// Me: the direction I hold, running, a walk the server steers, my predicted position (motion.ts) and the
// area I am in (areas.ts). It draws nothing (the AvatarLayer draws me where `rx, ry` say); WorldView
// advances it first on every frame, then places the camera on it.
import type { SelfPosition } from "../net/protocol";
import { LocalMotion } from "./motion";
import { SAME, SHOWN, Whereabouts, areaIndex, shownArea } from "./areas";
import { areaTitle } from "./places";
import type { ViewContext } from "./layer";
import type { ViewHooks } from "./WorldView";

const T = 16;
const HEARTBEAT_MS = 400; // re-send held input so the server can correct drift

export class LocalPlayer {
  /** My position, predicted and reconciled with the server (motion.ts); drawn at x+ox, y+oy. */
  readonly self = new LocalMotion();
  /** Where my avatar is drawn this frame (set by update). */
  rx = 0;
  ry = 0;
  /** The direction held (-1, 0, 1 each) and the way I face (0 down, 1 left, 2 right, 3 up). */
  dx = 0;
  dy = 0;
  mdir = 0;
  private lastBeat = 0;
  /** The office's walking speed (px/s) and how much faster running is: remote people go at it too. */
  speed = 72;
  runMul = 2;
  private runHeld = false; // Shift
  private runToggle = false; // "always run" (R or the HUD button)
  guided = false;
  private guidedRun = false; // a walk-to runs; following a person goes at their pace (`self` tells)
  /** Where a walk-to is heading (world px). */
  dest: { x: number; y: number } | null = null;
  /** My area (room access) and the area named for it (the signboard). */
  readonly where = new Whereabouts();

  constructor(
    private ctx: ViewContext,
    private hooks: Pick<ViewHooks, "sendInput" | "onArea" | "onRun" | "onGoto">,
    private banner: (name: string) => void,
  ) {}

  /** One frame, before the camera: integrate my movement, re-send held input now and then, fade corrections in. */
  update(dt: number, now: number) {
    this.advance(now);
    if (!this.guided && (this.dx || this.dy) && now - this.lastBeat > HEARTBEAT_MS) this.sendDir();
    const self = this.self;
    self.blend(dt, this.dx, this.dy, this.speed);
    this.rx = self.x + self.ox;
    this.ry = self.y + self.oy;
  }

  /** Whether I move on my own (held keys) or the server steers me: either recentres the camera. */
  get steering() {
    return !!(this.dx || this.dy || this.guided);
  }

  setDirection(dx: number, dy: number) {
    if (dx || dy) { this.guided = false; this.dest = null; }
    if (dx === this.dx && dy === this.dy) return;
    this.advance(performance.now()); // the old direction holds until this very moment, as on the server
    this.dx = dx;
    this.dy = dy;
    if (dx < 0) this.mdir = 1;
    else if (dx > 0) this.mdir = 2;
    else if (dy < 0) this.mdir = 3;
    else if (dy > 0) this.mdir = 0;
    this.sendDir();
  }

  private sendDir() {
    this.advance(performance.now());
    this.hooks.sendInput(this.self.record(), this.dx, this.dy, this.running);
    this.lastBeat = performance.now();
  }

  // ---- running ----
  /** Shift inverts "always run", so either habit works. */
  get running() {
    return this.runHeld !== this.runToggle;
  }
  /** Whether my avatar goes at run speed now, as the server moves it. */
  get fast() {
    return this.running || (this.guided && this.guidedRun);
  }
  setRunHeld(on: boolean) {
    if (on === this.runHeld) return;
    this.advance(performance.now());
    const was = this.running;
    this.runHeld = on;
    if (was !== this.running) this.runChanged();
  }
  toggleRun(on = !this.runToggle) {
    if (on === this.runToggle) return;
    this.advance(performance.now());
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

  /** The server steers me (a walk-to when run, else following a person) or stopped steering; the caller
   *  then drops the held keys, or hands control back to them. */
  setGuided(on: boolean, run: boolean) {
    this.advance(performance.now()); // the old pace holds until this very moment
    this.guided = on;
    this.guidedRun = on && run;
    if (on) return;
    this.dest = null;
    this.dx = this.dy = 0;
  }

  /** Hello: I am at (x, y) in an office walking at `speed`; the signboard names where I arrive. */
  setMe(x: number, y: number, speed: number, runMul: number) {
    this.ctx.cam.panX = this.ctx.cam.panY = 0;
    this.self.reset(x, y);
    this.speed = speed;
    this.runMul = runMul;
    const where = this.where;
    where.area = this.areaIndex(x, y);
    this.hooks.onArea(this.areaName(where.area), where.area);
    where.shown = shownArea(this.ctx.shownOf, where.area);
    if (where.shown >= 0) this.banner(this.areaName(where.area));
  }

  /** Put somewhere by the server (a portal, a desk); the caller drops the held keys. */
  teleport(x: number, y: number) {
    this.ctx.cam.panX = this.ctx.cam.panY = 0;
    this.self.reset(x, y);
    this.dx = this.dy = 0;
    this.where.area = this.areaIndex(x, y);
    this.hooks.onArea(this.areaName(this.where.area), this.where.area);
  }

  /** My position from the server: a teleport (true: the caller drops the held keys) or a steered step. */
  applySelf(m: SelfPosition): boolean {
    this.mdir = m.d;
    if (m.tp) {
      this.self.restart(performance.now());
      this.teleport(m.x, m.y);
      return true;
    }
    // a server-steered walk: my avatar runs on between these 15 Hz positions (advance), and the
    // gap to each one fades in instead of jumping there, so it moves smoothly and its followers too
    this.advance(performance.now());
    if (this.guided) this.guidedRun = m.r; // a follower runs while the person it follows runs
    this.self.correct(m.x, m.y);
    this.dx = m.dx;
    this.dy = m.dy;
    this.where.area = this.areaIndex(m.x, m.y);
    this.hooks.onArea(this.areaName(this.where.area), this.where.area);
    return false;
  }

  /** Server reconciliation (motion.ts, LocalMotion.ack). */
  ack(s: number, x: number, y: number) {
    if (this.self.ack(s, x, y)) this.syncArea();
  }

  /** A new map may put a room under me (a desk just taken) or move area indexes: recount where I stand,
   *  as the server does on a reload. */
  recount() {
    const where = this.where;
    where.area = this.areaIndex(this.self.x, this.self.y);
    this.hooks.onArea(this.areaName(where.area), where.area);
    where.shown = shownArea(this.ctx.shownOf, where.area);
  }

  /** Names changed: tell the area I am in again. */
  tellArea() {
    this.hooks.onArea(this.areaName(this.where.area), this.where.area);
  }

  // ---- movement / collision (mirrors the server) ----
  private areaIndex(x: number, y: number) {
    return this.ctx.map ? areaIndex(this.ctx.grid, x, y) : -1;
  }

  /** Integrates my own movement up to now (frames, and every input at the moment it is sent). */
  advance(now: number) {
    const v = this.speed * (this.fast ? this.runMul : 1);
    if (this.self.advance(now, this.ctx.map ? this.ctx.grid : null, this.dx, this.dy, v, this.where.area)) this.syncArea();
  }

  private areaName(ai: number) {
    const i = shownArea(this.ctx.shownOf, ai);
    return this.ctx.map && i >= 0 ? areaTitle(this.ctx.map.areas[i], this.ctx.nameOf) : "";
  }

  private syncArea() {
    if (!this.ctx.map) return;
    const ai = this.areaIndex(this.self.x, this.self.y);
    const change = this.where.enter(ai, this.ctx.shownOf);
    if (change === SAME) return;
    this.hooks.onArea(this.areaName(ai), ai);
    // a desk room is part of the desks around it: no banner walking in or out of one
    if (change === SHOWN && this.where.shown >= 0) this.banner(this.areaName(ai));
  }
}
