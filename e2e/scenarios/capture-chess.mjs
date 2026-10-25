// UX capture for the critic (not part of the default suite): run "node run.mjs capture-chess".
// hq-chess on, a board on the social area's table, Ann (White) and the administrator (Black) seated with
// their windows open, Di standing just north of the table. Writes frames and a contact sheet to a fresh
// folder inside $HQ_CAPTURE_DIR (default /tmp/hq-capture):
//   table-*.png     the board on the table at the office's zoom, Di north of the table, the playing badges
//   emote-*.png     an emote bubble over the black player's badge
//   dark-*.png      the black player on the darkest floor (the Boardroom's plum carpet) with the black badge
//   window.png      the Chess window after two captures (the reserve strips)
//   promotion.png   the promotion choice open on e8
//   sheet.png       the world frames, tiled
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { launch, joinAs, walkTo, sleep, waitFor } from "../lib.mjs";
import { setPlugin, setBoards, board, dragSq, press, button, openWithX, countFrames, MODAL, BOARD } from "./chess.mjs";

const HUD = ".topbar,.side,.social-controls,.bar,.minimap,.toast,.dock{display:none!important}";
// a seated player's window stays open (they are "present", the badge shows) but is hidden from the frame
const NO_MODAL = ".scrim,.modal{visibility:hidden!important}";

export async function run(ctx) {
  const base = process.env.HQ_CAPTURE_DIR ?? "/tmp/hq-capture";
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "chess-"));
  const browser = await launch();
  const shot = (u, name, clip) => u.page.screenshot({ path: path.join(dir, name + ".png"), clip });
  const world = { x: 240, y: 150, width: 480, height: 300 }; // around the member the camera follows (960x600)
  try {
    await setPlugin(ctx, true);
    await setBoards(ctx, [BOARD]);
    const ann = await joinAs(browser, "Ann", { avatar: { sk: 1, hs: 1, hc: 2, sh: 2, pa: 1 } });
    const adm = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    const di = await joinAs(browser, "Di", { avatar: { sk: 2, hs: 0, hc: 4, sh: 3, pa: 1 } });
    ann.flip = false;
    adm.flip = true;
    for (const u of [ann, adm]) await countFrames(u);
    const feet = 23 * 16 + 8;
    await Promise.all([walkTo(ann, 204, feet), walkTo(adm, 228, feet), walkTo(di, BOARD.x * 16 + 8, 20 * 16 + 14)]);
    await openWithX(ann);
    await openWithX(adm);
    await press(ann, "White");
    await waitFor(async () => (await button(adm, "Black"))?.disabled === false, { what: "Black free" });
    await press(adm, "Black");
    await waitFor(async () => (await button(ann, "Black"))?.text?.startsWith("Black: "), { what: "both seated" });

    // the Chess window after two captures: a black pawn and a white pawn in the reserve strips
    await dragSq(ann, "e2", "e4");
    await sleep(300);
    await dragSq(adm, "d7", "d5");
    await sleep(300);
    await dragSq(ann, "e4", "d5");
    await sleep(300);
    await dragSq(adm, "d8", "d5");
    await waitFor(async () => (await board(ann))?.w === "P" && (await board(ann))?.b === "p", { what: "two captures" });
    await sleep(300);
    const box = await (await ann.page.$(MODAL)).boundingBox();
    await ann.page.screenshot({ path: path.join(dir, "window.png"), clip: box });
    await dragSq(ann, "a2", "e8");
    await sleep(300);
    await ann.page.screenshot({ path: path.join(dir, "promotion.png"), clip: box });
    await ann.page.keyboard.press("Escape"); // keeps the pawn (the view has the focus)
    console.log("capture: window", path.join(dir, "window.png"), "and", path.join(dir, "promotion.png"));

    // the world, from Di's page: the board on the table, Di north of it, the two badges
    for (const u of [ann, adm, di]) {
      await u.page.setViewport({ width: 960, height: 600 });
      await u.page.addStyleTag({ content: HUD + (u === di ? "" : NO_MODAL) });
    }
    await sleep(1200);
    for (let i = 0; i < 4; i++) {
      await shot(di, "table-" + i, world);
      await sleep(200);
    }
    // an emote over the black player's badge
    await adm.page.evaluate(() => window.__hq.session.emote(1));
    await sleep(400);
    await shot(di, "emote-0", world);
    await shot(adm, "emote-1", world);
    // the black player on the darkest floor of the map: the Boardroom (plum carpet, administrators only)
    await walkTo(adm, 46 * 16 + 8, 12 * 16 + 8);
    await sleep(1000);
    for (let i = 0; i < 2; i++) {
      await shot(adm, "dark-" + i, world);
      await sleep(200);
    }
    const listed = fs.readdirSync(dir).filter((f) => /^(table|emote|dark)-\d\.png$/.test(f)).sort();
    try {
      const list = path.join(dir, "frames.txt");
      fs.writeFileSync(list, listed.map((f) => `file '${path.join(dir, f).replace(/\\/g, "/")}'`).join("\n"));
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "tile=4x2:padding=4:color=white", "-frames:v", "1", path.join(dir, "sheet.png")]);
      console.log("capture:", path.join(dir, "sheet.png"));
    } catch (e) {
      console.log("capture: frames in", dir, "(no contact sheet:", String(e).slice(0, 120) + ")");
    }
    // leave the board as new (the window is hidden from the frames, so not a mouse click)
    await ann.page.evaluate((sel) => [...document.querySelectorAll(sel + " button")].find((b) => b.textContent === "Reset")?.click(), MODAL);
  } finally {
    await setPlugin(ctx, false).catch(() => {});
    await setBoards(ctx, []).catch(() => {});
    await browser.close();
  }
  return true;
}
