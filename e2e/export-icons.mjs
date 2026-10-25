// Writes the installed-app icons (web/public/icons) from the HQ favicon (web/src/assets/favicon.svg).
// Standalone: needs only Chrome. Rerun after changing the favicon; the output is committed.
import { chrome } from "./env.mjs";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const svg = fs.readFileSync(path.join(root, "web/src/assets/favicon.svg"), "utf8");
const OUT = path.join(root, "web/public/icons");
const NAVY = "#241f42";
const glyph = svg.match(/<path[^>]*\/>/)[0];
// The favicon's letters nearly touch its edges, which suits 16 px only: larger icons shrink them into the
// tile. Maskable icons are full-bleed, since the system crops them (to a circle at worst, 80% of the
// side), and iOS rounds the corners of its own.
const tile = (scale, rx) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="${rx}" fill="${NAVY}"/>` +
  `<g transform="translate(8 8) scale(${scale}) translate(-8 -7.9)">${glyph}</g></svg>`;
const icons = [
  ["icon-192.png", tile(0.82, 3), 192],
  ["icon-512.png", tile(0.82, 3), 512],
  ["icon-maskable-512.png", tile(0.7, 0), 512],
  ["apple-touch-icon.png", tile(0.8, 0), 180],
];

const browser = await puppeteer.launch({
  executablePath: chrome(),
  headless: true,
  args: ["--no-first-run"],
});
const page = await browser.newPage();
fs.mkdirSync(OUT, { recursive: true });
for (const [name, source, size] of icons) {
  const url = await page.evaluate(async (source, size) => {
    const img = new Image();
    img.src = "data:image/svg+xml;base64," + btoa(source);
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = size;
    c.getContext("2d").drawImage(img, 0, 0, size, size);
    return c.toDataURL("image/png");
  }, source, size);
  fs.writeFileSync(path.join(OUT, name), Buffer.from(url.split(",")[1], "base64"));
}
await browser.close();
console.log("exported", icons.length, "icons to", OUT);
