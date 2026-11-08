// Presence through the real controls: Ctrl+wheel zoom and the area of interest it widens, left-drag to look
// around, a wave, a raised hand, a status note, Ctrl+U and the status veil, dancing, the minimap, the shortcuts
// dialog, an administrator's announcement, the touch pad and the computer's idle state.
//
// What stays here, per feature (one check through the real controls at least):
// - zoom: Ctrl+wheel with Chrome's mouse (one notch, out to the limit), the UI keeping its size, and the server
//   then sending the person the wider view shows
// - drag: a left-drag moves the view 1:1; moving with the arrow keys brings it back to me
// - wave: the people panel's Wave at reaches somebody anywhere, the sender is told, the card's Walk to them runs
//   there (which also brings the two together for what follows); H: a raised hand others see; a note typed in the
//   status menu shows in the other's people panel
// - status: Ctrl+U makes me busy for others; the veil's big button makes me available again; Z: a dance others see
// - minimap: the server's head counts reach it; a click on it runs there; its picture fills the canvas across
//   pixel-ratio changes (M twice)
// - shortcuts: ? opens the dialog, Escape closes it; announcement: the admin's Announce form, the banner, dismiss
// - touch pad on a phone; idle: the real setting ticked with the permission granted, an idle computer sets me
//   away for others; no console errors
//
// Where the other checks live now:
// - wheel and drag rules (plain wheel, any notch size and line mode one step, 120 ms gap, click threshold, a press
//   released off the map, double-click after a drag, zoom during a drag, cursor and text selection restored, the
//   pan stopping at the west wall): web/test/gesture.test.ts; the camera at map edges and the largest radius:
//   web/test/camera.test.ts; the server's radius growing and shrinking: world TestViewWidensInterestWithinTheServerCap,
//   TestAOIEnterLeave
// - Wave back, dismissing the card and the hand button: web/test/WaveAndHand.test.tsx; H twice lowers:
//   web/test/hand.test.ts, world TestARaiseAndALowerInOneTickLeaveTheHandDown; the note trimmed and drawn:
//   web/test/StatusNote.test.tsx, world TestRaisedHandAndStatusNoteAreInTheRoster
// - the busy and away veils, Ctrl+U from away: web/test/StatusVeil.test.tsx (busyToggle), web/test/home.test.ts (the key)
// - minimap counts drawn per area, the tile a click picks, M and Shift+M: web/test/Minimap.test.tsx; AZERTY names in the shortcuts:
//   web/test/ShortcutsDialog.test.tsx
// - the announcement reaching everybody: world TestAnnouncementsReachEverybodyConnected
// - Ctrl+D and desks: where Ctrl+D leads, web/test/home.test.ts, with the real keys in e2e/scenarios/offices.ts;
//   Ctrl+D with nothing assigned is homeTile's null there (its toast is not tested); desk locks, world
//   TestADeskOwnerLocksTheirDeskAndAlwaysWalksIn, TestLockingKnockingAndAnswering, the buttons in
//   web/test/doors.test.ts, the lock on the label in web/test/lockLabels.test.ts, a room's real Lock in
//   e2e/scenarios/features.ts, knock and let in in offices.ts
// - idle detection blocked: web/test/SettingsIdle.test.tsx; idle, back and locked: web/test/osIdle.test.ts
import type { ElementHandle } from "puppeteer-core";
import { check, resetChecks, summary, launch, joinAs, waitFor, walkTo, pos, sleep, APP, type RunContext, type User } from "../lib.ts";

// puppeteer cannot check a generic page function against generic arguments: the cast keeps the caller's types
const read = <P extends unknown[], R>(u: User, fn: (...args: P) => R, ...args: P) => u.page.evaluate(fn as never, ...args) as Promise<Awaited<R>>;
const click = (u: User, text: string, selector = "button") => u.page.evaluate((text, selector) => {
  const b = [...document.querySelectorAll<HTMLElement>(selector)].find((x) => x.textContent.trim() === text || x.getAttribute("aria-label") === text);
  b?.click(); return !!b;
}, text, selector);
const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
const toast = (u: User) => read(u, () => document.querySelector(".toast")?.textContent ?? "");

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  try {
    const sfx = Date.now() % 10000;
    const a = await joinAs(browser, "Waver" + sfx);
    const b = await joinAs(browser, "Desk" + sfx);
    // each page walks its own avatar: a to the social area, b to the reception (behind a wall, out of a's area of interest)
    await Promise.all([walkTo(a, 8 * 16 + 8, 28 * 16 + 8), walkTo(b, 9 * 16 + 8, 6 * 16 + 8)]);

    // ---- Ctrl+wheel zooms the map (not the UI) and the server widens the area of interest to match ----
    const sees = (u: User, id: number) => read(u, (id) => window.__hq.view.debugEntities().some((e) => e.id === id), id);
    const layoutBox = () => read(a, () => [".topbar", ".stage canvas"].map((q) => { const r = document.querySelector(q)!.getBoundingClientRect(); return [r.width, r.height].join("x"); }).join(" "));
    const s0 = await read(a, () => window.__hq.view.scale);
    const [lo] = await read(a, () => window.__hq.view.scaleRange());
    const outside = await waitFor(async () => !(await sees(a, b.id)), { timeout: 5000, what: "far person outside the area of interest" }).then(() => true, () => false);
    check("at the automatic zoom, somebody in the reception is outside my area of interest", outside);
    const box0 = await layoutBox();
    const canvas = await read(a, () => { const r = document.querySelector(".stage canvas")!.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await a.page.mouse.move(canvas.x, canvas.y);
    await a.page.keyboard.down("Control"); // Ctrl+wheel zooms, as in Gather
    await a.page.mouse.wheel({ deltaY: -33 }); // one small notch (a mouse sending 33 px per notch)
    const stepIn = await waitFor(() => read(a, (s) => window.__hq.view.scale === s + 1, s0), { timeout: 3000, what: "zoom in one step" }).then(() => true, () => false);
    for (let i = 0; i < 12 && (await read(a, () => window.__hq.view.scale)) > lo; i++) { await sleep(150); await a.page.mouse.wheel({ deltaY: 33 }); }
    await a.page.keyboard.up("Control");
    await waitFor(() => read(a, (lo) => window.__hq.view.scale === lo, lo), { what: "zoomed out to the limit" });
    check("Ctrl+wheel: one small notch is one whole zoom step; out it stops at the area-of-interest limit", stepIn && lo < s0, `auto ${s0}, farthest ${lo}`);
    check("zooming leaves the UI and the canvas size alone", (await layoutBox()) === box0, box0);
    await waitFor(() => sees(a, b.id), { what: "far person visible after zooming out" });
    check("zoomed out, the server sends the people the wider view shows", true);
    await read(a, (s) => window.__hq.view.zoomBy(s - window.__hq.view.scale), s0);

    // ---- left-drag pans the camera; moving recentres ----
    const cam = () => read(a, () => ({ x: window.__hq.view.camX, y: window.__hq.view.camY, pan: window.__hq.view.pan }));
    await sleep(300); // let the frame after the zoom change place the camera
    const c0 = await cam();
    await a.page.mouse.move(canvas.x, canvas.y);
    await a.page.mouse.down();
    await a.page.mouse.move(canvas.x - 150, canvas.y - 80, { steps: 8 });
    await a.page.mouse.up();
    await sleep(200);
    const c1 = await cam();
    check("dragging the map with the left button moves the view the same way", Math.abs(c1.x - c0.x + 150) <= 2 && Math.abs(c1.y - c0.y + 80) <= 2, `camera ${c0.x},${c0.y} -> ${c1.x},${c1.y}`);
    await a.page.keyboard.down("ArrowDown");
    await sleep(150);
    await a.page.keyboard.up("ArrowDown");
    await sleep(200);
    const c2 = await cam();
    check("moving brings the view back to me", c2.pan.x === 0 && c2.pan.y === 0 && Math.abs(c2.x - c0.x) <= 2, `camera ${c2.x},${c2.y}, pan ${JSON.stringify(c2.pan)}`);

    // ---- wave, from the people panel ----
    await click(a, "Wave at " + b.name, ".people button");
    await waitFor(() => read(b, () => !!document.querySelector(".wave-card")), { what: "wave card" });
    check("a wave reaches somebody anywhere in the office", (await read(b, () => document.querySelector(".wave-card")!.textContent)).includes(a.name));
    await waitFor(async () => (await toast(a)).includes("You waved at"), { what: "wave confirmation" });
    check("the sender is told the wave arrived", true);
    // b answers by walking over: the checks below need each in the other's area of interest
    await click(b, "Walk to them", ".wave-card button");
    await waitFor(async () => dist(await pos(a), await pos(b)) < 40 && !(await read(b, () => window.__hq.view.guided)), { timeout: 30000, what: "walk back to the waver" });
    check("Walk to them runs to the person who waved", true);
    // waving at a busy person and the 30 s cooldown: world TestWaveReachesThePersonBusyAndAwayIncluded and
    // the refusal's text, web/test/replies.test.ts

    // ---- raised hand (H), seen by the other person ----
    await a.page.keyboard.press("h");
    await waitFor(() => read(b, (id) => window.__hq.state.roster.get(id)?.h === 1 && !!window.__hq.view.ents.get(id)?.hand, a.id), { what: "hand raised" });
    check("H raises a hand that others see over the avatar and in the roster", true);
    await a.page.click(".status-menu > .btn");
    await a.page.type(".note-form input", "Deep work until 4");
    await a.page.click(".note-form button[type=submit]");
    await waitFor(() => read(b, (n) => [...document.querySelectorAll(".people .note")].some((el) => el.textContent === n), "Deep work until 4"), { what: "note in people panel" });
    check("a status note set in the status menu shows in everyone's people panel", true);
    await a.page.keyboard.press("Escape");
    // shortcuts follow key positions (AZERTY: "z" on KeyW, "&" on Digit1, the keypad without Num Lock):
    // web/test/input.test.ts; the real keys H and Z here and 1 in features.ts go through the same handler

    // ---- Ctrl+U: busy, the map greyed out under a big button that makes you available again ----
    await a.page.keyboard.down("Control"); await a.page.keyboard.press("u"); await a.page.keyboard.up("Control");
    await waitFor(() => read(b, (id) => window.__hq.state.roster.get(id)?.s === "busy", a.id), { what: "busy by Ctrl+U" });
    check("Ctrl+U makes you busy, for everybody", true);
    await waitFor(() => a.page.$(".status-veil .veil-button"), { what: "veil button" });
    await a.page.click(".veil-button");
    await waitFor(() => read(b, (id) => window.__hq.state.roster.get(id)?.s === "available", a.id), { what: "available by the button" });
    check("the veil's big button makes you available again and the veil goes", !(await a.page.$(".status-veil")));

    // ---- dance (Z) ----
    await a.page.keyboard.press("z");
    await waitFor(() => read(b, (id) => (window.__hq.view.ents.get(id)?.danceUntil ?? 0) > performance.now(), a.id), { what: "dance seen" });
    check("Z makes the avatar dance for the people nearby", true);

    // ---- minimap ----
    await waitFor(() => read(a, () => !!document.querySelector(".minimap canvas") && window.__hq.state.areaCounts.some((n) => n > 0)), { what: "minimap with counts" });
    const counts = await read(a, () => window.__hq.state.areaCounts);
    check("the minimap gets head counts per area from the server", counts.reduce((x, y) => x + y, 0) >= 2, JSON.stringify(counts));
    const start = await pos(a);
    const spot = await read(a, () => { const r = document.querySelector(".minimap canvas")!.getBoundingClientRect(); const m = window.__hq.view.currentMap()!; return { x: r.left + (4.5 * 16) * (r.width / (m.w * 16)), y: r.top + (30.5 * 16) * (r.width / (m.w * 16)) }; });
    await a.page.mouse.click(spot.x, spot.y);
    await waitFor(async () => { const p = await pos(a); return Math.floor(p.x / 16) === 4 && Math.floor(p.y / 16) === 30; }, { timeout: 20000, what: "minimap walk" });
    check("clicking the minimap runs there", dist(start, await pos(a)) > 16);
    // the browser zoom or a move to another screen changes the pixel ratio: the picture must still fill
    // the canvas (it once stayed at the old size in a corner, and people's dots piled up around it)
    const vp = a.page.viewport();
    // the colours of a 10x10 grid, to compare the picture before and after a round trip through ratio 2
    const grid = () => read(a, () => {
      const c = document.querySelector<HTMLCanvasElement>(".minimap canvas")!, g = c.getContext("2d")!, out: number[][] = [];
      for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) out.push([...g.getImageData(Math.floor((i + 0.5) * c.width / 10), Math.floor((j + 0.5) * c.height / 10), 1, 1).data]);
      return out;
    });
    const before = await grid();
    await a.page.setViewport({ ...vp!, deviceScaleFactor: 2 });
    await waitFor(() => read(a, () => window.devicePixelRatio === 2), { what: "pixel ratio 2" });
    await sleep(800); // a few minimap redraws (every 250 ms)
    const fill = await read(a, () => {
      const c = document.querySelector<HTMLCanvasElement>(".minimap canvas")!, g = c.getContext("2d")!, m = window.__hq.view.currentMap()!;
      let holes = 0;
      for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) if (g.getImageData(Math.floor((i + 0.5) * c.width / 10), Math.floor((j + 0.5) * c.height / 10), 1, 1).data[3] < 255) holes++;
      return { holes, size: `${c.width}x${c.height}`, want: `400x${Math.round(Math.round(m.h * 16 * 200 / (m.w * 16)) * 2)}` };
    });
    check("after the pixel ratio changes, the minimap's office picture fills its whole canvas", fill.holes === 0 && fill.size === fill.want, JSON.stringify(fill));
    // the other way: a minimap opened at ratio 2 (hidden and shown again with M) going back to 1 must not show
    // its larger picture cropped to the top-left quarter
    await a.page.keyboard.press("m");
    await waitFor(() => read(a, () => !document.querySelector(".minimap")), { what: "M hides the minimap" });
    await a.page.keyboard.press("m");
    await waitFor(() => read(a, () => !!document.querySelector(".minimap canvas")), { what: "minimap shown again" });
    await sleep(800);
    await a.page.setViewport(vp);
    await waitFor(() => read(a, () => window.devicePixelRatio === 1), { what: "pixel ratio 1" });
    await sleep(800);
    const back = await grid();
    // a few points may differ where a dot or a head count sits; a picture at the wrong size differs almost everywhere
    const same = before.filter((p, i) => p.every((v, k) => Math.abs(v - back[i][k]) <= 8)).length;
    check("a minimap opened at ratio 2, back at ratio 1, shows the same picture as before", same >= 95, `${same}/100 points unchanged`);

    // ---- keyboard help and an administrator announcement ----
    await a.page.keyboard.press("?");
    await waitFor(() => a.page.$("table.keys"), { what: "shortcuts dialog" });
    await a.page.keyboard.press("Escape");
    check("? opens the keyboard shortcuts and Escape closes them", await read(a, () => !document.querySelector("table.keys")));
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    await waitFor(() => click(admin, "Admin"), { what: "admin button" });
    await waitFor(() => click(admin, "Announce", '[role="tab"]'), { what: "announce tab" });
    await admin.page.type("#announce-text", "Standup in the Horizon room in 5 minutes");
    await click(admin, "Announce", "form button");
    await waitFor(() => read(a, () => document.querySelector(".announce")?.textContent.includes("Standup in the Horizon room")), { what: "banner for a" });
    check("an administrator's announcement shows as a banner", true);
    await click(a, "Dismiss announcement");
    check("the banner can be dismissed", await read(a, () => !document.querySelector(".announce")));
    // the activity log records the announcement without its text: httpapi TestAnnouncementsAreAdminOnlyAuditedWithoutTextAndRateLimited
    await admin.page.keyboard.press("Escape");

    // ---- touch pad on a phone-sized touch screen ----
    const pctx = await browser.createBrowserContext();
    const phone = await pctx.newPage();
    await phone.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36" });
    await phone.goto(process.env.HQ_APP + "/", { waitUntil: "domcontentloaded" });
    await phone.waitForSelector("input");
    await phone.type("input", "Phone" + sfx);
    await phone.click("button.primary");
    await waitFor(() => phone.evaluate(() => window.__hq?.state?.conn === "open"), { timeout: 30000, what: "phone connected" });
    const pad = await waitFor(() => phone.$(".touchpad .tp-right"), { what: "touch pad" });
    const p0 = await phone.evaluate(() => window.__hq.view.position());
    const r = (await pad.boundingBox())!;
    await phone.touchscreen.touchStart(r.x + r.width / 2, r.y + r.height / 2);
    await sleep(700);
    await phone.touchscreen.touchEnd();
    await sleep(200);
    const p1 = await phone.evaluate(() => window.__hq.view.position());
    check("on a touch screen the on-screen pad walks the avatar", p1.x - p0.x > 10, (p1.x - p0.x).toFixed(1) + " px");
    await pctx.close();

    // ---- away from the computer's own idle state (Idle Detection), opted in from the real setting
    {
      const c = await joinAs(browser, "Idler" + sfx);
      const cdp = await c.page.createCDPSession();
      await cdp.send("Emulation.setIdleOverride", { isUserActive: true, isScreenUnlocked: true });
      await c.ctx.setPermission(APP, { permission: { name: "idle-detection" }, state: "granted" });
      await c.page.evaluate(() => document.querySelector<HTMLButtonElement>(".bar-row .round.ghost")?.click());
      await waitFor(() => c.page.$(".modal"), { what: "settings dialog" });
      const box = (await c.page.evaluateHandle(() => [...document.querySelectorAll(".modal label.check")].find((l) => l.textContent.includes("computer is idle"))?.querySelector("input"))) as ElementHandle<HTMLInputElement>;
      await box.click();
      await waitFor(() => c.page.evaluate(() => window.__hq.state.settings.osIdle), { what: "idle setting on" });
      await c.page.keyboard.press("Escape");
      await cdp.send("Emulation.setIdleOverride", { isUserActive: false, isScreenUnlocked: true });
      await waitFor(async () => (await c.page.evaluate(() => window.__hq.state.status)) === "away" && (await a.page.evaluate((id) => window.__hq.state.roster.get(id)?.s, c.id)) === "away", { timeout: 10000, what: "away when the computer is idle" });
      check("with the setting ticked, an idle computer sets me away (others see it)", true);
      check("no console errors for the idle-detecting player", c.logs.length === 0, c.logs.join(" | ").slice(0, 300));
      await c.ctx.close();
    }

    check("no console errors", a.logs.length + b.logs.length === 0, [...a.logs, ...b.logs].join(" | ").slice(0, 300));
  } catch (e) {
    check("scenario completed", false, (e as Error).message);
  } finally {
    await browser.close();
  }
  return summary();
}
