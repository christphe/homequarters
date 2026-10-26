// Keyboard and mouse on the map: movement keys and shortcuts, Ctrl+wheel zoom, left-drag to look
// around, double-click to run somewhere, and the mouse position the hover tag reads. Not a layer: it
// draws nothing; it turns DOM events into calls on LocalPlayer, the camera and the view.
import { MOVE_KEYS, codeOf, digitOf, learnKey } from "../keys";
import { DANCE } from "./emotes";
import { isBusyKey, isHomeKey } from "./home";
import type { ViewContext } from "./layer";
import type { LocalPlayer } from "./localPlayer";
import type { ViewHooks } from "./WorldView";

const WHEEL_GAP_MS = 120; // at most one zoom step per this long, so a trackpad or a free-spinning wheel does not race through every level
const DRAG_PX = 4; // a mouse press moving less than this is a click, not a drag

/** What input asks of the view. */
export interface InputHost {
  goTo(tx: number, ty: number): void;
  zoomBy(steps: number): number;
  interact(): void;
  screenToTile(clientX: number, clientY: number): [number, number];
}

export class InputController {
  /** Movement keys held ("l", "r", "u", "d"). */
  readonly keys = new Set<string>();
  private wheelAt = 0;
  drag: { id: number; x: number; y: number; camX: number; camY: number; moved: boolean } | null = null;
  /** The mouse over the map (canvas pixels), for the name of a plugin sprite under it; null elsewhere or for touch. */
  mouse: { x: number; y: number } | null = null;
  private dragEndAt = 0;
  private cleanup: (() => void)[] = [];

  // fields, not parameter properties: node's type stripping (web/test) cannot run those
  private ctx: ViewContext;
  private player: LocalPlayer;
  private hooks: ViewHooks;
  private view: InputHost;

  constructor(ctx: ViewContext, player: LocalPlayer, hooks: ViewHooks, view: InputHost) {
    this.ctx = ctx;
    this.player = player;
    this.hooks = hooks;
    this.view = view;
  }

  /** Listens on the window and the map's canvas (ctx.app exists). */
  init() {
    const app = this.ctx.app;
    const kd = (e: KeyboardEvent) => this.key(e, true);
    const ku = (e: KeyboardEvent) => this.key(e, false);
    const blur = () => { this.releaseKeys(); this.player.setRunHeld(false); this.stopDrag(); };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", blur);
    // Double-click (or double-tap) a spot on the map to run there along a server-computed path.
    const dbl = (e: MouseEvent) => {
      if (document.querySelector(".scrim, .editor") || performance.now() - this.dragEndAt < 500) return; // a drag's click is not a double-click
      const [tx, ty] = this.view.screenToTile(e.clientX, e.clientY);
      const map = this.ctx.map;
      if (!map || tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return;
      this.view.goTo(tx, ty);
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
      this.view.zoomBy(-step);
      const d = this.drag;
      if (d?.moved) {
        // keep dragging from here, at the new scale (the camera is placed on the next frame)
        const { width: W, height: H } = app.screen;
        d.x = e.clientX;
        d.y = e.clientY;
        const self = this.player.self, cam = this.ctx.cam;
        d.camX = W / 2 - (self.x + self.ox + cam.panX) * cam.S;
        d.camY = H / 2 - (self.y + self.oy + cam.panY) * cam.S;
      }
    };
    app.canvas.addEventListener("wheel", wheel, { passive: false });
    // Left-drag with a mouse looks around; a press that moves less than DRAG_PX stays a click, so
    // double-click to run there still works. Touch keeps the browser's own gestures and the pad.
    const pdown = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType !== "mouse" || document.querySelector(".scrim, .editor")) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, camX: this.ctx.cam.x, camY: this.ctx.cam.y, moved: false };
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
    });
  }

  destroy() {
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
  }

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
      this.player.setRunHeld(down);
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
      this.view.interact();
      return;
    }
    if (once && k === "KeyR") {
      e.preventDefault();
      this.player.toggleRun();
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

  releaseKeys() {
    this.keys.clear();
    this.applyKeys();
  }

  /** Walks the way the held keys point (nothing held: stop). */
  applyKeys() {
    const dx = (this.keys.has("r") ? 1 : 0) - (this.keys.has("l") ? 1 : 0);
    const dy = (this.keys.has("d") ? 1 : 0) - (this.keys.has("u") ? 1 : 0);
    this.player.setDirection(dx, dy);
  }

  /** Whether a mouse press is down on the map (a drag, or a click that may become one). */
  get pressed() {
    return this.drag !== null;
  }

  /** Whether the map is being dragged. */
  get dragging() {
    return !!this.drag?.moved;
  }

  /** Moving recentres the camera on me and ends a drag in progress (frame()). */
  dropDrag() {
    if (this.drag?.moved) {
      this.ctx.app.canvas.style.cursor = "";
      document.body.style.userSelect = "";
    }
    this.drag = null;
  }

  /** Puts the camera at this screen offset (the frame keeps it on the map and within reach). */
  private panTo(camX: number, camY: number) {
    const { width: W, height: H } = this.ctx.app.screen;
    const self = this.player.self;
    this.ctx.cam.panTo(camX, camY, W, H, self.x + self.ox, self.y + self.oy);
    this.ctx.dirty = true;
  }

  /** Ends a drag, wherever it is. */
  private stopDrag() {
    if (this.drag?.moved) this.endDrag();
    this.drag = null;
  }

  /** Keeps only the pan the camera could follow, so the next drag starts where the view is. */
  private endDrag() {
    this.ctx.app.canvas.style.cursor = "";
    document.body.style.userSelect = "";
    this.dragEndAt = performance.now();
    this.panTo(this.ctx.cam.x, this.ctx.cam.y);
  }
}
