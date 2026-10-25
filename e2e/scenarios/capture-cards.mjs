// UX capture for the critic (not part of the default suite): run "node run.mjs capture-cards".
// hq-cards and its two games on, a deck on the social area's table, Ann, Bo and the administrator at the
// table. Writes frames to a fresh folder inside $HQ_CAPTURE_DIR (default /tmp/hq-capture):
//   table-*.png       the deck on the table at the office's zoom
//   free.png          the Cards window: a free table dealt to three, a card on the felt, a pile made
//   look.png          looking through the Stock (its cards in a row)
//   free-view.png     the table view alone, as a player sees it while playing
//   phone*.png        the same table on a 390 x 844 phone (the narrow layout), the view and the whole page
//   pick.png          Bo picking from the hand Ann offers him (the view)
//   oldmaid.png       an Old Maid table after the deal
//   lastcard.png      a Last Card table after the deal and a card played
//   sheet.png         the window frames, tiled (with ffmpeg)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { launch, joinAs, walkTo, sleep, waitFor } from "../lib.mjs";
import { setPlugin, setDecks, viewFrame, drawn, handOf, press, modal, openWithX, drag, handAt, pileAt, feltAt, MODAL, DECK } from "./cards.mjs";
import { FREE } from "../../plugins/bundled/hq-cards/public/games.ts";
import { seatSpots } from "../../plugins/bundled/hq-cards/public/layout.ts";

const HUD = ".topbar,.side,.social-controls,.bar,.minimap,.toast,.dock{display:none!important}";
const NO_MODAL = ".scrim,.modal{visibility:hidden!important}";

export async function run(ctx) {
  const base = process.env.HQ_CAPTURE_DIR ?? "/tmp/hq-capture";
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(base, "cards-" + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const browser = await launch();
  const window = async (u, name) => {
    const box = await (await u.page.$(MODAL)).boundingBox();
    await u.page.screenshot({ path: path.join(dir, name + ".png"), clip: box });
  };
  // the table view alone, scrolled into sight (what a player looks at while playing)
  const view = async (u, name) => {
    const el = await u.page.$(MODAL + " iframe.plugin-view");
    await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await sleep(200);
    await el.screenshot({ path: path.join(dir, name + ".png") });
  };
  const viewClick = async (u, p) => {
    const f = await viewFrame(u);
    const box = await (await f.$("canvas")).boundingBox();
    const k = (await drawn(u)).scale;
    await u.page.mouse.click(box.x + p.x * k, box.y + p.y * k);
    await sleep(200);
  };
  const viewButton = async (u, text) => {
    const f = await viewFrame(u);
    for (const h of await f.$$(".bar button")) if ((await h.evaluate((b) => b.textContent.trim())) === text) return h.click();
  };
  const choose = async (title, ...us) => {
    await press(us[0], "Reset");
    await waitFor(async () => (await modal(us[0]))?.buttons.some((b) => b.text === title), { what: title + " offered" });
    await press(us[0], title);
    for (const [i, u] of us.entries()) {
      await waitFor(async () => (await modal(u))?.buttons.some((b) => b.text === "Seat " + (i + 1) && !b.disabled), { timeout: 8000, what: u.name + " seat" });
      await press(u, "Seat " + (i + 1));
      await waitFor(async () => (await drawn(u))?.seat === i, { what: u.name + " seated" });
    }
  };
  try {
    for (const p of ["hq-cards", "hq-card-pouilleux", "hq-card-lastcard"]) await setPlugin(ctx, p, true);
    await setDecks(ctx, [DECK]);
    const ann = await joinAs(browser, "Ann", { avatar: { sk: 1, hs: 1, hc: 2, sh: 2, pa: 1 } });
    const bo = await joinAs(browser, "Bo", { avatar: { sk: 3, hs: 3, hc: 1, sh: 5, pa: 0 } });
    const adm = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    for (const u of [ann, bo, adm]) u.sent = [];
    const feet = 23 * 16 + 8;
    await Promise.all([walkTo(ann, 204, feet), walkTo(bo, 212, feet), walkTo(adm, 220, feet)]);
    for (const u of [ann, bo, adm]) await openWithX(u);

    // the free table: dealt to three, a card on the felt, a pile made
    await waitFor(async () => (await modal(ann))?.buttons.some((b) => b.text === "Free table"), { what: "the choice" });
    await press(ann, "Free table");
    for (const [i, u] of [ann, bo, adm].entries()) {
      await waitFor(async () => (await modal(u))?.buttons.some((b) => b.text === "Seat " + (i + 1) && !b.disabled), { what: u.name + " seat" });
      await press(u, "Seat " + (i + 1));
      await waitFor(async () => (await drawn(u))?.seat === i, { what: u.name + " seated" });
    }
    await press(ann, "Deal");
    await waitFor(async () => (await handOf(ann)).length === 7, { what: "dealt" });
    await drag(ann, await handAt(ann, 0), feltAt(70, 120));
    await waitFor(async () => (await handOf(ann)).length === 6, { what: "a card on the felt" });
    await drag(ann, await handAt(ann, 2), feltAt(110, 120));
    await sleep(500);
    await window(ann, "free");
    await view(ann, "free-view");
    // the same table on a phone (390 x 844): the narrow layout
    await adm.page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await sleep(600);
    if (!(await adm.page.$(MODAL))) await openWithX(adm);
    await waitFor(async () => (await drawn(adm))?.layout === "narrow", { timeout: 5000, what: "the narrow layout" });
    await sleep(400);
    await view(adm, "phone");
    await adm.page.screenshot({ path: path.join(dir, "phone-page.png") });
    await adm.page.setViewport({ width: 1280, height: 720 });
    await sleep(600);
    if (!(await adm.page.$(MODAL))) await openWithX(adm);
    // looking through the Stock
    await viewClick(ann, pileAt(FREE.piles[0].at));
    await viewButton(ann, "Look through Stock");
    await sleep(600);
    await window(ann, "look");
    await viewButton(ann, "Cancel");
    // Bo picks from Ann's hand
    await press(ann, "Offer my hand to Bo");
    await sleep(500);
    const spot = seatSpots(8, 1).find((s) => s.seat === 0);
    await viewClick(bo, spot);
    await sleep(600);
    await view(bo, "pick");
    await viewButton(bo, "Cancel");

    // Old Maid after the deal
    await choose("Old Maid", ann, bo, adm);
    await press(ann, "Deal all");
    await waitFor(async () => (await handOf(ann)).length > 10, { what: "Old Maid dealt" });
    await sleep(500);
    await window(ann, "oldmaid");

    // Last Card after the deal and a card played
    await choose("Last Card", ann, bo, adm);
    await waitFor(async () => (await drawn(ann))?.sheet === "loaded", { what: "Last Card's sheet" });
    await press(ann, "Deal");
    await waitFor(async () => (await handOf(ann)).length === 7, { what: "Last Card dealt" });
    await drag(ann, await handAt(ann, 3), pileAt([190, 90]));
    await sleep(600);
    await window(ann, "lastcard");

    // the deck on the table, from the administrator's page, windows hidden, nobody in front of it
    await Promise.all([walkTo(ann, 176, feet + 40), walkTo(bo, 240, feet + 40), walkTo(adm, 208, feet + 56)]);
    for (const u of [ann, bo, adm]) {
      await u.page.setViewport({ width: 960, height: 600 });
      await u.page.addStyleTag({ content: HUD + NO_MODAL });
    }
    await sleep(1200);
    for (let i = 0; i < 2; i++) {
      await adm.page.screenshot({ path: path.join(dir, "table-" + i + ".png"), clip: { x: 240, y: 150, width: 480, height: 300 } });
      await sleep(200);
    }
    try {
      const list = path.join(dir, "frames.txt");
      const frames = ["free", "look", "pick", "oldmaid", "lastcard"].map((f) => path.join(dir, f + ".png"));
      fs.writeFileSync(list, frames.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "scale=640:-1,tile=2x3:padding=4:color=white", "-frames:v", "1", path.join(dir, "sheet.png")]);
    } catch (e) {
      console.log("capture: no contact sheet:", String(e).slice(0, 120));
    }
    console.log("capture: frames in", dir);
  } finally {
    for (const p of ["hq-card-lastcard", "hq-card-pouilleux", "hq-cards"]) await setPlugin(ctx, p, false).catch(() => {});
    await setDecks(ctx, []).catch(() => {});
    await browser.close();
  }
  return true;
}
