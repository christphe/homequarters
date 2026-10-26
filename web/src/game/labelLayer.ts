// Names on the map: area names, desk owners, and the location signboard that slides in from the top when
// entering an area. Texts sit in the screen-pixel hud and follow the camera every frame.
import { BitmapText, Container, Graphics } from "pixi.js";
import type { MapData, Prop } from "../net/protocol";
import { deskRoom } from "./areas";
import { areaTitle, deskTitle } from "./places";
import { BANNER_STYLE, DESK_STYLE, TAG_STYLE } from "./mapText";
import type { Layer, ViewContext } from "./layer";

const T = 16;

export class LabelLayer implements Layer {
  private ctx!: ViewContext;
  areaLabels: { text: BitmapText; ai: number }[] = [];
  deskLabels: { text: BitmapText; x: number; y: number; p: Prop; ai: number }[] = [];
  banner = new Container();
  private bannerG = new Graphics();
  private bannerText: BitmapText | null = null;
  private bannerT0 = -1e9;
  private bannerW = 0;

  init(ctx: ViewContext) {
    this.ctx = ctx;
    this.bannerText = new BitmapText({ text: "", style: BANNER_STYLE });
    this.banner.addChild(this.bannerG, this.bannerText);
    this.banner.visible = false;
    ctx.hud.addChild(this.banner);
  }

  onMap(map: MapData) {
    const hud = this.ctx.hud;
    this.areaLabels.forEach((l) => l.text.destroy());
    // desk rooms (derived from assigned desks, "auto") are named after the area under them
    this.areaLabels = map.areas.flatMap((a, ai) => {
      if (a.auto) return []; // the desk's own label already names it
      const text = new BitmapText({ text: this.areaLabel(ai), style: TAG_STYLE });
      text.anchor.set(0.5, 0);
      text.alpha = 0.85;
      hud.addChild(text);
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
        hud.addChild(text);
        // over the middle of the desk, whatever its width; the bottom desk of an island (another desk
        // right above it) is labelled under its seat, where the sitter's own name tag does not reach
        const back = map.props.some((q) => q.t === "desk" && q.up && q.y === p.y - 1 && q.x === p.x);
        return { text, x: (p.x + (p.w ?? 2) / 2) * T, y: back ? (p.y + 2) * T + 10 : p.y * T, p, ai };
      });
  }

  /** Names changed (owners, people online, rooms locked against me): every label shows the current text. */
  relabel() {
    for (const l of this.areaLabels) {
      const s = this.areaLabel(l.ai);
      if (l.text.text !== s) l.text.text = s;
    }
    for (const l of this.deskLabels) {
      const s = this.deskLabel(l.p, l.ai);
      if (l.text.text !== s) l.text.text = s;
    }
  }

  /** The text of every desk and area label on the map, as drawn. */
  labels() {
    return [...this.areaLabels, ...this.deskLabels].map((l) => l.text.text);
  }

  private areaLabel(ai: number) {
    return areaTitle(this.ctx.map!.areas[ai], this.ctx.nameOf) + (this.ctx.grid.deny.has(ai) ? " 🔒" : "");
  }

  private deskLabel(p: Prop, ai: number) {
    return deskTitle(p, this.ctx.nameOf) + (this.ctx.grid.deny.has(ai) ? " 🔒" : ""); // a desk locked against me
  }

  /** Location signboard that slides in from the top when entering an area (handheld-RPG style). */
  showBanner(name: string) {
    this.ctx.dirty = true;
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

  /** Labels follow the camera (a camera move is already a change); the banner animates while shown. */
  update(_dt: number, now: number): boolean {
    const map = this.ctx.map!, cam = this.ctx.cam, S = cam.S;
    const { width: W, height: H } = this.ctx.app.screen;
    for (const l of this.areaLabels) {
      const a = map.areas[l.ai];
      const sx = (a.x + a.w / 2) * T * S + cam.x;
      const sy = (a.y + 0.2) * T * S + cam.y;
      l.text.visible = sx > -100 && sx < W + 100 && sy > -20 && sy < H;
      l.text.position.set(Math.round(sx), Math.round(sy));
    }
    for (const l of this.deskLabels) {
      const sx = l.x * S + cam.x;
      const sy = l.y * S + cam.y;
      l.text.visible = S >= 3 && sx > -60 && sx < W + 60 && sy > 0 && sy < H + 20;
      l.text.position.set(Math.round(sx), Math.round(sy));
    }
    // location signboard animation: slide in, hold, slide out
    const t = now - this.bannerT0;
    const h = 38, total = 2600, slide = 260;
    if (t < 0 || t > total) this.banner.visible = false;
    else {
      const k = t < slide ? t / slide : t > total - slide ? (total - t) / slide : 1;
      const e = 1 - (1 - k) * (1 - k);
      this.banner.visible = true;
      this.banner.position.set(Math.round((W - this.bannerW) / 2), Math.round(-h + (h + 60) * e));
    }
    return this.banner.visible; // it redraws on its own every frame while shown
  }

  /** The stage's children go with the application. */
  destroy() {}
}
