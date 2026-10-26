// Map objects of the running plugins: their sprites (sorted with the avatars in the entLayer), the
// placeholders the map editor shows for objects nobody draws, and the object within reach (X uses it).
import { BitmapText, Graphics, Sprite, Texture, type TextStyle } from "pixi.js";
import type { MapData, PluginObjectSpec, Prop } from "../net/protocol";
import { isPluginProp, propSize } from "./props";
import { nearestUsable, objectsFor } from "./pluginObjects";
import { ObjectPictures } from "./objectPictures";
import { NOTE_STYLE, PLUGIN_NOTE_STYLE } from "./mapText";
import { t } from "../i18n";
import type { Layer, ViewContext } from "./layer";

const T = 16;
const NEARBY_MS = 150; // how often the object within reach is looked for

export class ObjectLayer implements Layer {
  private ctx!: ViewContext;
  /** Map objects of the running plugins, the sprites drawn for them and their pictures (by URL). */
  private specs: PluginObjectSpec[] = [];
  sprites: Sprite[] = [];
  private pictures = new ObjectPictures();
  /** The map editor is open: objects of plugins not running show as dashed placeholders. */
  private editing = false;
  private placeholderG = new Graphics();
  placeholderLabels: { text: BitmapText; x: number; y: number }[] = [];
  /** The usable prop or object within reach of me, and when it was last looked for. */
  nearby: Prop | null = null;
  private nearbyAt = 0;

  /** me: my position (the LocalMotion the view keeps); onNearby: told when the object within reach changes. */
  constructor(private me: { readonly x: number; readonly y: number }, private onNearby: (prop: Prop | null) => void) {}

  init(ctx: ViewContext) {
    this.ctx = ctx;
    ctx.world.addChild(this.placeholderG); // over the entLayer, under the markers
  }

  onMap(_map: MapData) {
    this.draw();
  }

  /** The map editor opened or closed: it shows objects of plugins that are not running. */
  setEditing(on: boolean) {
    if (this.editing === on) return;
    this.editing = on;
    this.draw();
  }

  /** The map objects of the running plugins (PluginManager): drawn on the map, and X uses them. */
  setSpecs(specs: PluginObjectSpec[]) {
    this.specs = specs;
    this.draw();
    this.pictures.keepOnly(new Set(specs.map((s) => s.plugin))); // after their sprites are gone
    this.updateNearby();
  }

  /** Looks for the usable prop or object within reach of me; tells when it changed. */
  updateNearby() {
    const best = nearestUsable(this.ctx.map?.props ?? [], this.specs, this.me.x, this.me.y, 20);
    if (best !== this.nearby) { this.nearby = best; this.onNearby(best); }
  }

  /** Redraws plugin objects (and, in the editor, placeholders for those of plugins not running). */
  private draw() {
    const ctx = this.ctx;
    ctx.dirty = true;
    for (const s of this.sprites) s.destroy(); // their textures are shared (pictures)
    this.sprites = [];
    this.placeholderG.clear();
    for (const l of this.placeholderLabels) l.text.destroy();
    this.placeholderLabels = [];
    if (!ctx.map) return;
    const drawn = objectsFor(ctx.map.props, this.specs);
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
      ctx.entLayer.addChild(spr);
      this.sprites.push(spr);
      void this.pictures.frame(spec.plugin, sprite, spec.frame).then((tex) => {
        if (!tex || spr.destroyed) return;
        spr.texture = tex;
        ctx.dirty = true;
      });
    }
    if (!this.editing) return;
    const label = (text: string, style: TextStyle, p: Prop, w: number, h: number) => {
      const b = new BitmapText({ text, style });
      b.anchor.set(0.5, 0.5);
      ctx.hud.addChild(b);
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
    for (const p of ctx.map.props) {
      if (!isPluginProp(p.t) || shown.has(p)) continue;
      const [w, h] = propSize(p);
      dashedRect(this.placeholderG, p.x * T + 0.5, p.y * T + 0.5, w * T - 1, h * T - 1);
      label(t("editor.pluginMissing", { type: p.t }), NOTE_STYLE, p, w, h);
    }
    this.placeholderG.stroke({ color: 0xffe9a8, width: 1 });
  }

  /** The object within reach, a few times a second; placeholder labels follow the camera (a camera move is
   *  already a change, and the sprites sit still in the entLayer). */
  update(_dt: number, now: number): boolean {
    if (now - this.nearbyAt > NEARBY_MS) { this.nearbyAt = now; this.updateNearby(); }
    const cam = this.ctx.cam, S = cam.S;
    const { width: W, height: H } = this.ctx.app.screen;
    for (const l of this.placeholderLabels) {
      const sx = l.x * S + cam.x;
      const sy = l.y * S + cam.y;
      l.text.visible = sx > -100 && sx < W + 100 && sy > -20 && sy < H + 20;
      l.text.position.set(Math.round(sx), Math.round(sy));
    }
    return false;
  }

  /** The stage's children go with the application. */
  destroy() {}
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
