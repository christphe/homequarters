// UX capture for the critic (not part of the default suite): run "node run.mjs capture-plugin-pet".
// Enables the pets plugin, records the owner walking an L with three of the plugin's
// pets, and writes frames plus one contact sheet to a fresh folder inside $HQ_CAPTURE_DIR
// (default /tmp/hq-capture). Look at the sheet.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { launch, joinAs, walkTo, sleep, waitFor, API } from "../lib.mjs";

const setPlugin = (ctx, enabled) => fetch(API + "/api/admin/plugins/hq-pets", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify({ enabled }) });

export async function run(ctx) {
  const base = process.env.HQ_CAPTURE_DIR ?? "/tmp/hq-capture";
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "plugin-pet-"));
  const browser = await launch();
  try {
    const owner = await joinAs(browser, "Owner", { avatar: { sk: 2, hs: 1, hc: 0, sh: 4, pa: 1 } });
    await setPlugin(ctx, true);
    // setup through the plugin's own messages (the modal is tested in plugins.mjs): a cat in its own
    // colours, a tinted fox and a seedling
    const frame = await waitFor(() => owner.page.frames().find((f) => f.url() === "about:srcdoc"), { what: "plugin frame" });
    for (const m of [{ t: "add", k: 0 }, { t: "add", k: 3 }, { t: "colour", i: 1, c: "6a5acd" }, { t: "add", k: 8 }]) {
      await frame.evaluate((m) => window.hq.send(m), m);
      await sleep(300);
    }
    await waitFor(() => owner.page.evaluate(() => window.__hq.session.plugins?.debug("hq-pets")?.filter((c) => c.visible).length === 3), { what: "three pets" });
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
    try {
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "1", "-i", path.join(dir, "pet-%02d.png"), "-vf", "tile=8x5:padding=4:color=white", path.join(dir, "pet-sheet.png")]);
      console.log("capture:", path.join(dir, "pet-sheet.png"));
    } catch {
      console.log("capture: frames in", dir, "(no ffmpeg for the contact sheet)");
    }
    // the fox named, the pets let wander, the mouse over the fox: its name and its owner
    await frame.evaluate(() => window.hq.send({ t: "name", i: 1, n: "Foxy" }));
    await sleep(300);
    await frame.evaluate(() => window.hq.send({ t: "mode", m: "wander" }));
    let tag = "";
    for (let i = 0; i < 40 && !tag; i++) {
      const fox = (await owner.page.evaluate(() => window.__hq.session.plugins.debug("hq-pets"))).find((c) => c.key === "t3");
      if (fox) {
        const at = await owner.page.evaluate(({ x, y }) => window.__hq.view.pageOf(x, y - 6), fox);
        await owner.page.mouse.move(at.x, at.y);
        await sleep(120);
        tag = await owner.page.evaluate(() => window.__hq.view.hoverText());
        if (tag) await owner.page.screenshot({ path: path.join(dir, "hover.png"), clip: { x: Math.max(0, at.x - 120), y: Math.max(0, at.y - 110), width: 240, height: 160 } });
      }
      await sleep(250);
    }
    console.log("capture: hover tag", JSON.stringify(tag), path.join(dir, "hover.png"));
    // the modal, as its owner sees it
    await owner.page.addStyleTag({ content: ".side{display:flex!important}" });
    await owner.page.evaluate(() => document.querySelector('.side .tabs button[aria-label="Plugins"]')?.click());
    await waitFor(() => owner.page.evaluate(() => { const b = [...document.querySelectorAll(".plugins-panel button")].find((x) => x.textContent === "Pets"); b?.click(); return !!b; }), { what: "Pets entry" });
    await waitFor(() => owner.page.$(".modal.plugin-modal"), { what: "modal" });
    await sleep(300);
    const box = await (await owner.page.$(".modal.plugin-modal")).boundingBox();
    await owner.page.screenshot({ path: path.join(dir, "modal.png"), clip: box });
    console.log("capture: modal", path.join(dir, "modal.png"));
  } finally {
    await setPlugin(ctx, false);
    await browser.close();
  }
  return true;
}
