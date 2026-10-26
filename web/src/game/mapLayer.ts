// The office picture: the baked map under everything, and the desks and pcs drawn again over it as
// sprites that sort with the avatars in the entLayer (art/objects.ts). Rebuilt on each map, never touched per frame.
import { Rectangle, Sprite, Texture } from "pixi.js";
import type { MapData } from "../net/protocol";
import { bakeMap } from "./mapArt";
import { depthAtlas } from "./art/objects";
import type { Layer, ViewContext } from "./layer";

export class MapLayer implements Layer {
  private ctx!: ViewContext;
  /** The baked office picture (shared with the minimap, never re-rendered for it). */
  baked: HTMLCanvasElement | null = null;
  sprite: Sprite | null = null;
  /** Desks and pcs drawn again over the bake, sorted with the avatars (art/objects.ts), and their atlas. */
  depthSprites: Sprite[] = [];
  private depthTex: Texture | null = null;

  init(ctx: ViewContext) {
    this.ctx = ctx;
  }

  onMap(map: MapData) {
    this.sprite?.destroy({ texture: true, textureSource: true }); // do not leak a GPU texture per edit
    const tex = bakeMap(this.ctx.app.renderer, map);
    this.baked = tex.source.resource as HTMLCanvasElement;
    this.sprite = new Sprite(tex);
    this.ctx.world.addChildAt(this.sprite, 0);
    this.buildDepth(map);
  }

  /** Nothing moves here: the depth sprites join the sort the avatars already run. */
  update(): boolean {
    return false;
  }

  /** The stage's children go with the application. */
  destroy() {}

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
      this.ctx.entLayer.addChild(spr);
      this.depthSprites.push(spr);
    }
  }

  /** Tests: how many depth sprites stand for desks and for pcs. */
  debugDepth() {
    const n = (t: string) => this.depthSprites.filter((s) => s.label === "depth-" + t).length;
    return { desks: n("desk"), pcs: n("pc") };
  }
}
