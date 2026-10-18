// Social banner (site/assets/banner.png, 1280x640, the site's og:image) from a REAL in-game scene.
//
//   cd e2e && CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe" node banner.mjs
//
// It builds the client and the server (SKIP_BUILD=1 skips that), starts its own server on
// HQ_BANNER_PORT (default 38090) with a fresh database in the OS temp dir, and no media: LiveKit
// points at a closed port and nobody gives consent, so no camera or microphone is ever used.
// An administrator assigns desks to named people, nine players with varied looks and pets take
// their places (two talking at a desk, others at their desks, two walking down the aisle), and
// an observer outside the frame captures the world only (UI, area labels and banners hidden) at
// an integer scale (3x). The banner sets the wordmark on a solid navy panel beside that crop, 1:1.
// BANNER_SCENE=<path> keeps the crop (default: the temp dir), BANNER_OUT=<path> writes the banner
// elsewhere, BANNER_WALK_MS sets how long the two walkers walk before the shot. Nothing else in
// site/assets is touched.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const root = path.resolve(import.meta.dirname, "..");
const A = path.join(root, "site/assets");
const PORT = process.env.HQ_BANNER_PORT ?? "38090";
process.env.HQ_APP = process.env.HQ_API = `http://127.0.0.1:${PORT}`;
const { launch, joinAs, walkTo, sleep, waitFor } = await import("./lib.mjs");

const WIN = process.platform === "win32";
const BIN = path.join(root, "bin", WIN ? "homequarters.exe" : "homequarters");
const portOpen = (p) => new Promise((res) => { const s = net.connect(p, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });

if (await portOpen(Number(PORT))) { console.log(`# port ${PORT} is busy: set HQ_BANNER_PORT`); process.exit(1); }
if (!process.env.SKIP_BUILD) {
  console.log("# building web + server");
  execFileSync("pnpm", ["build"], { cwd: path.join(root, "web"), stdio: "inherit", shell: WIN });
  execFileSync("go", ["build", "-o", BIN, "./cmd/homequarters"], { cwd: path.join(root, "server"), stdio: "inherit" });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "homequarters-banner-"));
const log = fs.openSync(path.join(dir, "server.log"), "a");
const server = spawn(BIN, [], {
  env: { ...process.env, HQ_ENV: "dev", HQ_ADDR: `127.0.0.1:${PORT}`, HQ_DB: path.join(dir, "banner.db"), HQ_STATIC_DIR: path.join(root, "web/dist"),
    HQ_ALLOWED_ORIGINS: `127.0.0.1:${PORT}`, HQ_JOIN_RATE: "5000",
    // no media in this scene: a closed port, so this server never talks to (or reconciles) a real SFU
    LIVEKIT_URL: "ws://127.0.0.1:1", LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret",
    ...(WIN ? { HQ_STOP_ON_STDIN_CLOSE: "1" } : {}) },
  stdio: [WIN ? "pipe" : "ignore", log, log],
});
const stopServer = async () => {
  const done = new Promise((r) => server.once("exit", r));
  if (WIN) server.stdin.end(); else server.kill("SIGTERM");
  const t = setTimeout(() => server.kill("SIGKILL"), 15000);
  await done;
  clearTimeout(t);
};
for (let i = 0; i < 100 && !(await portOpen(Number(PORT))); i++) await sleep(100);

const T = 16;
const px = (t, o = 8) => t * T + o;
// Desks of the default office: tops at x = 20, 24, 28, 32, 36, 40 and y = 3 and 9; the chair is the tile below.
// look: sk skin, hs hair style, hc hair colour, sh shirt, pa trousers, bd beard, ht hat, hk hat colour, pt pet
// (indexes into web/src/game/palette.ts, art/look.ts and art/pets.ts)
const CAST = [
  // at their own desks
  { n: "Kenji", av: { sk: 1, hs: 3, hc: 8, sh: 5, pa: 0, ht: 3, hk: 8 }, desk: [20, 3], at: [px(20), px(4, 14)], face: [0, -1] },
  { n: "Theo", av: { sk: 0, hs: 9, hc: 5, sh: 6, pa: 7, bd: 4, ht: 5, hk: 20, pt: 1 }, desk: [28, 3], at: [px(29), px(5, 6)], face: [0, 1] },
  { n: "Rosa", av: { sk: 5, hs: 8, hc: 0, sh: 9, pa: 0, ht: 6, hk: 14, pt: 3 }, desk: [32, 3], at: [px(33), px(5, 2)], face: [0, 1] },
  { n: "Omar", av: { sk: 4, hs: 0, hc: 5, sh: 12, pa: 6, bd: 5, ht: 2, hk: 23 }, desk: [20, 9], at: [px(21), px(11, 2)], face: [0, 1] },
  { n: "Jules", av: { sk: 10, hs: 7, hc: 9, sh: 4, pa: 1, bd: 1, ht: 8, hk: 9, pt: 7 }, desk: [28, 9], at: [px(29), px(11, 2)], face: [0, 1] },
  // two talking at Amira's desk
  { n: "Amira", av: { sk: 3, hs: 1, hc: 0, sh: 22, pa: 0, ht: 9, hk: 16 }, desk: [24, 3], at: [px(24, 5), px(5, 4)], face: [1, 0] },
  { n: "Lucas", av: { sk: 6, hs: 0, hc: 3, sh: 3, pa: 1, bd: 3 }, at: [px(25, 13), px(5, 4)], face: [-1, 0] },
  // walking down the aisle with their pets
  { n: "Bruno", av: { sk: 9, hs: 2, hc: 8, sh: 0, pa: 0, bd: 2, ht: 7, hk: 1, pt: 2 }, at: [px(33, 12), px(7)], walk: [-1, 0] },
  { n: "Mei", av: { sk: 7, hs: 11, hc: 8, sh: 7, pa: 1, ht: 1, hk: 6, pt: 4 }, at: [px(19, 8), px(12, 10)], walk: [1, 0] },
];
// the world rectangle shown (in world px), captured at scale S
const VIEW = { x: px(19, 0), y: px(0, 12), w: 256, h: 640 / 3 };
const SCENE_W = VIEW.w * 3, SCENE_H = 640;

const browser = await launch();
let ok = false;
try {
  // the first member of an office is its administrator
  const r = await fetch(process.env.HQ_API + "/api/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Admin", avatar: { sk: 2, hs: 2, hc: 0, sh: 6, pa: 0 } }) });
  const admin = "hq_session=" + r.headers.get("set-cookie").split(";")[0].split("=")[1];

  const cam = await joinAs(browser, "Camera", { avatar: { sk: 0, hs: 0, hc: 0, sh: 7, pa: 0 } });
  const users = [];
  for (const c of CAST) users.push({ ...c, u: await joinAs(browser, c.n, { avatar: c.av, viewport: { width: 480, height: 320 } }) });

  // the administrator gives desks to named people (the same map the editor saves)
  const map = await (await fetch(process.env.HQ_API + "/api/admin/map", { headers: { Cookie: admin } })).json();
  for (const c of users.filter((c) => c.desk)) {
    const d = map.props.find((p) => p.t === "desk" && p.x === c.desk[0] && p.y === c.desk[1]);
    d.assign = c.u.id;
    d.label = c.n;
  }
  const put = await fetch(process.env.HQ_API + "/api/map", { method: "PUT", headers: { Cookie: admin, "Content-Type": "application/json" }, body: JSON.stringify(map) });
  if (!put.ok) throw new Error("map: " + (await put.text()));
  await waitFor(() => cam.page.evaluate((n) => window.__hq.view.map.props.filter((p) => p.t === "desk" && p.assign).length === n, users.filter((c) => c.desk).length), { what: "desks assigned" });

  // the observer stands in the social area below the frame and looks at the desks
  await walkTo(cam, px(27), px(18));
  await cam.page.evaluate(() => {
    const st = document.createElement("style");
    st.textContent = "body *{visibility:hidden!important}"; // the world only: every other element, avatar previews included
    document.head.append(st);
    window.__hq.view.app.canvas.style.setProperty("visibility", "visible", "important");
  });

  await Promise.all(users.map((c) => walkTo(c.u, ...c.at)));
  for (const c of users.filter((c) => c.face)) {
    // turn on the spot: a direction held for one frame only
    await c.u.page.evaluate(([dx, dy]) => new Promise((res) => {
      window.__hq.view.setDirection(dx, dy);
      requestAnimationFrame(() => { window.__hq.view.setDirection(0, 0); res(); });
    }), c.face);
  }
  await sleep(1500); // pets settle beside their owners

  const shoot = async (file) => {
    const g = await cam.page.evaluate((V) => {
      const v = window.__hq.view;
      v.areaLabels.forEach((l) => (l.text.alpha = 0));
      v.banner.alpha = 0;
      // desk labels name the people at their desks; only the two passing by keep their name tags
      for (const [id, e] of v.ents) e.label.alpha = V.named.includes(id) ? 1 : 0;
      const me = v.position();
      v.panX = V.x + V.w / 2 - me.x;
      v.panY = V.y + V.h / 2 - me.y;
      v.dirty = true;
      return { S: v.S };
    }, { ...VIEW, named: users.filter((c) => c.walk).map((c) => c.u.id) });
    if (g.S !== 3) throw new Error("expected scale 3, got " + g.S);
    await sleep(300);
    const { camX, camY } = await cam.page.evaluate(() => ({ camX: window.__hq.view.camX, camY: window.__hq.view.camY }));
    await cam.page.screenshot({ path: file, clip: { x: camX + VIEW.x * 3, y: camY + VIEW.y * 3, width: SCENE_W, height: SCENE_H } });
  };

  // the two in the aisle walk towards each other; the shot is taken mid-stride, pets trailing
  const walkers = users.filter((c) => c.walk);
  await Promise.all(walkers.map((c) => c.u.page.evaluate(([dx, dy]) => window.__hq.view.setDirection(dx, dy), c.walk)));
  await sleep(Number(process.env.BANNER_WALK_MS ?? 900));
  const scene = process.env.BANNER_SCENE ?? path.join(dir, "scene.png");
  await shoot(scene);
  await Promise.all(walkers.map((c) => c.u.page.evaluate(() => window.__hq.view.setDirection(0, 0))));
  console.log("# scene:", scene);

  // ---- compose the banner: wordmark on a solid navy panel, the live office beside it
  const font = fs.readFileSync(path.join(A, "schibsted-grotesk-latin-800-normal.woff2")).toString("base64");
  const img = fs.readFileSync(scene).toString("base64");
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 640 });
  await page.setContent(`<!doctype html>
<style>
  @font-face { font-family: "Schibsted Grotesk"; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 800; }
  body { margin: 0; width: 1280px; height: 640px; display: flex; background: #241f42; overflow: hidden; }
  .panel { width: ${1280 - SCENE_W}px; box-sizing: border-box; padding: 0 48px; display: flex; flex-direction: column; justify-content: center; color: #dcf3ec; }
  .mark { font-family: "Schibsted Grotesk"; font-weight: 800; font-size: 96px; letter-spacing: -0.02em; line-height: 0.9; }
  .sub { font-family: "Schibsted Grotesk"; font-weight: 800; font-size: 30px; letter-spacing: -0.01em; line-height: 1.15; margin-top: 36px; }
  img { width: ${SCENE_W}px; height: ${SCENE_H}px; image-rendering: pixelated; display: block; }
</style>
<div class="panel"><div class="mark">Home<br>Quarters</div><div class="sub">The open source virtual office you host yourself</div></div>
<img src="data:image/png;base64,${img}">`);
  await page.evaluate(() => document.fonts.ready);
  await sleep(200);
  const out = process.env.BANNER_OUT ?? path.join(A, "banner.png");
  await page.screenshot({ path: out });
  console.log("# banner:", out);
  ok = true;
} finally {
  await browser.close();
  await stopServer();
  console.log("# server logs:", path.join(dir, "server.log"));
}
process.exit(ok ? 0 : 1);
