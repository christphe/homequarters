// UX capture for the critic (not part of the default suite): run "node run.mjs capture-plugin-pet".
// Enables the sample plugin, records the owner walking an L with a built-in pet AND the plugin's
// creature, and writes frames plus one contact sheet to a fresh folder inside $HQ_CAPTURE_DIR
// (default /tmp/hq-capture). Look at the sheet.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { launch, joinAs, walkTo, sleep, waitFor, API } from "../lib.mjs";

const setPlugin = (ctx, enabled) => fetch(API + "/api/admin/plugins/sample-pet", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify({ enabled }) });

export async function run(ctx) {
  const base = process.env.HQ_CAPTURE_DIR ?? "/tmp/hq-capture";
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "plugin-pet-"));
  const browser = await launch();
  try {
    const owner = await joinAs(browser, "Owner", { avatar: { sk: 2, hs: 1, hc: 0, sh: 4, pa: 1, pt: 2 } });
    await setPlugin(ctx, true);
    await waitFor(() => owner.page.evaluate(() => window.__hq.session.plugins?.debug("sample-pet")?.some((c) => c.visible)), { what: "creature" });
    await walkTo(owner, 7 * 16 + 8, 27 * 16 + 8);
    // film from the owner: the camera follows them; hide the HUD so only the world is in frame
    await owner.page.setViewport({ width: 960, height: 600 });
    await owner.page.addStyleTag({ content: ".topbar,.side,.social-controls,.bar,.minimap,.toast,.dock{display:none!important}" });
    await sleep(1500);
    const walk = owner.page.evaluate(async () => {
      const v = window.__hq.view, wait = (ms) => new Promise((r) => setTimeout(r, ms));
      v.setDirection(1, 0); await wait(1200);
      v.setDirection(0, 1); await wait(500);
      v.setDirection(-1, 0); await wait(800);
      v.setDirection(0, 0); await wait(1200);
      v.setDirection(0, 1); await wait(900); // toward the camera, then rest: the pet must not hide behind the owner
      v.setDirection(0, 0);
    });
    for (let i = 0; i < 40; i++) {
      await owner.page.screenshot({ path: path.join(dir, "pet-" + String(i).padStart(2, "0") + ".png"), clip: { x: 300, y: 180, width: 360, height: 240 } });
      await sleep(130);
    }
    await walk;
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "1", "-i", path.join(dir, "pet-%02d.png"), "-vf", "tile=8x5:padding=4:color=white", path.join(dir, "pet-sheet.png")]);
    console.log("capture:", path.join(dir, "pet-sheet.png"));
  } finally {
    await setPlugin(ctx, false);
    await browser.close();
  }
  return true;
}
