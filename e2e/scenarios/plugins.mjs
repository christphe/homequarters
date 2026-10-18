// Plugins: the sample plugin (plugins/sample-pet) enabled from the admin dialog, its creatures following
// their owners on other pages, its button, its route and assets, the iframe sandbox, a flooding plugin
// stopped on one page, and disabling it live. Needs HQ_PLUGINS_DIR (run.mjs sets it).
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, sleep, API } from "../lib.mjs";

const PLUGIN = "sample-pet";
const click = (u, selector, text) => u.page.evaluate((selector, text) => {
  const b = [...document.querySelectorAll(selector)].find((x) => x.textContent.trim() === text);
  b?.click();
  return !!b;
}, selector, text);
const read = (u, fn, arg) => u.page.evaluate(fn, arg);
/** What the plugin drew on that page, or null when it does not run there. */
const creatures = (u) => read(u, (p) => window.__hq.session.plugins?.debug(p) ?? null, PLUGIN);
const creatureOf = async (u, owner) => ((await creatures(u)) ?? []).find((c) => c.player === owner);
const frames = (u) => read(u, () => document.querySelectorAll("iframe.plugin-frame").length);
const pluginFrame = (u) => u.page.frames().find((f) => f.url() === "about:srcdoc");

async function setEnabled(admin, on, title = "Sample pet", plugin = PLUGIN) {
  await waitFor(() => click(admin, ".topbar button", "Admin"), { what: "Admin button" });
  await waitFor(() => click(admin, ".modal [role=tab]", "Plugins"), { what: "Plugins tab" });
  const label = (on ? "Turn on " : "Turn off ") + title;
  await waitFor(() => admin.page.evaluate((l) => { const b = document.querySelector(`.modal button[aria-label="${l}"]`); b?.click(); return !!b; }, label), { what: label });
  await waitFor(() => admin.page.evaluate((s) => document.querySelector(`.modal tr[data-plugin="${s[1]}"]`)?.textContent.includes(s[0]), [on ? "Running" : "Off", plugin]), { what: "plugin state " + (on ? "running" : "off") });
  await admin.page.keyboard.press("Escape");
}

export async function run(ctx) {
  resetChecks();
  const browser = await launch();
  try {
    const t = String(Date.now() % 10000);
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    const mia = await joinAs(browser, "Mia" + t);
    const rem = await joinAs(browser, "Rem" + t);
    // social area, open floor (see movement.mjs)
    await walkTo(mia, 8 * 16 + 8, 31 * 16 + 8);
    await walkTo(rem, 8 * 16 + 8, 28 * 16 + 8);
    check("with the plugin off, no page runs plugin code", (await frames(mia)) === 0 && (await frames(rem)) === 0);

    // ---- enable through the admin dialog
    await waitFor(() => click(admin, ".topbar button", "Admin"), { what: "Admin button" });
    await waitFor(() => click(admin, ".modal [role=tab]", "Plugins"), { what: "Plugins tab" });
    await waitFor(() => admin.page.$('.modal tr[data-plugin="sample-pet"]'), { what: "sample-pet row" });
    check("the admin dialog lists the installed sample plugin as off", await admin.page.evaluate(() => document.querySelector('.modal tr[data-plugin="sample-pet"]').textContent.includes("Off")));
    await admin.page.keyboard.press("Escape");
    const t0 = Date.now();
    await setEnabled(admin, true);
    const audit = await (await fetch(API + "/api/admin/audit", { headers: { Cookie: "hq_session=" + ctx.adminCookie } })).text();
    check("enabling is in the activity log", audit.includes("plugin.enable") && audit.includes(PLUGIN));
    await waitFor(async () => (await creatureOf(mia, rem.id))?.visible, { timeout: 10000, what: "Rem's creature on Mia's page" });
    const shownAfter = Date.now() - t0;
    check("other people's creatures appear on my page soon after the plugin is enabled", shownAfter < 5000, shownAfter + " ms after the click");
    await waitFor(async () => (await creatureOf(rem, mia.id))?.visible && (await creatureOf(rem, rem.id))?.visible, { what: "creatures on Rem's page" });
    check("each page shows a creature for every member in view, mine included", true);
    check("exactly one plugin iframe per page", (await frames(mia)) === 1 && (await frames(rem)) === 1);

    // ---- the creature walks behind its owner, recorded on the observer's page
    const rec = read(mia, ({ id, plugin }) => new Promise((resolve) => {
      const out = [];
      const t0 = performance.now();
      const tick = (now) => {
        const e = window.__hq.view.ents.get(id);
        const c = window.__hq.session.plugins.debug(plugin).find((x) => x.player === id);
        if (e && c) out.push([now - t0, e.x, e.y, c.x, c.y]);
        if (now - t0 < 2600) requestAnimationFrame(tick); else resolve(out);
      };
      requestAnimationFrame(tick);
    }), { id: rem.id, plugin: PLUGIN });
    await read(rem, async () => {
      const v = window.__hq.view, wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(200);
      v.setDirection(1, 0); await wait(1600);
      v.setDirection(0, 0);
    });
    const S = await rec;
    const gaps = [];
    let closest = Infinity;
    for (let i = 1; i < S.length; i++) {
      const [tt, ox, oy, cx, cy] = S[i];
      const moving = Math.hypot(ox - S[i - 1][1], oy - S[i - 1][2]) > 0.2;
      const d = Math.hypot(cx - ox, cy - oy);
      closest = Math.min(closest, d);
      if (moving && tt > 900) gaps.push(d);
    }
    gaps.sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)];
    check("while the owner walks, the creature keeps about 36 px behind on the observer's page", gaps.length > 10 && med > 28 && med < 44, `median ${med?.toFixed(1)} px over ${gaps.length} frames`);
    check("the creature is never drawn on top of its owner", closest > 12, `closest ${closest.toFixed(1)} px`);

    // ---- render on demand still holds with creatures standing
    await sleep(1500);
    const draws = await read(mia, () => new Promise((resolve) => {
      const v = window.__hq.view, r0 = v.rendersTotal;
      setTimeout(() => resolve(v.rendersTotal - r0), 3000);
    }));
    check("an idle page with plugin creatures still draws only a few frames a second", draws <= 24, `${draws} draws in 3 s`);
    const restAt = await read(mia, ({ id, plugin }) => {
      const e = window.__hq.view.ents.get(id), c = window.__hq.session.plugins.debug(plugin).find((x) => x.player === id);
      return { dx: c.x - e.x, dy: c.y - e.y };
    }, { id: rem.id, plugin: PLUGIN });
    check("at rest the creature sits at its owner's side, not queued behind them", Math.abs(restAt.dx) >= 15 && Math.abs(restAt.dx) <= 30 && Math.abs(restAt.dy) <= 6, JSON.stringify(restAt));

    // ---- the plugin's modal, opened from its entry in the side panel's Plugins tab
    await waitFor(() => rem.page.evaluate(() => { const b = document.querySelector('.side .tabs button[aria-label="Plugins"]'); b?.click(); return !!b; }), { what: "Plugins tab in the side panel" });
    await waitFor(() => click(rem, ".plugins-panel button", "Sample pet"), { what: "Sample pet entry" });
    await waitFor(() => rem.page.$('.modal.plugin-modal[aria-label="Sample pet"]'), { what: "the plugin's modal" });
    check("the plugin's entry in the Plugins tab opens the modal the plugin drew", true);
    await waitFor(() => click(rem, ".modal.plugin-modal button", "Frost"), { what: "Frost button" });
    await waitFor(async () => (await creatureOf(mia, rem.id))?.key === "sprout-3", { what: "frost seedling on Mia's page" });
    check("picking a colour in the modal changes the seedling on the other page", true);
    await waitFor(() => rem.page.evaluate(() => [...document.querySelectorAll(".modal.plugin-modal button")].find((b) => b.textContent === "Frost")?.getAttribute("aria-pressed") === "true"), { what: "modal redrawn with Frost pressed" });
    check("the modal is redrawn with the new choice pressed", true);
    await click(rem, ".modal.plugin-modal button", "Hidden");
    await waitFor(async () => !(await creatureOf(mia, rem.id)), { what: "seedling hidden on Mia's page" });
    await click(rem, ".modal.plugin-modal button", "Shown");
    await waitFor(async () => (await creatureOf(mia, rem.id))?.visible, { what: "seedling shown again" });
    check("hiding and showing my seedling reaches the other page", true);
    await rem.page.keyboard.press("Escape");
    await waitFor(async () => !(await rem.page.$(".modal.plugin-modal")), { what: "modal closed by Escape" });
    check("Escape closes the plugin's modal", true);

    // ---- Let wander / Call, from the plugin's button in the top bar
    await waitFor(() => click(rem, ".topbar .plugin-slot", "Let wander"), { what: "Let wander button" });
    await waitFor(() => rem.page.evaluate(() => document.querySelector(".topbar .plugin-slot")?.textContent === "Call"), { what: "the button now says Call" });
    const remAt = await read(mia, (id) => { const e = window.__hq.view.ents.get(id); return { x: e.x, y: e.y }; }, rem.id);
    const strolls = await read(mia, ({ id, plugin }) => new Promise((resolve) => {
      const seen = [];
      const t0 = performance.now();
      const tick = () => {
        const c = window.__hq.session.plugins.debug(plugin).find((x) => x.player === id);
        if (c) seen.push([c.x, c.y, c.mode]);
        if (performance.now() - t0 < 7000) setTimeout(tick, 100); else resolve(seen);
      };
      tick();
    }), { id: rem.id, plugin: PLUGIN });
    const moved = strolls.some(([x, y], i) => i > 0 && Math.hypot(x - strolls[i - 1][0], y - strolls[i - 1][1]) > 0.5);
    const far = Math.max(...strolls.map(([x, y]) => Math.hypot(x - remAt.x, y - remAt.y)));
    check("a wandering seedling strolls on its own while its owner stands still, near where it was left", moved && far < 70 && strolls.every((x) => x[2] !== "follow"), `moved ${moved}, farthest ${far.toFixed(1)} px`);
    // Call: the seedling walks back (around walls), it never jumps; recorded frame by frame on Mia's page
    const back = read(mia, ({ id, plugin }) => new Promise((resolve) => {
      let prev = null, maxJump = 0, frames = 0;
      const t0 = performance.now();
      const tick = (now) => {
        const c = window.__hq.session.plugins.debug(plugin).find((x) => x.player === id);
        if (c && c.visible) {
          if (prev) maxJump = Math.max(maxJump, Math.hypot(c.x - prev.x, c.y - prev.y));
          prev = { x: c.x, y: c.y };
          frames++;
        }
        if (now - t0 < 2500) requestAnimationFrame(tick); else resolve({ maxJump, frames, mode: c?.mode });
      };
      requestAnimationFrame(tick);
    }), { id: rem.id, plugin: PLUGIN });
    await click(rem, ".topbar .plugin-slot", "Call");
    const callBack = await back;
    await waitFor(async () => (await creatureOf(mia, rem.id))?.mode === "follow", { what: "seedling following again" });
    check("Call brings it back to following its owner, walking, never jumping", callBack.frames > 20 && callBack.maxJump < 12, JSON.stringify(callBack));

    // ---- assets from outside
    check("the plugin's server code is never served", (await fetch(`${API}/plugins/${PLUGIN}/assets/main.ts`)).status === 404 && (await fetch(`${API}/plugins/${PLUGIN}/assets/..%2Fmain.ts`)).status === 404 && (await fetch(`${API}/plugins/${PLUGIN}/main.ts`)).status === 404);
    check("its public/ files are", (await fetch(`${API}/plugins/${PLUGIN}/assets/creatures.png`)).status === 200);

    // ---- the iframe is a sandbox
    const f = pluginFrame(mia);
    const probe = f ? await f.evaluate(() => {
      const tries = {};
      const attempt = (k, fn) => { try { tries[k] = fn() ?? "undefined"; } catch (e) { tries[k] = "threw " + e.name; } };
      attempt("parentDocument", () => String(window.parent.document.title));
      attempt("parentHQ", () => typeof window.parent.__hq);
      attempt("cookie", () => document.cookie);
      attempt("storage", () => String(localStorage.length));
      attempt("hq", () => typeof window.hq);
      return tries;
    }) : null;
    // a request the plugin sends to the office carries no session cookie (no cross-site request forgery)
    const nameBefore = await read(mia, () => fetch("/api/me").then((r) => r.json()).then((m) => m.name));
    await f?.evaluate(() => fetch("/api/profile", { method: "PUT", mode: "no-cors", credentials: "include", body: JSON.stringify({ name: "Forged" }) }).catch(() => null));
    await sleep(500);
    const nameAfter = await read(mia, () => fetch("/api/me").then((r) => r.json()).then((m) => m.name));
    check("a request from plugin code is not signed in (the profile did not change)", !!nameBefore && nameAfter === nameBefore, `${nameBefore} -> ${nameAfter}`);
    check("plugin code cannot read the page, its cookies or storage", !!probe && probe.parentDocument.startsWith("threw") && probe.parentHQ.startsWith("threw") && (probe.cookie.startsWith("threw") || probe.cookie === "") && probe.storage.startsWith("threw") && probe.hq === "object", JSON.stringify(probe));

    // ---- disable live
    await setEnabled(admin, false);
    await waitFor(async () => (await frames(mia)) === 0 && (await frames(rem)) === 0, { what: "iframes removed" });
    await waitFor(async () => (await creatures(mia)) === null && (await creatures(rem)) === null, { what: "creatures removed" });
    check("disabling removes the plugin's code and creatures from every page without a reload", true);
    check("and its button tab", await read(rem, () => !document.querySelector('.side .tabs button[aria-label="Plugins"]')));
    check("its assets answer 404", (await fetch(`${API}/plugins/${PLUGIN}/assets/creatures.png`)).status === 404);

    // ---- a plugin breaking a limit is stopped on that page only
    await setEnabled(admin, true);
    await waitFor(async () => (await frames(mia)) === 1 && (await creatureOf(mia, rem.id))?.visible, { what: "plugin back on Mia's page" });
    // a plugin sending far more than the server accepts never gets its member disconnected
    await pluginFrame(mia).evaluate(() => { for (let i = 0; i < 300; i++) window.hq.send({ t: "flood", i }); });
    const conns = await read(mia, () => new Promise((resolve) => {
      const seen = new Set();
      const t0 = performance.now();
      const tick = () => { seen.add(window.__hq.state.conn); if (performance.now() - t0 < 3000) setTimeout(tick, 50); else resolve([...seen]); };
      tick();
    }));
    check("a flood of plugin messages does not disconnect the member", conns.length === 1 && conns[0] === "open" && (await frames(mia)) === 1, conns.join());
    await pluginFrame(mia).evaluate(() => { for (let i = 0; i < 600; i++) window.hq.remove("x" + i); });
    await waitFor(() => read(mia, (p) => window.__hq.session.plugins.stopReasons.get(p) ?? "", PLUGIN), { what: "flooding plugin stopped" });
    const reason = await read(mia, (p) => window.__hq.session.plugins.stopReasons.get(p), PLUGIN);
    check("a batch over the limit stops the plugin on that page", /512/.test(reason) && (await frames(mia)) === 0, reason);
    check("the other page keeps it", (await frames(rem)) === 1 && !!(await creatureOf(rem, mia.id))?.visible);
    await walkTo(mia, 9 * 16 + 8, 31 * 16 + 8);
    check("the office keeps working on the page that stopped it", await read(mia, () => window.__hq.state.conn === "open"));

    await setEnabled(admin, false); // leave the shared office as it was

    // ---- every anchor, the modal widgets and app tokens, with the suite's test plugin (e2e/fixtures/plugins/ui-demo)
    await setEnabled(admin, true, "UI demo", "ui-demo");
    const boxText = () => read(mia, () => document.querySelector('.plugin-screen[data-plugin="ui-demo"]')?.textContent ?? "");
    await waitFor(async () => (await boxText()).includes("Last click: nothing yet"), { what: "the plugin's box on the map" });
    check("a plugin can put a box on the map (screen anchor)", true);
    // a member arriving now gets the onJoin message even though their page starts the plugin after it was sent
    const late = await joinAs(browser, "Late" + t);
    await waitFor(() => late.page.evaluate(() => document.querySelector('.plugin-screen[data-plugin="ui-demo"]')?.textContent.includes("State: welcome") ?? false), { what: "onJoin message on a new page" });
    check("a message sent by onJoin reaches a page that starts the plugin afterwards", true);
    await late.ctx.close();
    const anchors = [["topbar", '.topbar [data-anchor="topbar"] .plugin-slot'], ["topright", '.topbar [data-anchor="topright"] .plugin-slot'], ["bottombar", ".bar .plugin-slot"], ["minimap", '.minimap [data-anchor="minimap"] .plugin-slot']];
    for (const [anchor, sel] of anchors) {
      await waitFor(() => mia.page.evaluate((sel) => { const b = document.querySelector(sel + '[data-plugin="ui-demo"]'); b?.click(); return !!b; }, sel), { what: anchor + " button" });
      await waitFor(async () => (await boxText()).includes("Last click: " + anchor), { what: "callback of the " + anchor + " button" });
    }
    check("a plugin button at every anchor (top bar, top right, bottom bar, minimap) runs the plugin's callback", true);
    const named = await read(mia, () => [...document.querySelectorAll('.plugin-slot[data-plugin="ui-demo"]')].every((b) => (b.getAttribute("aria-label") || b.textContent).trim().length > 0));
    check("every plugin button has an accessible name, icon-only ones included", named);
    await waitFor(() => mia.page.evaluate(() => { const b = document.querySelector('.side .tabs button[aria-label="Plugins"]'); if (b && b.getAttribute("aria-selected") !== "true") b.click(); return !!document.querySelector(".plugins-panel"); }), { what: "Plugins tab" });
    await waitFor(() => click(mia, ".plugins-panel button", "UI demo"), { what: "UI demo entry" });
    await waitFor(() => mia.page.$('.modal.plugin-modal[aria-label="UI demo"] .copy-field input'), { what: "UI demo modal" });
    check("the copyable text shows its value", (await read(mia, () => document.querySelector(".modal.plugin-modal .copy-field input").value)) === "copied-value-42");
    await waitFor(() => click(mia, ".modal.plugin-modal button", "Create token"), { what: "Create token" });
    const token = await waitFor(() => read(mia, () => [...document.querySelectorAll(".modal.plugin-modal .app-token input")].map((i) => i.value).find((v) => v.startsWith("hqp_"))), { what: "the new token" });
    check("Create token shows the token once in a copyable field", !!token && token.length > 40);
    const post = (tok) => fetch(`${API}/plugins/ui-demo/api/state`, { method: "POST", headers: tok ? { Authorization: "Bearer " + tok } : {}, body: "hp=42" });
    check("an app outside the browser calls the plugin's route with the token", (await post(token)).status === 200);
    await waitFor(async () => (await boxText()).includes("State: hp=42"), { what: "the state on Mia's page" });
    check("what the app sent reaches the member's page", true);
    check("without the token the route answers 401", (await post("")).status === 401);
    await waitFor(() => click(mia, ".modal.plugin-modal button", "Revoke"), { what: "Revoke" });
    await waitFor(async () => (await post(token)).status === 401, { what: "revoked token refused" });
    check("a revoked token is refused", true);
    await click(mia, ".modal.plugin-modal button", "Inside the modal");
    await waitFor(async () => (await boxText()).includes("modal button"), { what: "modal button callback" });
    await mia.page.keyboard.press("Escape");
    await waitFor(async () => (await boxText()).includes("modal closed"), { what: "onClose callback" });
    check("buttons inside the modal and closing it reach the plugin", true);
    await setEnabled(admin, false, "UI demo", "ui-demo");
    await waitFor(() => read(mia, () => !document.querySelector(".plugin-screen, .plugin-slot")), { what: "plugin UI removed" });
    check("disabling a plugin removes its buttons and boxes everywhere", true);
    // the forged PUT above is refused (401) on purpose; Chrome logs that response as a console error
    const real = (u) => u.logs.filter((l) => !(u === mia && /status of 401/.test(l)));
    for (const u of [admin, mia, rem]) check(`${u.name}: no console errors`, real(u).length === 0, real(u).slice(0, 3).join(" | "));
    await Promise.all([admin, mia, rem].map((u) => u.ctx.close()));
  } catch (e) {
    check("scenario completed", false, String(e));
  } finally {
    await browser.close();
  }
  return summary();
}
