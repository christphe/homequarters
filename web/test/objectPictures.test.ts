// Plugin object pictures: one texture per picture frame, shared by every sprite and freed with the plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TextureSource } from "pixi.js";
import { ObjectPictures } from "../src/game/objectPictures.ts";

function fixture() {
  const sources = new Map<string, TextureSource>();
  const loads: string[] = [];
  const pics = new ObjectPictures(async (url) => {
    loads.push(url);
    const s = new TextureSource({ width: 32, height: 16 });
    sources.set(url, s);
    return s;
  });
  return { pics, sources, loads };
}

test("redrawing reuses one texture per frame: the picture's listeners do not grow", async () => {
  const { pics, sources, loads } = fixture();
  const first = await pics.frame("hq-chess", "board.png", [0, 0, 16, 16]);
  assert.ok(first);
  const src = sources.get("/plugins/hq-chess/assets/board.png")!;
  const listeners = src.listenerCount("resize");
  for (let i = 0; i < 50; i++) assert.equal(await pics.frame("hq-chess", "board.png", [0, 0, 16, 16]), first); // 50 redraws
  assert.equal(src.listenerCount("resize"), listeners);
  assert.notEqual(await pics.frame("hq-chess", "board.png", [16, 0, 16, 16]), first); // another frame: its own texture
  assert.deepEqual(loads, ["/plugins/hq-chess/assets/board.png"]); // fetched once
});

test("a frame outside the picture is not drawn; no frame is the whole picture", async () => {
  const { pics } = fixture();
  assert.equal(await pics.frame("hq-chess", "board.png", [24, 0, 16, 16]), null);
  const whole = await pics.frame("hq-chess", "board.png");
  assert.deepEqual([whole?.frame.width, whole?.frame.height], [32, 16]);
});

test("a plugin leaving frees its frame textures, then its picture", async () => {
  const { pics, sources } = fixture();
  const chess = await pics.frame("hq-chess", "board.png", [0, 0, 16, 16]);
  const pet = await pics.frame("hq-pets", "cat.png", [0, 0, 16, 16]);
  pics.keepOnly(new Set(["hq-pets"]));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(chess?.destroyed, true);
  assert.equal(sources.get("/plugins/hq-chess/assets/board.png")!.destroyed, true);
  assert.equal(pet?.destroyed, false);
  // back on: loaded afresh
  const again = await pics.frame("hq-chess", "board.png", [0, 0, 16, 16]);
  assert.ok(again && again !== chess && !again.destroyed);
});

test("a picture that fails to load gives null", async () => {
  const pics = new ObjectPictures(async () => { throw new Error("404"); });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await pics.frame("hq-chess", "missing.png", [0, 0, 16, 16]), null);
  } finally {
    console.warn = warn;
  }
});
