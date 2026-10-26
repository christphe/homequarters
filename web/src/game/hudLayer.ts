// Markers over the world: the highlighted rectangle (editor), the walk-to destination, the locate pulse
// and its arrow at the screen edge, and the tag naming the plugin sprite under the mouse.
import { BitmapText, Graphics } from "pixi.js";
import { NOTE_STYLE } from "./mapText";
import type { Layer, ViewContext } from "./layer";
import type { LocalPlayer } from "./localPlayer";
import type { InputController } from "./input";
import type { PluginLayer } from "./pluginLayer";

const T = 16;

export class HudLayer implements Layer {
  private ctx!: ViewContext;
  /** Drawn in world px (under the name tags): the hover rectangle, the destination, the locate pulse. */
  private fxG = new Graphics();
  /** Drawn in screen px: the arrow towards a located spot off screen. */
  private hudG = new Graphics();
  /** A plugin sprite's label and its owner's name, shown while the mouse is over the sprite. */
  private hoverTag = new BitmapText({ text: "", style: NOTE_STYLE });
  /** A rectangle of tiles to highlight (the editor), and a spot to point at for a while. */
  hover: { x: number; y: number; w: number; h: number } | null = null;
  locate: { x: number; y: number; until: number } | null = null;

  constructor(private player: LocalPlayer, private input: InputController, private plugins: PluginLayer) {}

  init(ctx: ViewContext) {
    this.ctx = ctx;
    ctx.world.addChild(this.fxG);
    ctx.hud.addChild(this.hudG);
    this.hoverTag.anchor.set(0.5, 1);
    this.hoverTag.visible = false;
    ctx.hud.addChild(this.hoverTag);
  }

  setHover(h: { x: number; y: number; w: number; h: number } | null) {
    this.ctx.dirty = true;
    this.hover = h;
  }

  showLocation(x: number, y: number) {
    this.ctx.dirty = true;
    this.locate = { x, y, until: performance.now() + 5000 };
  }

  /** The hover tag's text ("" while hidden). */
  hoverText(): string {
    return this.hoverTag.visible ? this.hoverTag.text : "";
  }

  /** Redraws the markers; after the plugin layer, so the hover tag finds its sprites where they are drawn. */
  update(_dt: number, now: number): boolean {
    let changed = false;
    const cam = this.ctx.cam, S = cam.S, fx = this.fxG;
    const { width: W, height: H } = this.ctx.app.screen;
    fx.clear();
    if (this.hover) fx.rect(this.hover.x * T, this.hover.y * T, this.hover.w * T, this.hover.h * T).stroke({ color: 0xffb84d, width: 1 }).fill({ color: 0xffb84d, alpha: 0.18 });
    const dest = this.player.dest;
    if (dest) {
      const k = (now % 700) / 700;
      const r = 3 + k * 3;
      fx.poly([dest.x, dest.y - r, dest.x + r, dest.y, dest.x, dest.y + r, dest.x - r, dest.y]).stroke({ color: 0x3cc9b0, width: 1, alpha: 1 - k * 0.6 });
      fx.circle(dest.x, dest.y, 1.5).fill(0x3cc9b0);
    }
    this.hudG.clear();
    if (this.locate) {
      if (now > this.locate.until) { this.locate = null; changed = true; }
      else {
        const pulse = (now % 900) / 900;
        fx.circle(this.locate.x, this.locate.y, 6 + pulse * 14).stroke({ color: 0xffb84d, width: 2, alpha: 1 - pulse });
        const sx = this.locate.x * S + cam.x, sy = this.locate.y * S + cam.y;
        if (sx < 0 || sy < 0 || sx > W || sy > H) {
          const ang = Math.atan2(sy - H / 2, sx - W / 2);
          const ex = Math.max(24, Math.min(W - 24, sx)), ey = Math.max(24, Math.min(H - 24, sy));
          this.hudG.poly([ex + Math.cos(ang) * 14, ey + Math.sin(ang) * 14, ex + Math.cos(ang + 2.5) * 10, ey + Math.sin(ang + 2.5) * 10, ex + Math.cos(ang - 2.5) * 10, ey + Math.sin(ang - 2.5) * 10]).fill(0xffb84d);
        }
      }
    }
    if (this.placeHoverTag()) changed = true;
    // the destination and the locate pulse animate: they redraw on their own every frame
    return changed || !!this.player.dest || !!this.locate;
  }

  /** Shows the label of the plugin sprite under the mouse (and its owner's name), or hides it; true when it changed. */
  private placeHoverTag(): boolean {
    const tag = this.hoverTag, cam = this.ctx.cam;
    const mouse = this.input.mouse;
    const m = !mouse || this.input.dragging || document.querySelector(".scrim") ? null : mouse;
    const hit = m ? this.plugins.labelAt((m.x - cam.x) / cam.S, (m.y - cam.y) / cam.S) : null;
    if (!hit) {
      if (!tag.visible) return false;
      tag.visible = false;
      return true;
    }
    const owner = hit.owner ? this.ctx.people.get(hit.owner)?.n : undefined;
    const text = owner ? hit.text + "\n(" + owner + ")" : hit.text;
    const x = Math.round(cam.x + hit.x * cam.S), y = Math.round(cam.y + hit.top * cam.S - 2);
    if (tag.visible && tag.text === text && tag.x === x && tag.y === y) return false;
    tag.text = text;
    tag.position.set(x, y);
    if (!tag.visible) this.ctx.hud.addChild(tag); // above the name tags added since
    tag.visible = true;
    return true;
  }

  /** The stage's children go with the application. */
  destroy() {}
}
