// The looks of text drawn on the map, shared by every layer that draws text.
import { Cache, TextStyle } from "pixi.js";

// Jersey 10 is drawn on a 10 px grid and has a small x-height: map text uses twice its grid (20 px,
// 30 for the area banner), which stays crisp and reads like the interface.
const FONT = '"Jersey 10", ui-monospace, Menlo, monospace';
// One TextStyle per look, shared by every BitmapText that wears it: Pixi keys a stroked bitmap font
// (its own glyph atlas, never freed) by the TextStyle instance, so a style per label made a font per label.
// Never destroy a text with { style: true } (or destroy(true)): it would break every label sharing the style.
const OUTLINE = { color: 0x1a1526, width: 3 };
export const TAG_STYLE = new TextStyle({ fontFamily: FONT, fontSize: 20, fill: 0xffffff, stroke: OUTLINE });
export const DESK_STYLE = new TextStyle({ fontFamily: FONT, fontSize: 20, fill: 0xffe9a8, stroke: OUTLINE });
export const NOTE_STYLE = new TextStyle({ fontFamily: FONT, fontSize: 18, fill: 0xffe9a8, align: "center", stroke: OUTLINE });
export const PLUGIN_NOTE_STYLE = new TextStyle({ fontFamily: FONT, fontSize: 18, fill: 0x9fe0ff, align: "center", stroke: OUTLINE });
// no outline: on the light plate it only smeared the pixel letters
export const BANNER_STYLE = new TextStyle({ fontFamily: FONT, fontSize: 30, fill: 0x383858 });
/** For tests: how many bitmap fonts Pixi holds (it keeps them in its asset cache under keys holding "-bitmap"). */
export const bitmapFonts = () => [...(Cache as unknown as { _cache: Map<unknown, unknown> })._cache.keys()].filter((k) => typeof k === "string" && k.includes("-bitmap")).length;
