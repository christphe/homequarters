// Offline art pipeline: sprite cast and walking GIF, built from the sheets exported by
// export-art.mjs. Needs Chrome + ffmpeg, no running server. The social banner comes from a real
// in-game scene instead: see banner.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";

// Standalone on purpose: no server needed, so it does not depend on lib.mjs.
const launch = () =>
  puppeteer.launch({
    executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-first-run", "--enable-unsafe-swiftshader"],
  });

const A = path.resolve(import.meta.dirname, "../site/assets");
const b64 = (f) => "data:image/png;base64," + fs.readFileSync(path.join(A, f)).toString("base64");
const NAMES = ["marina", "bruno", "carla", "diego", "elisa", "fabio"];
const sheets = Object.fromEntries(NAMES.map((n) => [n, b64(`sheet-${n}.png`)]));

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 640 });
await page.setContent("<body style='margin:0;background:transparent'></body>");

// helper that draws (sheet, dir, frame) with nearest-neighbour scaling
await page.evaluate(() => {
  window.loadImg = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
  window.sprite = (ctx, img, dir, frame, x, y, s) => {
    ctx.imageSmoothingEnabled = false;
    // cells are 18 x 30; rows 4..28 hold a hatless avatar (rows 0..3 are room for hats, row 29 can hold
    // outline pixels bled from the next sheet row), so the cast and GIF keep their framing
    ctx.drawImage(img, frame * 18, dir * 30 + 4, 18, 25, x, y, 18 * s, 25 * s);
  };
});

// ---- cast.png: six idle avatars, transparent ----
const S = 8;
const cast = await page.evaluate(async (sheets, S) => {
  const c = document.createElement("canvas");
  c.width = 6 * (18 * S + 24);
  c.height = 26 * S;
  const ctx = c.getContext("2d");
  let i = 0;
  for (const src of Object.values(sheets)) {
    const img = await window.loadImg(src);
    window.sprite(ctx, img, 0, 0, i * (18 * S + 24) + 12, 0, S);
    i++;
  }
  return c.toDataURL("image/png");
}, sheets, S);
fs.writeFileSync(path.join(A, "cast.png"), Buffer.from(cast.split(",")[1], "base64"));

// ---- walk.gif: 4 directions walking, Marina ----
const frames = fs.mkdtempSync(path.join(os.tmpdir(), "homequarters-walk-"));
const cyc = [1, 0, 2, 0];
const W = 4 * (18 * S + 32) + 32;
for (let f = 0; f < 4; f++) {
  const url = await page.evaluate(async (src, f, cyc, S, W) => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = 26 * S + 48;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#1b1830";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#d8b98a";
    ctx.fillRect(0, c.height - 40, c.width, 40);
    const img = await window.loadImg(src);
    const order = [0, 1, 2, 3]; // down, left, right, up
    order.forEach((d, i) => window.sprite(ctx, img, d, cyc[f], 32 + i * (18 * S + 32), 24, S));
    return c.toDataURL("image/png");
  }, sheets.marina, f, cyc, S, W);
  fs.writeFileSync(path.join(frames, `f${f}.png`), Buffer.from(url.split(",")[1], "base64"));
}
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "6", "-i", path.join(frames, "f%d.png"), "-vf", "split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=none", "-loop", "0", path.join(A, "walk.gif")]);

await browser.close();
console.log("art done");
