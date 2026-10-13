// Presence: waving across the office, raised hands, status notes, dancing, the minimap and the touch pad.
import { check, resetChecks, summary, launch, joinAs, waitFor, walkTo, pos, sleep } from "../lib.mjs";

const read = (u, fn, ...args) => u.page.evaluate(fn, ...args);
const click = (u, text, selector = "button") => u.page.evaluate((text, selector) => {
  const b = [...document.querySelectorAll(selector)].find((x) => x.textContent.trim() === text || x.getAttribute("aria-label") === text);
  b?.click(); return !!b;
}, text, selector);
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const toast = (u) => read(u, () => document.querySelector(".toast")?.textContent ?? "");

export async function run(ctx) {
  resetChecks();
  const browser = await launch();
  try {
    const sfx = Date.now() % 10000;
    const a = await joinAs(browser, "Waver" + sfx);
    const b = await joinAs(browser, "Desk" + sfx);
    await walkTo(a, 8 * 16 + 8, 28 * 16 + 8); // social area
    await walkTo(b, 9 * 16 + 8, 6 * 16 + 8); // reception, behind a wall and out of a's area of interest

    // ---- the mouse wheel zooms the map (not the UI) and the server widens the area of interest to match ----
    const sees = (u, id) => read(u, (id) => window.__tilework.view.debugEntities().some((e) => e.id === id), id);
    const layoutBox = () => read(a, () => [".topbar", ".stage canvas"].map((q) => { const r = document.querySelector(q).getBoundingClientRect(); return [r.width, r.height].join("x"); }).join(" "));
    const s0 = await read(a, () => window.__tilework.view.scale);
    const [lo, hi] = await read(a, () => window.__tilework.view.scaleRange());
    await read(a, (hi) => window.__tilework.view.zoomBy(hi), hi);
    await sleep(800);
    check("zoomed in, someone three cells away is outside the area of interest", !(await sees(a, b.id)));
    await read(a, (s) => window.__tilework.view.zoomBy(s - window.__tilework.view.scale), s0);
    const box0 = await layoutBox();
    const canvas = await read(a, () => { const r = document.querySelector(".stage canvas").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await a.page.mouse.move(canvas.x, canvas.y);
    await a.page.mouse.wheel({ deltaY: -100 });
    await waitFor(() => read(a, (s) => window.__tilework.view.scale === s + 1, s0), { what: "zoom in one step" });
    for (let i = 0; i < 12; i++) await a.page.mouse.wheel({ deltaY: 100 });
    await waitFor(() => read(a, (lo) => window.__tilework.view.scale === lo, lo), { what: "zoomed out to the limit" });
    check("wheel up zooms in one whole step, wheel down zooms out and stops at the area-of-interest limit", lo < s0, `auto ${s0}, farthest ${lo}`);
    check("zooming leaves the UI and the canvas size alone", (await layoutBox()) === box0, box0);
    await waitFor(() => sees(a, b.id), { what: "far person visible after zooming out" });
    check("zoomed out, the server sends the people the wider view shows", true);
    // a stands near the map's west wall: the camera must not show farther than the largest radius reaches
    const span = await read(a, () => {
      const v = window.__tilework.view, p = v.position(), S = v.scale, r = v.aoiMax * v.cellPx, m = v.currentMap();
      const { width: W, height: H } = v.app.screen;
      // visible map pixels only: a margin beyond the map's edge holds nobody
      return { l: p.x - Math.max(0, -v.camX / S), r: Math.min(m.w * 16, (W - v.camX) / S) - p.x, t: p.y - Math.max(0, -v.camY / S), b: Math.min(m.h * 16, (H - v.camY) / S) - p.y, reach: r };
    });
    check("zoomed out next to a map edge, no visible part of the map is farther from me than the server's largest radius", Math.max(span.l, span.r, span.t, span.b) <= span.reach + 1, JSON.stringify(span));
    const lineMode = await read(a, () => {
      const v = window.__tilework.view, c = document.querySelector(".stage canvas"), s0 = v.scale;
      c.dispatchEvent(new WheelEvent("wheel", { deltaY: -3, deltaMode: 1, bubbles: true, cancelable: true })); // Firefox: one notch = 3 lines
      return v.scale - s0;
    });
    check("one wheel notch in line mode (Firefox) is one zoom step", lineMode === 1, `${lineMode}`);
    await read(a, (hi) => window.__tilework.view.zoomBy(hi), hi);
    await waitFor(async () => !(await sees(a, b.id)), { what: "far person dropped after zooming back in" });
    check("zooming back in shrinks the area of interest again", true);
    await read(a, (s) => window.__tilework.view.zoomBy(s - window.__tilework.view.scale), s0);
    check("the zoom returns to the automatic scale", (await read(a, () => window.__tilework.view.scale)) === s0);

    // ---- wave, answered by walking over ----
    await click(a, "Wave at " + b.name, ".people button");
    await waitFor(() => read(b, () => !!document.querySelector(".wave-card")), { what: "wave card" });
    check("a wave reaches somebody anywhere in the office", (await read(b, () => document.querySelector(".wave-card").textContent)).includes(a.name));
    await waitFor(async () => (await toast(a)).includes("You waved at"), { what: "wave confirmation" });
    check("the sender is told the wave arrived", true);
    await click(b, "Walk to them", ".wave-card button");
    await waitFor(async () => dist(await pos(a), await pos(b)) < 40 && !(await read(b, () => window.__tilework.view.guided)), { timeout: 30000, what: "walk back to the waver" });
    check("Walk to them runs to the person who waved", true);
    await read(b, () => window.__tilework.session.setStatus("busy"));
    await sleep(2200); // wave cooldown
    await click(a, "Wave at " + b.name, ".people button");
    await waitFor(async () => (await toast(a)).includes("busy"), { what: "busy answer" });
    check("busy people are not disturbed and the sender learns why", !(await read(b, () => !!document.querySelector(".wave-card"))));
    await read(b, () => window.__tilework.session.setStatus("available"));

    // ---- raised hand (H) and a status note, seen by the other person ----
    await a.page.keyboard.press("h");
    await waitFor(() => read(b, (id) => window.__tilework.state.roster.get(id)?.h === 1 && !!window.__tilework.view.ents.get(id)?.hand, a.id), { what: "hand raised" });
    check("H raises a hand that others see over the avatar and in the roster", true);
    await a.page.keyboard.press("h");
    await waitFor(() => read(b, (id) => !window.__tilework.state.roster.get(id)?.h && !window.__tilework.view.ents.get(id)?.hand, a.id), { what: "hand lowered" });
    check("pressing H again lowers it", true);
    // two quick presses (before the server's echo) are a raise and a lower, not two raises
    await a.page.keyboard.press("h");
    await a.page.keyboard.press("h");
    await sleep(1500);
    check("H pressed twice quickly leaves the hand down", await read(b, (id) => !window.__tilework.state.roster.get(id)?.h, a.id) && await read(a, () => !window.__tilework.state.roster.get(window.__tilework.state.meId)?.h));
    // the on-screen hand button does the same as H
    await a.page.click('.reaction-row button[aria-label^="Raise hand"]');
    await waitFor(() => read(b, (id) => window.__tilework.state.roster.get(id)?.h === 1, a.id), { what: "hand raised by the button" });
    await waitFor(() => a.page.$('.reaction-row button[aria-label^="Lower hand"][aria-pressed="true"]'), { what: "button shows the raised hand" });
    await a.page.click('.reaction-row button[aria-label^="Lower hand"]');
    await waitFor(() => read(b, (id) => !window.__tilework.state.roster.get(id)?.h, a.id), { what: "hand lowered by the button" });
    check("the hand button raises and lowers the hand for others", true);
    await a.page.click(".status-menu > .btn");
    await a.page.type(".note-form input", "Deep work until 4");
    await a.page.click(".note-form button[type=submit]");
    await waitFor(() => read(b, (n) => [...document.querySelectorAll(".people .note")].some((el) => el.textContent === n), "Deep work until 4"), { what: "note in people panel" });
    check("a status note set in the status menu shows in everyone's people panel", true);

    // ---- shortcuts follow key positions: an AZERTY keyboard types "z" on KeyW and "&" on Digit1 ----
    const key = (type, key, code) => read(a, (type, key, code) => window.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true })), type, key, code);
    await sleep(800); // emote cooldown
    await key("keydown", "&", "Digit1");
    await key("keyup", "&", "Digit1");
    await waitFor(() => read(b, (id) => window.__tilework.view.emotes.has(id), a.id), { what: "emote from the digit row without Shift" });
    check("the digit row sends reactions whatever character the layout types there", true);
    await sleep(800);
    await key("keydown", "z", "KeyW");
    const up = await read(a, () => window.__tilework.view.dy);
    await key("keyup", "z", "KeyW");
    const after = await read(a, () => window.__tilework.view.dy);
    await key("keydown", "ArrowUp", "Numpad8"); // keypad with Num Lock off
    const keypad = await read(a, () => window.__tilework.view.dy);
    await key("keyup", "ArrowUp", "Numpad8");
    check("the keypad without Num Lock still walks", keypad === -1, `dy ${keypad}`);
    await sleep(800);
    check("the key at the W position (Z on AZERTY) walks up and does not dance", up === -1 && after === 0 && !(await read(b, (id) => window.__tilework.view.ents.get(id)?.danceUntil > performance.now(), a.id)), `dy ${up} then ${after}`);

    // ---- dance (Z) ----
    await a.page.keyboard.press("z");
    await waitFor(() => read(b, (id) => window.__tilework.view.ents.get(id)?.danceUntil > performance.now(), a.id), { what: "dance seen" });
    check("Z makes the avatar dance for the people nearby", true);

    // ---- minimap ----
    await waitFor(() => read(a, () => !!document.querySelector(".minimap canvas") && window.__tilework.state.areaCounts.some((n) => n > 0)), { what: "minimap with counts" });
    const counts = await read(a, () => window.__tilework.state.areaCounts);
    check("the minimap shows head counts per area from the server", counts.reduce((x, y) => x + y, 0) >= 2, JSON.stringify(counts));
    const start = await pos(a);
    const box = await read(a, () => { const r = document.querySelector(".minimap canvas").getBoundingClientRect(); const m = window.__tilework.view.currentMap(); return { x: r.left + (4.5 * 16) * (r.width / (m.w * 16)), y: r.top + (30.5 * 16) * (r.width / (m.w * 16)) }; });
    await a.page.mouse.click(box.x, box.y);
    await waitFor(async () => { const p = await pos(a); return Math.floor(p.x / 16) === 4 && Math.floor(p.y / 16) === 30; }, { timeout: 20000, what: "minimap walk" });
    check("clicking the minimap runs there", dist(start, await pos(a)) > 16);
    await a.page.keyboard.press("m");

    // ---- keyboard help and an administrator announcement ----
    // Chrome reports the layout through navigator.keyboard; pretend it is French AZERTY.
    await read(a, () => window.__tilework.keys.setKeyLayout(new Map([["KeyW", "z"], ["KeyA", "q"], ["KeyS", "s"], ["KeyD", "d"], ["KeyZ", "w"], ["KeyM", ","], ["Digit1", "&"]])));
    await a.page.keyboard.press("?");
    await waitFor(() => a.page.$("table.keys"), { what: "shortcuts dialog" });
    const help = await read(a, () => [...document.querySelectorAll("table.keys tr")].map((r) => r.textContent));
    check("the shortcuts list names the keys as printed on the keyboard (ZQSD on AZERTY) but keeps 1-7", help.some((r) => r.startsWith("Z Q S D")) && help.some((r) => r.startsWith("1-7")) && help.some((r) => r.startsWith("W") && r.includes("Dance")) && help.some((r) => r.includes("Mouse wheel")), help.join(" | "));
    await a.page.keyboard.press("Escape");
    // letter shortcuts keep their letter: M is printed right of L on AZERTY, the M position types ","
    const minimap = () => read(a, () => window.__tilework.state.settings.minimap);
    const m0 = await minimap();
    await read(a, () => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", code: "KeyM", bubbles: true })));
    const m1 = await minimap();
    await read(a, () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "m", code: "Semicolon", bubbles: true })));
    check("on AZERTY the key printed M toggles the minimap, the M position (,) does not", m1 === m0 && (await minimap()) === !m0);
    await read(a, () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "m", code: "Semicolon", bubbles: true })));
    await read(a, () => window.__tilework.keys.setKeyLayout(null));
    await a.page.keyboard.press("Escape");
    check("? opens the keyboard shortcuts and Escape closes them", await read(a, () => !document.querySelector("table.keys")));
    // AZERTY types "?" with Shift on the M position: the help opens, the minimap does not toggle
    const mini0 = await read(a, () => window.__tilework.state.settings.minimap);
    await read(a, () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", code: "KeyM", shiftKey: true, bubbles: true })));
    await waitFor(() => a.page.$("table.keys"), { what: "shortcuts dialog from Shift+M position" });
    check("? typed on the M position (AZERTY) opens the help without toggling the minimap", (await read(a, () => window.__tilework.state.settings.minimap)) === mini0);
    await a.page.keyboard.press("Escape");
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    await waitFor(() => click(admin, "Admin"), { what: "admin button" });
    await waitFor(() => click(admin, "Announce", '[role="tab"]'), { what: "announce tab" });
    await admin.page.type("#announce-text", "Standup in the Horizon room in 5 minutes");
    await click(admin, "Announce", "form button");
    await waitFor(() => read(a, () => document.querySelector(".announce")?.textContent.includes("Standup in the Horizon room")), { what: "banner for a" });
    await waitFor(() => read(b, () => document.querySelector(".announce")?.textContent.includes("Standup in the Horizon room")), { what: "banner for b" });
    check("an administrator's announcement shows as a banner to everybody online", true);
    await click(a, "Dismiss announcement");
    check("the banner can be dismissed", await read(a, () => !document.querySelector(".announce")));
    const log = await read(admin, () => fetch("/api/admin/audit").then((r) => r.text()));
    check("the activity log records the announcement without its text", log.includes('"announce"') && !log.includes("Standup"));
    await admin.page.keyboard.press("Escape");
    check("M hides the minimap", await read(a, () => !document.querySelector(".minimap")));
    await a.page.keyboard.press("m");

    // ---- touch pad on a phone-sized touch screen ----
    const pctx = await browser.createBrowserContext();
    const phone = await pctx.newPage();
    await phone.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36" });
    await phone.goto(process.env.TILEWORK_APP + "/", { waitUntil: "domcontentloaded" });
    await phone.waitForSelector("input");
    await phone.type("input", "Phone" + sfx);
    await phone.click("button.primary");
    await waitFor(() => phone.evaluate(() => window.__tilework?.state?.conn === "open"), { timeout: 30000, what: "phone connected" });
    const pad = await waitFor(() => phone.$(".touchpad .tp-right"), { what: "touch pad" });
    const p0 = await phone.evaluate(() => window.__tilework.view.position());
    const r = await pad.boundingBox();
    await phone.touchscreen.touchStart(r.x + r.width / 2, r.y + r.height / 2);
    await sleep(700);
    await phone.touchscreen.touchEnd();
    await sleep(200);
    const p1 = await phone.evaluate(() => window.__tilework.view.position());
    check("on a touch screen the on-screen pad walks the avatar", p1.x - p0.x > 10, (p1.x - p0.x).toFixed(1) + " px");
    await pctx.close();

    check("no console errors", a.logs.length + b.logs.length === 0, [...a.logs, ...b.logs].join(" | ").slice(0, 300));
  } catch (e) {
    check("scenario completed", false, e.message);
  } finally {
    await browser.close();
  }
  return summary();
}
