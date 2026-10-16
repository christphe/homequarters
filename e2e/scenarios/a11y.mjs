// Accessibility: automated axe-core audit (WCAG 2.1 A and AA rules plus axe best practices) of every screen and dialog,
// and keyboard checks (focus trap and Escape in dialogs, tab semantics). This finds a subset of problems; it is not a
// substitute for testing with a screen reader (see docs/status.md).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, sleep, APP } from "../lib.mjs";

const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

async function audit(page, label, context) {
  await page.evaluate(AXE);
  const res = await page.evaluate(async (tags, ctx) => {
    const r = await window.axe.run(ctx ?? document, { runOnly: { type: "tag", values: tags } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ") + " :: " + (n.failureSummary ?? "").split("\n").slice(1, 3).join(" ").slice(0, 200)), count: v.nodes.length }));
  }, TAGS, context ?? null);
  for (const v of res) console.log("  axe", v.impact, v.id, "x" + v.count, "-", v.help, "\n     ", v.nodes.join("\n      "));
  check("axe: no WCAG A/AA or best-practice violations on " + label, res.length === 0, res.map((v) => v.id).join(","));
}

const click = (page, selector, text) => page.evaluate((selector, text) => {
  const b = [...document.querySelectorAll(selector)].find((x) => (text === undefined ? true : x.textContent.trim() === text));
  b?.click();
  return !!b;
}, selector, text);

export async function run(ctx) {
  resetChecks();
  const browser = await launch();
  try {
    const t = String(Date.now() % 10000);
    // ---- join screen (fresh visitor, nobody logged in)
    const anon = await (await browser.createBrowserContext()).newPage();
    await anon.setViewport({ width: 1280, height: 720 });
    await anon.goto(APP, { waitUntil: "domcontentloaded" });
    await anon.waitForSelector(".join-card");
    await audit(anon, "the join screen");
    check("the page declares its language", (await anon.evaluate(() => document.documentElement.lang)) === "en");
    // the avatar editor makes the join card taller than the screen: the wheel must bring Enter into view,
    // and back up the title must not be cut off (a centred card that overflows loses its top)
    const reach = [];
    const box = (sel) => anon.$eval(sel, (el) => { const x = el.getBoundingClientRect(); return [Math.round(x.top), Math.round(x.bottom)]; });
    for (const [width, height] of [[1280, 720], [800, 450], [390, 844]]) {
      await anon.setViewport({ width, height });
      await anon.reload({ waitUntil: "domcontentloaded" });
      await anon.waitForSelector(".join-card button.primary");
      await anon.mouse.move(width / 2, height / 2);
      for (let i = 0; i < 30; i++) await anon.mouse.wheel({ deltaY: 120 });
      await sleep(300);
      const enter = await box(".join-card button.primary");
      for (let i = 0; i < 30; i++) await anon.mouse.wheel({ deltaY: -120 });
      await sleep(300);
      const title = await box(".join-card h1");
      reach.push({ width, height, enter, title, ok: enter[0] >= 0 && enter[1] <= height && title[0] >= 0 && title[1] <= height });
    }
    check("the wheel brings the join screen's Enter into view and back up to its title (1280x720, 800x450, 390x844)", reach.every((r) => r.ok), JSON.stringify(reach));

    // ---- office
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    const other = await joinAs(browser, "Zoe" + t);
    const p = admin.page;
    await sleep(500);
    await audit(p, "the office (people panel)");
    await waitFor(() => p.$('.people button[aria-label^="More actions for"]'), { what: "more actions button" });
    await p.screenshot({ path: path.join(os.tmpdir(), "tilework-people-row.png") });
    const fit = await p.evaluate(() => { const ul = document.querySelector(".people"), b = document.querySelector('.people button[aria-label^="More actions for"]').getBoundingClientRect(), u = ul.getBoundingClientRect(); return { sw: ul.scrollWidth, cw: ul.clientWidth, inside: b.right <= u.right + 0.5 }; });
    check("people rows fit the panel: no sideways scroll, the more button fully visible", fit.sw <= fit.cw && fit.inside, JSON.stringify(fit));
    await p.evaluate(() => document.querySelector('.people button[aria-label^="More actions for"]').click());
    await waitFor(() => p.$(".more-menu"), { what: "more actions menu" });
    await audit(p, "a person's more actions menu");
    const onScreen = await p.evaluate(() => { const r = document.querySelector(".more-menu").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; });
    check("the more actions menu is entirely on screen", onScreen);
    await p.screenshot({ path: path.join(os.tmpdir(), "tilework-people-menu.png") });
    await p.keyboard.press("Escape");
    await click(p, ".tabs button[aria-selected]", undefined); // toggles people off
    await p.evaluate(() => [...document.querySelectorAll(".tabs button")][1].click());
    await waitFor(() => p.$(".chat"), { what: "chat panel" });
    await audit(p, "the office (chat panel)");
    await p.evaluate(() => document.querySelector(".status-menu button").click());
    await waitFor(() => p.$(".menu"), { what: "status menu" });
    await audit(p, "the status menu");
    await p.keyboard.press("Escape");
    await p.evaluate(() => document.querySelector(".status-menu button[aria-expanded=true]")?.click());

    // ---- dialogs
    await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /settings/i.test(b.getAttribute("aria-label") ?? b.title ?? ""))?.click());
    await waitFor(() => p.$(".modal"), { what: "settings dialog" });
    await audit(p, "the settings dialog");
    const trapped = async () => {
      for (let i = 0; i < 40; i++) {
        await p.keyboard.press("Tab");
        if (!(await p.evaluate(() => !!document.activeElement?.closest(".modal")))) return false;
      }
      return true;
    };
    check("Tab stays inside an open dialog (focus trap)", await trapped());
    // the appearance editor opens over the settings: audited, and Escape closes only the top one
    await p.evaluate(() => [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Change appearance")?.click());
    await waitFor(() => p.$(".modal.huge"), { what: "appearance dialog" });
    await audit(p, "the appearance dialog");
    const layout = await p.evaluate(() => {
      const opt = document.querySelector(".appearance-options").getBoundingClientRect();
      const views = document.querySelector(".appearance-views").getBoundingClientRect();
      const act = document.querySelector(".modal.huge .modal-actions").getBoundingClientRect();
      return { optBottom: Math.round(opt.bottom), viewsBottom: Math.round(views.bottom), actionsTop: Math.round(act.top), vh: innerHeight, w: innerWidth };
    });
    check("the appearance options scroll above the buttons, never under them", layout.optBottom <= layout.actionsTop && layout.viewsBottom <= layout.actionsTop, JSON.stringify(layout));
    await p.keyboard.press("Escape");
    await sleep(200);
    check("Escape closes the appearance dialog and leaves the settings open", !(await p.$(".modal.huge")) && !!(await p.$(".modal")));
    await p.keyboard.press("Escape");
    await waitFor(async () => !(await p.$(".modal")), { what: "dialog closed by Escape" });
    check("Escape closes the dialog", true);

    await click(p, ".topbar button", "Admin");
    await waitFor(() => p.$(".modal .admin-table"), { what: "admin dialog" });
    await audit(p, "the administration dialog (members)");
    await click(p, ".modal [role=tab]", "Invites");
    await waitFor(() => p.$(".modal .admin-form"), { what: "invites tab" });
    await click(p, ".modal .admin-form button", "Create invite link");
    await waitFor(() => p.$(".modal .admin-table"), { what: "invite row" });
    await audit(p, "the administration dialog (invites)");
    await click(p, ".modal [role=tab]", "Activity");
    await waitFor(() => p.$(".modal .audit li"), { what: "activity" });
    await audit(p, "the administration dialog (activity)");
    await p.keyboard.press("Escape");
    await waitFor(async () => !(await p.$(".modal")), { what: "admin closed" });

    await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /enable audio/i.test(b.textContent + (b.getAttribute("aria-label") ?? "")))?.click());
    await waitFor(() => p.$(".modal"), { what: "media dialog" });
    await audit(p, "the audio and video consent dialog");
    await p.keyboard.press("Escape");
    await waitFor(async () => !(await p.$(".modal")), { what: "media closed" });

    await walkTo(admin, 4 * 16 + 8, 6 * 16 + 8);
    await waitFor(() => p.evaluate(() => window.__tilework.state.nearby?.t === "note"), { what: "nearby note" });
    await p.keyboard.press("x");
    await waitFor(() => p.$(".object-note"), { what: "note dialog" });
    await audit(p, "the interactive note dialog");
    await p.keyboard.press("Escape");
    await waitFor(async () => !(await p.$(".modal")), { what: "note closed" });

    await walkTo(admin, 49 * 16 + 8, 16 * 16 + 8);
    await waitFor(() => p.evaluate(() => window.__tilework.state.nearby?.t === "whiteboard"), { what: "nearby whiteboard" });
    await p.keyboard.press("x");
    await waitFor(() => p.$("canvas.whiteboard"), { what: "whiteboard" });
    await audit(p, "the shared whiteboard");
    await p.keyboard.press("Escape");
    await waitFor(async () => !(await p.$("canvas.whiteboard")), { what: "whiteboard closed" });

    // a free desk: its Take button and the confirmation (Escape leaves the desk free)
    // earlier scenarios may have assigned some desks: take the first free one in the desk area
    const free = await p.evaluate(() => window.__tilework.view.map.props.find((d) => d.t === "desk" && !d.assign && d.y < 14));
    await walkTo(admin, free.x * 16 + 8, (free.y + 1) * 16 + 8);
    await waitFor(() => p.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Take this desk")), { what: "take desk button" });
    await audit(p, "the office with the Take this desk button");
    await click(p, "button", "Take this desk");
    await waitFor(() => p.$(".modal"), { what: "take desk dialog" });
    await audit(p, "the take a desk dialog");
    await p.keyboard.press("Escape");
    await waitFor(async () => !(await p.$(".modal")), { what: "take desk closed" });
    check("Escape closes the take a desk dialog without taking the desk", !(await p.evaluate((x, y) => window.__tilework.view.map.props.find((d) => d.t === "desk" && d.x === x && d.y === y)?.assign, free.x, free.y)));

    await p.evaluate(() => window.__tilework.session.setStatus("away"));
    await waitFor(() => p.$(".status-veil"), { what: "away veil" });
    await audit(p, "the away veil");
    await click(p, ".veil-button");
    await waitFor(async () => !(await p.$(".status-veil")), { what: "veil gone" });

    await click(p, ".topbar button", "Edit office");
    await waitFor(() => p.$(".editor"), { what: "editor" });
    await audit(p, "the map editor");

    check("the map has a text label for assistive technology", await p.evaluate(() => !!document.querySelector('.stage[role="application"][aria-label]')));
    check("no page errors during the audit", admin.logs.length === 0 && other.logs.length === 0, [...admin.logs, ...other.logs].join(" | ").slice(0, 200));
    return summary();
  } finally {
    await browser.close();
  }
}
