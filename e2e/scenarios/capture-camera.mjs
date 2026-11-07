// UX capture for the critic (not part of the default suite): run "E2E_VIEWPORT=small node run.mjs capture-camera".
// Films the camera and my avatar: a walk (following), the zoom from the farthest to the closest step,
// zoomed out next to the map's west wall (the reach clamp), a mouse drag (pan) and the recentring when
// walking again. Writes frames, a contact sheet (with ffmpeg) and camera.json (scale, camera offset,
// pan and position at each frame) to a fresh folder inside $HQ_CAPTURE_DIR (default /tmp/hq-capture).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { launch, joinAs, walkTo, sleep } from "../lib.mjs";

export async function run() {
  const base = process.env.HQ_CAPTURE_DIR ?? "/tmp/hq-capture";
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "camera-"));
  const browser = await launch();
  const states = [];
  try {
    const u = await joinAs(browser, "Cam", { avatar: { sk: 2, hs: 1, hc: 0, sh: 4, pa: 1 } });
    const page = u.page;
    const view = () => page.evaluate(() => {
      const v = window.__hq.view, p = v.position();
      return { S: v.scale, camX: v.camX, camY: v.camY, pan: v.pan, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
    });
    let n = 0;
    const shot = async (what) => {
      const name = String(n++).padStart(2, "0") + "-" + what + ".png";
      await page.screenshot({ path: path.join(dir, name) });
      states.push({ frame: name, ...(await view()) });
    };
    await walkTo(u, 8 * 16 + 8, 28 * 16 + 8); // the social area
    await sleep(800);
    await shot("start");
    await page.evaluate(() => window.__hq.view.setDirection(1, 0));
    for (let i = 0; i < 4; i++) { await sleep(250); await shot("walk-right"); }
    await page.evaluate(() => window.__hq.view.setDirection(0, -1));
    for (let i = 0; i < 3; i++) { await sleep(250); await shot("walk-up"); }
    await page.evaluate(() => window.__hq.view.setDirection(0, 0));
    await sleep(500);
    await shot("stopped");
    const [lo, hi] = await page.evaluate(() => window.__hq.view.scaleRange());
    const s0 = await page.evaluate(() => window.__hq.view.scale);
    for (let s = lo; s <= hi; s++) {
      await page.evaluate((s) => window.__hq.view.zoomBy(s - window.__hq.view.scale), s);
      await sleep(400);
      await shot("zoom-" + s);
    }
    await page.evaluate((s) => window.__hq.view.zoomBy(s - window.__hq.view.scale), lo);
    await walkTo(u, 1 * 16 + 8, 28 * 16 + 8); // against the west wall, zoomed out
    await sleep(800);
    await shot("west-edge-zoomed-out");
    await page.evaluate((s) => window.__hq.view.zoomBy(s - window.__hq.view.scale), s0);
    await sleep(400);
    await shot("west-edge");
    const c = await page.evaluate(() => { const r = document.querySelector(".stage canvas").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(c.x - i * 20, c.y - i * 8);
    await sleep(300);
    await shot("dragging");
    await page.mouse.up();
    await sleep(300);
    await shot("dragged");
    await page.evaluate(() => window.__hq.view.setDirection(1, 0));
    await sleep(300);
    await page.evaluate(() => window.__hq.view.setDirection(0, 0));
    await sleep(500);
    await shot("recentred");
    fs.writeFileSync(path.join(dir, "camera.json"), JSON.stringify(states, null, 1));
    try {
      const list = fs.readdirSync(dir).filter((f) => /^\d\d-.*\.png$/.test(f)).sort();
      const args = ["-y", "-loglevel", "error"];
      for (const f of list) args.push("-i", path.join(dir, f));
      const cols = 5, rows = Math.ceil(list.length / cols);
      const scaled = list.map((_, i) => `[${i}:v]scale=400:-1[s${i}]`).join(";");
      const inputs = list.map((_, i) => `[s${i}]`).join("");
      const layout = list.map((_, i) => `${(i % cols) * 404}_${Math.floor(i / cols) * 229}`).join("|");
      args.push("-filter_complex", `${scaled};${inputs}xstack=inputs=${list.length}:layout=${layout}:fill=white`, "-frames:v", "1", path.join(dir, "camera-sheet.png"));
      execFileSync("ffmpeg", args);
      console.log("capture:", path.join(dir, "camera-sheet.png"), `(${rows} rows)`);
    } catch {
      console.log("capture: frames in", dir, "(no ffmpeg for the contact sheet)");
    }
    console.log("capture: camera states in", path.join(dir, "camera.json"));
    return true; // a capture has no checks: look at the frames
  } finally {
    await browser.close();
  }
}
