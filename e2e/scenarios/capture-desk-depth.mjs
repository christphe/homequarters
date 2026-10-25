// UX capture for the critic (not part of the default suite): run "node run.mjs capture-desk-depth".
// Somebody walks behind a row of desks of the starter office, stops behind one, then sits on a desk's
// chair; in the Manor, on the chair of a turned desk. Frames go to a fresh folder
// inside $HQ_CAPTURE_DIR (default /tmp/hq-capture). Look at them: the desk and its screen must hide
// whoever is behind, and never whoever is in front. The shared office is put back at the end.
import fs from "node:fs";
import path from "node:path";
import { launch, joinAs, walkTo, sleep, waitFor, API } from "../lib.mjs";

const api = (cookie, method, p, body) => fetch(API + p, { method, headers: { "Content-Type": "application/json", Cookie: "hq_session=" + cookie }, body: body ? JSON.stringify(body) : undefined });
const viewMap = (u) => u.page.evaluate(() => JSON.parse(JSON.stringify(window.__hq.view.map)));
const free = (m, x, y) => x >= 0 && y >= 0 && x < m.w && y < m.h && m.solid[y][x] !== "1" && m.walls[y][x] !== "#";

export async function run(ctx) {
  const base = process.env.HQ_CAPTURE_DIR ?? "/tmp/hq-capture";
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "desk-depth-"));
  const original = await (await api(ctx.adminCookie, "GET", "/api/admin/map")).json();
  const browser = await launch();
  let n = 0;
  try {
    const u = await joinAs(browser, "Walker", { avatar: { sk: 2, hs: 1, hc: 0, sh: 4, pa: 1 } });
    await u.page.setViewport({ width: 960, height: 600 });
    await u.page.addStyleTag({ content: ".topbar,.side,.social-controls,.bar,.minimap,.toast,.dock{display:none!important}" });
    const shot = async (name) => {
      const file = path.join(dir, String(n++).padStart(2, "0") + "-" + name + ".png");
      await u.page.screenshot({ path: file, clip: { x: 300, y: 180, width: 360, height: 240 } });
    };
    const m = await viewMap(u);
    const desk = m.props.find((p) => p.t === "desk" && !p.up && free(m, p.x, p.y - 1) && free(m, p.x + 1, p.y - 1) && free(m, p.x - 1, p.y - 1));
    // along the row behind the desks, then a stop right behind one
    await walkTo(u, (desk.x - 1) * 16 + 8, (desk.y - 1) * 16 + 12);
    await sleep(800);
    const walk = u.page.evaluate(async () => {
      const v = window.__hq.view, wait = (ms) => new Promise((r) => setTimeout(r, ms));
      v.setDirection(1, 0); await wait(900);
      v.setDirection(0, 0);
    });
    for (let i = 0; i < 8; i++) { await shot("behind-walk"); await sleep(110); }
    await walk;
    await walkTo(u, desk.x * 16 + 16, (desk.y - 1) * 16 + 14).catch(() => {});
    await sleep(800);
    await shot("behind-stop");
    await walkTo(u, desk.x * 16 + 8, (desk.y + 1) * 16 + 8).catch(() => {});
    await sleep(800);
    await shot("on-chair-in-front");
    // the Manor: a turned desk's chair, back to back with a desk facing us
    check(await api(ctx.adminCookie, "POST", "/api/admin/map/template", { template: "manor" }));
    await waitFor(async () => (await viewMap(u)).w === 85, { timeout: 20000, what: "the Manor" });
    await waitFor(() => u.page.evaluate(() => window.__hq.state.conn === "open"), { timeout: 20000, what: "back" });
    const manor = await viewMap(u);
    const turned = manor.props.find((p) => p.t === "desk" && p.up && free(manor, p.x + 1, p.y - 1));
    await walkTo(u, (turned.x + 1) * 16 + 8, (turned.y - 1) * 16 + 14).catch(() => {});
    await sleep(800);
    await shot("turned-desk-chair");
    await walkTo(u, (turned.x + 1) * 16 + 8, (turned.y + 2) * 16 + 8).catch(() => {});
    await sleep(800);
    await shot("facing-desk-chair");
    console.log("capture:", dir);
  } finally {
    await browser.close();
    await api(ctx.adminCookie, "POST", "/api/admin/map/template", { template: "loft" });
    await api(ctx.adminCookie, "PUT", "/api/map", original);
  }
  return true;
}

function check(r) {
  if (!r.ok) throw new Error("template switch refused: " + r.status);
}
