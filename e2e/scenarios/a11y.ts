// Accessibility: automated axe-core audit (WCAG 2.1 A and AA rules plus axe best practices) of the rendered screens,
// and keyboard checks (focus trap and Escape in dialogs, tab semantics). This finds a subset of problems; it is not a
// substitute for testing with a screen reader (see docs/status.md).
// The browser audits what only a browser can: colour contrast (real styles, fonts and layout), full screens (the
// world view, the side panel, overlays) and plugin iframes. A dialog, panel or menu whose structure is all axe needs
// is audited in a component test (web/test/*.test.tsx through web/test/axe.ts, in more states than here): the status
// menu, the administration dialog's Invites, Activity and Plugins tabs and a plugin's settings, an object's dialog,
// the whiteboard. Their contrast is covered by the audits kept here, which show the same styles (decision 0037).
import os from "node:os";
import path from "node:path";
import type { Page } from "puppeteer-core";
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, sleep, APP, API, type RunContext } from "../lib.ts";
import { audit, auditView } from "../axe.ts";
import type { MapData } from "../../web/src/net/protocol.ts";

const click = (page: Page, selector: string, text?: string) => page.evaluate((selector, text) => {
  const b = [...document.querySelectorAll<HTMLElement>(selector)].find((x) => (text === undefined ? true : x.textContent.trim() === text));
  b?.click();
  return !!b;
}, selector, text);

export async function run(ctx: RunContext): Promise<boolean> {
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
    const reach: { width: number; height: number; enter: number[]; title: number[]; ok: boolean }[] = [];
    const box = (sel: string) => anon.$eval(sel, (el) => { const x = el.getBoundingClientRect(); return [Math.round(x.top), Math.round(x.bottom)]; });
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
    await p.screenshot({ path: path.join(os.tmpdir(), "homequarters-people-row.png") });
    const fit = await p.evaluate(() => { const ul = document.querySelector(".people")!, b = document.querySelector('.people button[aria-label^="More actions for"]')!.getBoundingClientRect(), u = ul.getBoundingClientRect(); return { sw: ul.scrollWidth, cw: ul.clientWidth, inside: b.right <= u.right + 0.5 }; });
    check("people rows fit the panel: no sideways scroll, the more button fully visible", fit.sw <= fit.cw && fit.inside, JSON.stringify(fit));
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.people button[aria-label^="More actions for"]')!.click());
    await waitFor(() => p.$(".more-menu"), { what: "more actions menu" });
    await audit(p, "a person's more actions menu");
    const onScreen = await p.evaluate(() => { const r = document.querySelector(".more-menu")!.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; });
    check("the more actions menu is entirely on screen", onScreen);
    await p.screenshot({ path: path.join(os.tmpdir(), "homequarters-people-menu.png") });
    await p.keyboard.press("Escape");
    await click(p, ".tabs button[aria-selected]", undefined); // toggles people off
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".tabs button")][1].click());
    await waitFor(() => p.$(".chat"), { what: "chat panel" });
    await audit(p, "the office (chat panel)");
    // (the status menu's audit is web/test/StatusMenu.test.tsx; the more actions menu above has its styles)

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
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Change appearance")?.click());
    await waitFor(() => p.$(".modal.huge"), { what: "appearance dialog" });
    await audit(p, "the appearance dialog");
    const layout = await p.evaluate(() => {
      const opt = document.querySelector(".appearance-options")!.getBoundingClientRect();
      const views = document.querySelector(".appearance-views")!.getBoundingClientRect();
      const act = document.querySelector(".modal.huge .modal-actions")!.getBoundingClientRect();
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
    // (the Invites, Activity and Plugins tabs and a plugin's settings: web/test/AdminDialog.test.tsx and
    // AdminPlugins.test.tsx; the Members tab above has their styles). Pets is turned on through its switch for the
    // side panel and the plugin's modal below.
    await click(p, ".modal [role=tab]", "Plugins");
    await waitFor(() => p.$('.modal tr[data-plugin="hq-pets"]'), { what: "plugins tab" });
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.modal button[aria-label="Turn on Pets"]')?.click());
    await waitFor(() => p.evaluate(() => document.querySelector('.modal tr[data-plugin="hq-pets"]')?.textContent.includes("Running")), { what: "sample plugin running" });
    await p.keyboard.press("Escape");
    await waitFor(async () => !(await p.$(".modal")), { what: "admin closed" });
    await waitFor(() => p.evaluate(() => { const b = document.querySelector<HTMLButtonElement>('.side .tabs button[aria-label="Plugins"]'); b?.click(); return !!b; }), { what: "side panel plugins tab" });
    await waitFor(() => p.$(".plugins-panel button"), { what: "plugin buttons" });
    await audit(p, "the side panel (plugins)");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".plugins-panel button")].find((b) => b.textContent === "Pets")?.click());
    await waitFor(() => p.$(".modal.plugin-modal"), { what: "plugin modal" });
    await audit(p, "a plugin's modal");
    await p.keyboard.press("Escape");
    await waitFor(async () => !(await p.$(".modal")), { what: "plugin modal closed" });
    await fetch(API + "/api/admin/plugins/hq-pets", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify({ enabled: false }) });
    await waitFor(() => p.evaluate(() => !document.querySelector(".plugins-panel")), { what: "plugins panel gone" });

    await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /enable audio/i.test(b.textContent + (b.getAttribute("aria-label") ?? "")))?.click());
    await waitFor(() => p.$(".modal"), { what: "media dialog" });
    await audit(p, "the audio and video consent dialog");
    await p.keyboard.press("Escape");
    await waitFor(async () => !(await p.$(".modal")), { what: "media closed" });

    // (an object's dialog and the whiteboard: web/test/ObjectDialog.test.tsx and WhiteboardDialog.test.tsx; the
    // settings and administration dialogs above have their styles; opening them with X is the `features` scenario)

    // the chess window (bundled hq-chess): a board placed on the social area's table, opened with X; the
    // page and the board view's own document are audited
    const chessOn = (enabled: boolean) => fetch(API + "/api/admin/plugins/hq-chess", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify({ enabled }) });
    const setChessboard = async (on: boolean) => {
      const m = await fetch(API + "/api/admin/map", { headers: { Cookie: "hq_session=" + ctx.adminCookie } }).then(async (r) => (await r.json()) as MapData);
      m.props = m.props.filter((x) => x.t !== "hq-chess/chessboard");
      if (on) m.props.push({ t: "hq-chess/chessboard", x: 13, y: 22, w: 1, h: 1 });
      await fetch(API + "/api/map", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify(m) });
    };
    await chessOn(true);
    await setChessboard(true);
    await walkTo(admin, 13 * 16 + 8, 23 * 16 + 8);
    await waitFor(() => p.evaluate(() => window.__hq.state.nearby?.t === "hq-chess/chessboard"), { what: "nearby chessboard" });
    await p.keyboard.press("x");
    const chessView = await waitFor(async () => (await p.$('.modal.plugin-modal[aria-label="Chess"] iframe.plugin-view[data-view="board"]'))?.contentFrame(), { what: "chess window" });
    await waitFor(() => chessView.evaluate(() => !!document.querySelector("canvas[aria-label]")), { what: "chess board view" });
    await audit(p, "the chess window");
    await auditView(chessView, "the chess board view");
    await p.keyboard.press("Escape");
    await waitFor(async () => !(await p.$(".modal")), { what: "chess closed" });
    await chessOn(false);
    await setChessboard(false);

    // (the Cards window's audit, a dealt free table, is the plugin's: plugins/e2e/hq-cards-e2e/cards.ts)

    // a free desk: its Take button and the confirmation (Escape leaves the desk free)
    // earlier scenarios may have assigned some desks: take the first free one in the desk area
    const free = (await p.evaluate(() => window.__hq.view.map!.props.find((d) => d.t === "desk" && !d.assign && d.y < 14)))!;
    await walkTo(admin, free.x * 16 + 8, (free.y + 1) * 16 + 8);
    await waitFor(() => p.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Take this desk")), { what: "take desk button" });
    await audit(p, "the office with the Take this desk button");
    await click(p, "button", "Take this desk");
    await waitFor(() => p.$(".modal"), { what: "take desk dialog" });
    await audit(p, "the take a desk dialog");
    await p.keyboard.press("Escape");
    await waitFor(async () => !(await p.$(".modal")), { what: "take desk closed" });
    check("Escape closes the take a desk dialog without taking the desk", !(await p.evaluate((x, y) => window.__hq.view.map!.props.find((d) => d.t === "desk" && d.x === x && d.y === y)?.assign, free.x, free.y)));

    await p.evaluate(() => window.__hq.session.setStatus("away"));
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
