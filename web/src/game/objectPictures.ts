import { ImageSource, Rectangle, Texture, type TextureSource } from "pixi.js";

// The pictures of plugin map objects (manifest "objects"): each fetched and decoded once per page,
// and one texture per frame shared by every sprite that shows it. A texture subscribes to its
// picture, so making one per sprite on every redraw (each map change) would pile them up there.

/** Fetches and decodes a picture (nearest scaling, like all the pixel art). */
export type LoadPicture = (url: string) => Promise<TextureSource>;

const loadPicture: LoadPicture = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  const source = new ImageSource({ resource: await createImageBitmap(await r.blob()) });
  source.scaleMode = "nearest";
  return source;
};

interface Picture {
  plugin: string;
  source: Promise<TextureSource | null>;
  /** by frame ("x,y,w,h", "" for the whole picture); null: outside the picture */
  frames: Map<string, Texture | null>;
}

export class ObjectPictures {
  private pics = new Map<string, Picture>();
  private load: LoadPicture;

  constructor(load: LoadPicture = loadPicture) {
    this.load = load;
  }

  /** The texture of a frame of a plugin's picture (whole picture without frame); null if the picture
   *  failed to load, the frame lies outside it, or the plugin left meanwhile. */
  async frame(plugin: string, sprite: string, frame?: [number, number, number, number]): Promise<Texture | null> {
    const url = `/plugins/${plugin}/assets/${sprite}`;
    let pic = this.pics.get(url);
    if (!pic) {
      const source = this.load(url).catch(() => {
        console.warn(`[plugin ${plugin}] object picture ${sprite} could not be loaded`);
        return null;
      });
      this.pics.set(url, (pic = { plugin, source, frames: new Map() }));
    }
    const src = await pic.source;
    if (!src || this.pics.get(url) !== pic) return null;
    const key = frame ? frame.join(",") : "";
    let tex = pic.frames.get(key);
    if (tex === undefined) {
      const [x, y, w, h] = frame ?? [0, 0, src.width, src.height];
      const inside = x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= src.width && y + h <= src.height;
      tex = inside ? new Texture({ source: src, frame: new Rectangle(x, y, w, h) }) : null;
      pic.frames.set(key, tex);
    }
    return tex;
  }

  /** Frees the pictures of every plugin not in the set (their sprites must be gone first). */
  keepOnly(plugins: Set<string>) {
    for (const [url, pic] of this.pics) {
      if (plugins.has(pic.plugin)) continue;
      this.pics.delete(url);
      void pic.source.then((src) => {
        for (const tex of pic.frames.values()) tex?.destroy();
        src?.destroy();
      });
    }
  }
}
