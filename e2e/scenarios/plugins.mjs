// Plugins: the bundled pets plugin (plugins/bundled/hq-pets) enabled from the admin dialog, pets added,
// recoloured and removed in its modal and following their owners on other pages, the office's limit, its button, its route and assets, the iframe sandbox, a flooding plugin
// stopped on one page, and disabling it live. Needs HQ_PLUGINS_DIR (run.mjs sets it).
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, sleep, API } from "../lib.mjs";

const PLUGIN = "hq-pets";
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
const petsOf = async (u, owner) => ((await creatures(u)) ?? []).filter((c) => c.player === owner);
/** One of owner's pets by its sheet key: n<kind> in its own colours, t<kind> tinted. */
const pet = async (u, owner, key) => (await petsOf(u, owner)).find((c) => c.key === key);
const modalHas = (u, text) => u.page.evaluate((text) => [...document.querySelectorAll(".modal.plugin-modal button, .modal.plugin-modal p")].some((x) => x.textContent === text), text);
/** Puts text in a field of the plugin's modal with the keyboard, then Enter. */
async function setField(u, selector, text) {
  const sel = ".modal.plugin-modal " + selector;
  await waitFor(() => u.page.$(sel), { what: selector });
  await u.page.focus(sel);
  await u.page.evaluate((sel) => document.querySelector(sel).select(), sel);
  await u.page.keyboard.type(text);
  await u.page.keyboard.press("Enter");
}
/** Moves the real mouse over one of owner's pets on u's page, and reads the hover tag. */
async function hoverOver(u, owner, sprite) {
  const c = (await petsOf(u, owner)).find((x) => x.id === sprite);
  if (!c) return "missing";
  const at = await read(u, ({ x, y }) => window.__hq.view.pageOf(x, y - 8), { x: c.x, y: c.y });
  // a pet under the top bar or off the canvas cannot be pointed at on this page (CI's 800x450 view)
  if (!(await u.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName === "CANVAS", at))) return "covered";
  await u.page.mouse.move(at.x, at.y);
  // a wandering pet keeps walking: read the tag on the next frames, before it walks out from under the mouse
  return read(u, () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.__hq.view.hoverText())))));
}
/** hoverOver on the first of these pages where the pet is in view. */
async function hoverOn(pages, owner, sprite) {
  let tag = "covered";
  for (const u of pages) if ((tag = await hoverOver(u, owner, sprite)) !== "covered") break;
  return tag;
}
async function openPets(u) {
  await waitFor(() => u.page.evaluate(() => {
    const b = document.querySelector('.side .tabs button[aria-label="Plugins"]');
    if (b && b.getAttribute("aria-selected") !== "true") b.click();
    return !!b;
  }), { what: "Plugins tab in the side panel" });
  // A plugin that has just started shows its entry before its code answers it: click again until the
  // modal opens, as a person would (a single click right after enabling was lost on a loaded runner).
  let clickedAt = 0;
  await waitFor(async () => {
    if (await u.page.$('.modal.plugin-modal[aria-label="Pets"]')) return true;
    if (Date.now() - clickedAt > 3000 && (await click(u, ".plugins-panel button", "Pets"))) clickedAt = Date.now();
    return false;
  }, { timeout: 30000, what: "the Pets modal" });
}

async function setEnabled(admin, on, title = "Pets", plugin = PLUGIN) {
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
    await waitFor(() => admin.page.$('.modal tr[data-plugin="hq-pets"]'), { what: "hq-pets row" });
    check("the admin dialog lists the bundled pets plugin as off", await admin.page.evaluate(() => document.querySelector('.modal tr[data-plugin="hq-pets"]').textContent.includes("Off")));
    const rows = await admin.page.evaluate(() => [...document.querySelectorAll(".modal .plugins-table tbody tr")].map((r) => ({
      name: r.dataset.plugin, source: r.querySelector(".plugin-source")?.textContent, text: r.textContent, button: !!r.querySelector("button"),
    })));
    const row = (n) => rows.find((r) => r.name === n) ?? {};
    check("every plugin row says where it comes from", rows.length >= 3 && row("hq-pets").source === "Bundled" && row("ui-demo").source === "Installed" && rows.every((r) => r.source), JSON.stringify(rows.map((r) => [r.name, r.source])));
    check("an installed plugin using hq- is listed as refused, with the rule, and has no switch",
      row("hq-impostor").source === "Installed" && row("hq-impostor").text.includes("Cannot run") && row("hq-impostor").text.includes("reserved for plugins bundled") && !row("hq-impostor").button,
      row("hq-impostor").text);
    await admin.page.keyboard.press("Escape");
    await setEnabled(admin, true);
    const audit = await (await fetch(API + "/api/admin/audit", { headers: { Cookie: "hq_session=" + ctx.adminCookie } })).text();
    check("enabling is in the activity log", audit.includes("plugin.enable") && audit.includes(PLUGIN));
    await waitFor(async () => (await frames(mia)) === 1 && (await frames(rem)) === 1, { what: "plugin iframes" });
    check("exactly one plugin iframe per page", true);
    check("nobody has a pet until they add one", ((await creatures(mia)) ?? []).length === 0);

    // ---- the plugin's modal, opened from its entry in the side panel's Plugins tab: add pets
    await openPets(rem);
    check("the plugin's entry in the Plugins tab opens the modal the plugin drew", true);
    const t0 = Date.now();
    await waitFor(() => click(rem, ".modal.plugin-modal button", "Cat"), { what: "Cat button" });
    await waitFor(async () => (await petsOf(mia, rem.id)).length === 1, { timeout: 10000, what: "Rem's cat on Mia's page" });
    check("a pet added in the modal appears on the other page", Date.now() - t0 < 3000, (Date.now() - t0) + " ms");
    await waitFor(() => modalHas(rem, "Add a pet (1 of 3)"), { what: "modal redrawn" });
    await click(rem, ".modal.plugin-modal button", "Seedling");
    await waitFor(async () => (await petsOf(mia, rem.id)).length === 2, { what: "Rem's seedling on Mia's page" });
    const [cat, seedling] = await Promise.all([pet(mia, rem.id, "n0"), pet(mia, rem.id, "n8")]);
    check("a member can have several pets, of any kind including the seedling", !!cat && !!seedling, JSON.stringify((await petsOf(mia, rem.id)).map((c) => c.key)));
    await rem.page.keyboard.press("Escape");
    await waitFor(async () => !(await rem.page.$(".modal.plugin-modal")), { what: "modal closed by Escape" });
    check("Escape closes the plugin's modal", true);
    await openPets(mia);
    await waitFor(() => click(mia, ".modal.plugin-modal button", "Dog"), { what: "Mia's Dog button" });
    await waitFor(async () => (await petsOf(rem, mia.id)).length === 1 && (await petsOf(rem, rem.id)).length === 2, { what: "pets on Rem's page" });
    check("each page shows every member's pets, mine included", true);
    check("the pets modal has no office setting (it is in the admin dialog)", await read(mia, () => !document.querySelector('.modal.plugin-modal input[type="number"]')));
    await mia.page.keyboard.press("Escape");

    // ---- the pets walk behind their owner in a line, recorded on the observer's page
    const rec = read(mia, ({ id, plugin, a, b }) => new Promise((resolve) => {
      const out = [];
      const t0 = performance.now();
      const tick = (now) => {
        const e = window.__hq.view.ents.get(id);
        const list = window.__hq.session.plugins.debug(plugin);
        const ca = list.find((x) => x.id === a), cb = list.find((x) => x.id === b);
        if (e && ca && cb) out.push([now - t0, e.x, e.y, ca.x, ca.y, cb.x, cb.y]);
        if (now - t0 < 2600) requestAnimationFrame(tick); else resolve(out);
      };
      requestAnimationFrame(tick);
    }), { id: rem.id, plugin: PLUGIN, a: cat.id, b: seedling.id });
    await read(rem, async () => {
      const v = window.__hq.view, wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(200);
      v.setDirection(1, 0); await wait(1600);
      v.setDirection(0, 0);
    });
    const S = await rec;
    const ga = [], gb = [];
    let closest = Infinity;
    for (let i = 1; i < S.length; i++) {
      const [tt, ox, oy, ax, ay, bx, by] = S[i];
      const moving = Math.hypot(ox - S[i - 1][1], oy - S[i - 1][2]) > 0.2;
      if (moving && tt > 900) {
        // walking (resting pets sit at the feet on purpose): never on top of the owner
        closest = Math.min(closest, Math.hypot(ax - ox, ay - oy), Math.hypot(bx - ox, by - oy));
        ga.push(Math.hypot(ax - ox, ay - oy));
        gb.push(Math.hypot(bx - ox, by - oy));
      }
    }
    const med = (l) => l.sort((x, y) => x - y)[Math.floor(l.length / 2)];
    const [ma, mb] = [med(ga), med(gb)];
    check("while the owner walks, the first pet keeps about 20 px behind and the next one about 36 px", ga.length > 10 && ma > 14 && ma < 28 && mb > 28 && mb < 44, `medians ${ma?.toFixed(1)} and ${mb?.toFixed(1)} px over ${ga.length} frames`);
    check("no pet walks on top of its owner", closest > 12, `closest ${closest.toFixed(1)} px`);

    // ---- a walk-to (double-click on the map, Cmd+D, joining someone): the server runs the owner there,
    // and the pets run after them on every page: smoothly, every frame, with their walk animation (they
    // used to sit still, then hop after an owner moved only at the server's 15 Hz). A browser drawing
    // under 15 fps (CI's software renderer) sees a server move on nearly every frame even in hops, so
    // under 20 fps the owner's pace is judged too: a smooth run covers ground in step with the time
    // between frames (above it, frame jitter on a busy runner moves the pace more than hops would, and
    // hops already show as still frames).
    const runAfter = (u) => read(u, ({ plugin, owner, ms }) => new Promise((resolve) => {
      const last = new Map();
      let max = 0, frames = 0, ownerStill = 0, petStill = 0, since = 0, prev = 0, span = 0;
      const paces = [];
      const t0 = performance.now();
      const tick = (now) => {
        const v = window.__hq.view, e = v.ents.get(owner);
        const running = owner === v.meId ? v.guided : !!(e?.dx || e?.dy);
        since = running ? since || now : 0;
        const steady = running && now - since > 300; // under way, not starting
        if (steady) frames++;
        const o = last.get("owner");
        if (steady && o && Math.hypot(e.x - o[0], e.y - o[1]) < 0.1) ownerStill++;
        if (steady && o && now > prev) {
          paces.push(Math.hypot(e.x - o[0], e.y - o[1]) / (now - prev));
          span += now - prev;
        }
        prev = now;
        last.set("owner", [e.x, e.y]);
        for (const c of window.__hq.session.plugins.debug(plugin).filter((x) => x.player === owner && x.visible)) {
          const p = last.get(c.id);
          if (p) max = Math.max(max, Math.hypot(c.x - p[0], c.y - p[1]));
          if (steady && p && (Math.hypot(c.x - p[0], c.y - p[1]) < 0.1 || !c.moving)) petStill++;
          last.set(c.id, [c.x, c.y]);
        }
        if (now - t0 < ms) return requestAnimationFrame(tick);
        // frames off the median pace by more than a third: 15 Hz hops make one in every few
        const med = [...paces].sort((a, b) => a - b)[Math.floor(paces.length / 2)] ?? 0;
        const uneven = paces.filter((x) => Math.abs(x - med) > med / 3).length;
        resolve({ max, frames, ownerStill, petStill, uneven, span, fps: paces.length / (span / 1000 || 1) });
      };
      requestAnimationFrame(tick);
    }), { plugin: PLUGIN, owner: rem.id, ms: 3500 });
    await sleep(800);
    const [onRem, onMia] = [runAfter(rem), runAfter(mia)];
    const to = await read(rem, () => window.__hq.view.pageOf(4 * 16 + 8, 27 * 16 + 8));
    await rem.page.mouse.click(to.x, to.y, { count: 2 });
    const [jr, jm] = await Promise.all([onRem, onMia]);
    const arrived = await read(rem, () => { const e = window.__hq.view.ents.get(window.__hq.view.meId); return [e.x, e.y]; });
    check("a double-click on the map runs the owner there", Math.hypot(arrived[0] - (4 * 16 + 8), arrived[1] - (27 * 16 + 8)) < 12, JSON.stringify(arrived));
    const say = (r) => `${r.ownerStill} still owner frames, ${r.uneven} off its pace, ${r.petStill} still pet frames of ${r.frames} (${r.fps.toFixed(0)} fps over ${(r.span / 1000).toFixed(1)} s), largest pet step ${r.max.toFixed(1)} px`;
    check("on a walk-to the owner's own avatar runs smoothly, moving every frame (not in 15 Hz hops)", jr.frames >= 8 && jr.span >= 600 && jr.ownerStill <= jr.frames * 0.1 && (jr.fps >= 20 || jr.uneven <= jr.frames * 0.2), say(jr));
    check("its pets run after it every frame with their walk animation, on the owner's page and on others, never jumping",
      jr.frames >= 8 && jm.frames >= 8 && jr.span >= 600 && jm.span >= 600 && jr.petStill <= jr.frames * 0.05 && jm.petStill <= jm.frames * 0.05 && jr.max < 24 && jm.max < 24, `owner's page: ${say(jr)}; other page: ${say(jm)}`);

    // ---- render on demand still holds with pets standing
    await sleep(1500);
    const draws = await read(mia, () => new Promise((resolve) => {
      const v = window.__hq.view, r0 = v.rendersTotal;
      setTimeout(() => resolve(v.rendersTotal - r0), 3000);
    }));
    // resting pets potter about (a short stroll every 5-10 s each): the page redraws while one walks, not all the time
    check("an idle page with pottering pets does not redraw continuously", draws <= 120, `${draws} draws in 3 s`);
    const restAt = await read(mia, ({ id, plugin, a, b }) => {
      const e = window.__hq.view.ents.get(id), list = window.__hq.session.plugins.debug(plugin);
      const ca = list.find((x) => x.id === a), cb = list.find((x) => x.id === b);
      return { a: [ca.x - e.x, ca.y - e.y], b: [cb.x - e.x, cb.y - e.y] };
    }, { id: rem.id, plugin: PLUGIN, a: cat.id, b: seedling.id });
    check("at rest the pets potter about their owner's feet, close enough to fit at a desk",
      [restAt.a, restAt.b].every(([dx, dy]) => Math.hypot(dx, dy) <= 28 && Math.abs(dy) <= 12),
      JSON.stringify(restAt));

    // ---- a name and a colour per pet, through the modal's fields
    await openPets(rem);
    await setField(rem, 'input[type="text"]', "Biscuit");
    await waitFor(async () => (await pet(mia, rem.id, "n0"))?.label === null && (await read(rem, () => document.querySelector('.modal.plugin-modal input[type="text"]')?.value === "Biscuit")), { what: "the name kept in the redrawn modal" });
    check("naming a pet in the modal is kept (redrawn with it)", true);
    const picked = await read(rem, () => {
      const input = document.querySelector('.modal.plugin-modal input[type="color"]');
      if (!input) return false;
      input.value = "#3fa7d6"; // what choosing a colour in the picker does; then the browser fires change
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
    await waitFor(async () => { const c = await pet(mia, rem.id, "t0"); return c && c.tint === 0x3fa7d6; }, { what: "a blue cat on Mia's page" });
    check("a colour picked for one pet reaches the other page, on that pet only", picked && (await pet(mia, rem.id, "n8"))?.tint === 0xffffff);
    await waitFor(() => click(rem, ".modal.plugin-modal button", "Reset colour"), { what: "Reset colour button" });
    await waitFor(async () => (await pet(mia, rem.id, "n0"))?.tint === 0xffffff, { what: "the cat in its own colours again" });
    check("Reset colour gives the pet back its drawn colours", true);
    // remove the seedling (second row): the cat stays the same sprite, it does not turn into another pet
    await waitFor(() => rem.page.evaluate(() => {
      const b = [...document.querySelectorAll(".modal.plugin-modal button")].filter((x) => x.textContent === "Remove")[1];
      b?.click();
      return !!b;
    }), { what: "Remove button" });
    await waitFor(async () => (await petsOf(mia, rem.id)).length === 1, { what: "seedling removed on Mia's page" });
    check("removing a pet takes that one away and leaves the other as it was", (await petsOf(mia, rem.id))[0]?.id === cat.id);
    await rem.page.keyboard.press("Escape");

    // ---- the office's limit: the plugin's setting, in Administration > Plugins
    const setLimit = async (n) => {
      await waitFor(() => click(admin, ".topbar button", "Admin"), { what: "Admin button" });
      await waitFor(() => click(admin, ".modal [role=tab]", "Plugins"), { what: "Plugins tab" });
      await waitFor(() => admin.page.evaluate(() => { const b = document.querySelector('.modal button[aria-label="Settings of Pets"]'); b?.click(); return !!b; }), { what: "the gear button" });
      const sel = `.modal .plugin-setting input`;
      await waitFor(() => admin.page.$(sel), { what: "the limit field" });
      const before = await read(admin, (sel) => document.querySelector(sel).value, sel);
      await admin.page.focus(sel);
      await admin.page.evaluate((sel) => document.querySelector(sel).select(), sel);
      await admin.page.keyboard.type(String(n));
      await admin.page.keyboard.press("Enter"); // submits the settings form: Save, which closes the modal
      await waitFor(async () => !(await admin.page.$(".modal .plugin-setting")), { what: "settings saved and closed" });
      await admin.page.keyboard.press("Escape"); // the admin dialog
      return before;
    };
    check("the pets per member setting is behind the plugin's gear in Administration > Plugins, 3 by default", (await setLimit(1)) === "3");
    await openPets(rem);
    await waitFor(() => modalHas(rem, "You have 1 pet, the most this office allows."), { what: "Rem told the new limit" });
    check("a lower limit reaches members at once: no more Add buttons", !(await modalHas(rem, "Seedling")));
    await rem.page.keyboard.press("Escape");
    await setLimit(3);
    const audit2 = await (await fetch(API + "/api/admin/audit", { headers: { Cookie: "hq_session=" + ctx.adminCookie } })).text();
    check("changing it is in the activity log", audit2.includes("plugin.settings") && audit2.includes("limit=1"));

    // ---- another plugin's pet through the pets plugin's hooks: critters (e2e/fixtures), called by an app
    // outside the browser with Rem's app token, draws a critter that the pets plugin walks for Rem
    await fetch(API + "/api/admin/plugins/critters", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify({ enabled: true }) });
    const critterToken = await waitFor(() => read(rem, () => fetch("/api/plugins/critters/token", { method: "POST" }).then((r) => r.ok ? r.json() : null).then((j) => j?.token)), { what: "a critters token" });
    const petCall = (path, body) => fetch(`${API}/plugins/critters/api/${path}`, { method: "POST", headers: { Authorization: "Bearer " + critterToken }, body });
    const put = await (await petCall("pet", "Bramble")).json();
    await waitFor(async () => (await petsOf(mia, rem.id)).some((c) => c.key.startsWith("g") && c.visible), { what: "the critter on Mia's page" });
    check("another plugin puts a pet of its own drawing with the member whose token it served, and it follows them", put.ok === true, JSON.stringify(put));
    await openPets(rem);
    check("that pet is not in the Pets modal, and does not count in the limit", !(await modalHas(rem, "Bramble")) && (await modalHas(rem, "Add a pet (1 of 3)")));
    await rem.page.keyboard.press("Escape");
    const gone = await (await petCall("unpet", "")).json();
    await waitFor(async () => !(await petsOf(mia, rem.id)).some((c) => c.key.startsWith("g")), { what: "the critter gone" });
    check("the plugin that put it takes it away", gone.removed === true);
    await fetch(API + "/api/admin/plugins/critters", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify({ enabled: false }) });

    // ---- a guest pet whose sheet its plugin draws on each page: drawn-pet (e2e/fixtures) gives one by
    // metadata (setPet without a sheet) and provides its sheet from an OffscreenCanvas (hq.provideSheet)
    await fetch(API + "/api/admin/plugins/drawn-pet", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify({ enabled: true }) });
    const drawnPet = (u, owner) => read(u, (id) => (window.__hq.session.plugins?.debug("hq-pets") ?? []).find((c) => c.id.startsWith(id + ":x:drawn-pet:") && c.visible) ?? null, String(owner));
    // left out, not only hidden: no place behind its owner, nobody to go along with
    const leftOut = (u, owner) => read(u, (id) => !(window.__hq.session.plugins?.debug("hq-pets") ?? []).some((c) => c.id.startsWith(id + ":x:drawn-pet:")), String(owner));
    const dp = await waitFor(async () => (await drawnPet(mia, rem.id)) ?? false, { timeout: 15000, what: "Rem's drawn pet on Mia's page" }).catch(() => null);
    check("a guest pet put by metadata is drawn by its plugin on every page and follows its owner like a pet", dp?.mode === "follow" && dp?.player === rem.id, JSON.stringify(dp));
    const drawnPetOn = (enabled) => fetch(API + "/api/admin/plugins/drawn-pet", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify({ enabled }) });
    await drawnPetOn(false);
    const goneWithIt = await waitFor(async () => (await leftOut(mia, rem.id)) && (await leftOut(rem, rem.id)), { what: "drawn pet gone with its plugin" }).catch(() => false);
    // hq-pets itself still runs: its own pet stays (a stopped hq-pets would hide the drawn pet too)
    const catStays = (await petsOf(mia, rem.id)).some((c) => c.id === cat.id) && (await petsOf(rem, rem.id)).some((c) => c.id === cat.id);
    check("turning the plugin off takes its drawn pet out of every page at once (no place left behind its owner), and leaves the other pets", goneWithIt && catStays, `gone ${goneWithIt}, cat stays ${catStays}`);
    await drawnPetOn(true);
    const drawnBack = await waitFor(async () => (await drawnPet(mia, rem.id)) ?? false, { timeout: 15000, what: "drawn pet back with its plugin" }).catch(() => null);
    check("turning it on again draws the pet again, without reloading the page", drawnBack?.mode === "follow" && drawnBack?.player === rem.id, JSON.stringify(drawnBack));
    await drawnPetOn(false);
    await waitFor(async () => (await leftOut(mia, rem.id)) && (await leftOut(rem, rem.id)), { what: "drawn pet gone again" });

    // ---- the name shows on hover, only while the pet wanders
    check("a following pet shows nothing when the mouse is over it", (await hoverOn([mia, rem], rem.id, cat.id)) === "");
    // ---- Let wander / Call, from the plugin's button in the top bar
    // first Rem walks to open floor: a pet that picks a spot it cannot reach (a wall, a desk) rests until
    // its next pick, 18-65 s later, and Rem stands against a wall since the walk-to above
    const open = await read(rem, () => {
      const v = window.__hq.view, me = v.ents.get(v.meId), T = 16;
      const free = (x, y) => { for (let r = 16; r <= 64; r += 16) for (let a = 0; a < 16; a++) if (!v.canStandStatic(x + Math.cos(a * Math.PI / 8) * r, y + Math.sin(a * Math.PI / 8) * r)) return false; return v.canStandStatic(x, y); };
      let best = null;
      for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) {
        const x = (Math.floor(me.x / T) + dx) * T + T / 2, y = (Math.floor(me.y / T) + dy) * T + T / 2, d = Math.hypot(x - me.x, y - me.y);
        const at = v.pageOf(x, y);
        if (document.elementFromPoint(at.x, at.y)?.tagName !== "CANVAS" || !free(x, y)) continue;
        if (!best || d < best.d) best = { x, y, d, at };
      }
      return best;
    });
    if (open) {
      await rem.page.mouse.click(open.at.x, open.at.y, { count: 2 });
      await waitFor(() => read(rem, ({ x, y }) => { const v = window.__hq.view, e = v.ents.get(v.meId); return !v.guided && Math.hypot(e.x - x, e.y - y) < 12; }, open), { timeout: 15000, what: "Rem on open floor" }).catch(() => {});
      await sleep(600); // the pets settle behind Rem
    }
    // the cat's walks are recorded on Mia's page from the moment it is let go: its first one starts within
    // 2 s; the recording goes on until it walked (9 to 25 s: a spot it cannot reach costs it one pause)
    const remAt = await read(mia, (id) => { const e = window.__hq.view.ents.get(id); return { x: e.x, y: e.y }; }, rem.id);
    const strolling = read(mia, ({ id, plugin }) => new Promise((resolve) => {
      const seen = [];
      const t0 = performance.now();
      const tick = () => {
        const c = window.__hq.session.plugins.debug(plugin).find((x) => x.id === id);
        if (c) seen.push([c.x, c.y, c.mode]);
        const moved = seen.some(([x, y], i) => i > 0 && Math.hypot(x - seen[i - 1][0], y - seen[i - 1][1]) > 0.5);
        const t = performance.now() - t0;
        if (t < 9000 || (!moved && t < 25000)) setTimeout(tick, 100); else resolve(seen);
      };
      tick();
    }), { id: cat.id, plugin: PLUGIN });
    await waitFor(() => click(rem, ".topbar .plugin-slot", "Let pets wander"), { what: "Let wander button" });
    // a socializing pet goes along with another wandering pet: Mia's dog joins Rem's cat on Rem's page
    await waitFor(() => click(mia, ".topbar .plugin-slot", "Let pets wander"), { what: "Mia's Let wander" });
    const dog = (await petsOf(rem, mia.id))[0];
    await waitFor(async () => (await petsOf(rem, mia.id))[0]?.mode !== "follow", { what: "Mia's dog wandering on Rem's page" });
    // what the socialize mood sends; Mia's page also picks goals by its own moods, so say it until it shows
    let joined = false;
    await waitFor(async () => {
      await pluginFrame(mia).evaluate((goal) => window.hq.send({ t: "wander", g: [goal] }), cat.id);
      await sleep(250);
      return (joined = (await petsOf(rem, mia.id))[0]?.target === cat.id);
    }, { timeout: 8000, every: 50, what: "dog with the cat" }).catch(() => {});
    check("a pet can go along with another member's wandering pet, on the other pages too", joined && !!dog);
    await click(mia, ".topbar .plugin-slot", "Call pets");
    let tag = "";
    await waitFor(async () => ((tag = await hoverOn([mia, rem], rem.id, cat.id)) !== "" && tag !== "missing" && tag !== "covered"), { timeout: 8000, what: "hover tag" }).catch(() => {});
    check("while it wanders, the mouse over the pet shows its name and its owner", tag === "Biscuit\n(Rem" + t + ")", JSON.stringify(tag));
    await mia.page.mouse.move(5, 5);
    await rem.page.mouse.move(5, 5);
    await waitFor(() => rem.page.evaluate(() => document.querySelector(".topbar .plugin-slot")?.textContent === "Call pets"), { what: "the button now says Call" });
    // from the moment Mia's page knows it wanders
    const all = await strolling;
    const strolls = all.slice(Math.max(0, all.findIndex((x) => x[2] !== "follow")));
    const moved = strolls.some(([x, y], i) => i > 0 && Math.hypot(x - strolls[i - 1][0], y - strolls[i - 1][1]) > 0.5);
    const far = Math.max(...strolls.map(([x, y]) => Math.hypot(x - remAt.x, y - remAt.y)));
    // its mood decides how far: near home or its owner, or exploring up to 240 px from home
    check("a wandering pet walks on its own while its owner stands still, within its moods' reach", moved && far < 300 && strolls.every((x) => x[2] !== "follow"), `moved ${moved}, farthest ${far.toFixed(1)} px`);
    // Call: the pet walks back (around walls), it never jumps; recorded frame by frame on Mia's page
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
    await click(rem, ".topbar .plugin-slot", "Call pets");
    const callBack = await back;
    await waitFor(async () => (await creatureOf(mia, rem.id))?.mode === "follow", { what: "pet following again" });
    check("Call brings it back to following its owner, walking, never jumping", callBack.frames > 20 && callBack.maxJump < 12, JSON.stringify(callBack));

    // ---- assets from outside
    check("the plugin's server code is never served", (await fetch(`${API}/plugins/${PLUGIN}/assets/main.ts`)).status === 404 && (await fetch(`${API}/plugins/${PLUGIN}/assets/..%2Fmain.ts`)).status === 404 && (await fetch(`${API}/plugins/${PLUGIN}/main.ts`)).status === 404);
    check("its public/ files are", (await fetch(`${API}/plugins/${PLUGIN}/assets/pets.png`)).status === 200 && (await fetch(`${API}/plugins/${PLUGIN}/assets/pets-tint.png`)).status === 200);

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
    check("its assets answer 404", (await fetch(`${API}/plugins/${PLUGIN}/assets/pets.png`)).status === 404);

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

    // ---- a sprite sheet from image data: drawn-sheet (e2e/fixtures) paints its sheet on an OffscreenCanvas
    await fetch(API + "/api/admin/plugins/drawn-sheet", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify({ enabled: true }) });
    const drawnOf = (u, owner) => read(u, (id) => (window.__hq.session.plugins?.debug("drawn-sheet") ?? []).find((c) => c.player === id && c.visible) ?? null, owner);
    await waitFor(async () => (await drawnOf(mia, rem.id)) && (await drawnOf(rem, mia.id)), { timeout: 15000, what: "the drawn sprites" });
    check("a sheet the plugin drew and handed over as image data is drawn, following its member, on every page", true);
    check("image data that is not a picture is refused as an invalid sheet, and the plugin goes on", await read(mia, () => !window.__hq.session.plugins.stopReasons.get("drawn-sheet") && !!document.querySelector('iframe.plugin-frame[data-plugin="drawn-sheet"]')));
    await waitFor(() => mia.page.evaluate(() => { const b = document.querySelector('.side .tabs button[aria-label="Plugins"]'); if (b && b.getAttribute("aria-selected") !== "true") b.click(); return !!b; }), { what: "Plugins tab" });
    await waitFor(() => click(mia, ".plugins-panel button", "Drawn sheet"), { what: "Drawn sheet entry" });
    const previewDrawn = await waitFor(() => read(mia, () => {
      const c = document.querySelector('.modal.plugin-modal canvas.plugin-sprite');
      if (!c) return false;
      const px = c.getContext("2d").getImageData(8, 8, 1, 1).data;
      return px[3] > 0;
    }), { what: "the preview" }).catch(() => false);
    check("the modal previews a cell of that sheet (hq.ui.sprite with sheet)", previewDrawn);
    await mia.page.keyboard.press("Escape");
    // what its iframe may fetch: its own folder and the hosts its manifest declares, nothing else
    const drawnFrame = await (await mia.page.$('iframe.plugin-frame[data-plugin="drawn-sheet"]')).contentFrame();
    const blocked = await drawnFrame.evaluate(() => new Promise((resolve) => {
      const seen = [];
      document.addEventListener("securitypolicyviolation", (e) => seen.push(e.blockedURI));
      fetch("https://undeclared.example.net/sheet.png").catch(() => {});
      fetch("https://images.invalid/sheet.png").catch(() => {}); // declared; .invalid never resolves: no network
      setTimeout(() => resolve(seen), 800);
    }));
    check("its iframe may fetch from the hosts its manifest declares, and only those", blocked.some((u) => u.includes("undeclared.example.net")) && !blocked.some((u) => u.includes("images.invalid")), JSON.stringify(blocked));
    await fetch(API + "/api/admin/plugins/drawn-sheet", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify({ enabled: false }) });
    await waitFor(async () => !(await read(mia, () => !!document.querySelector('iframe.plugin-frame[data-plugin="drawn-sheet"]'))), { what: "drawn-sheet off" });

    // ---- every anchor, the modal widgets and app tokens, with the suite's test plugin (e2e/fixtures/plugins/installed/ui-demo)
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
    // expected on Mia's page: a 401 the test provokes, the fetch blocked by the CSP, and the declared .invalid host not resolving
    const real = (u) => u.logs.filter((l) => !(u === mia && (/status of 401/.test(l) || /undeclared\.example\.net|images\.invalid|ERR_NAME_NOT_RESOLVED/.test(l))));
    for (const u of [admin, mia, rem]) check(`${u.name}: no console errors`, real(u).length === 0, real(u).slice(0, 3).join(" | "));
    await Promise.all([admin, mia, rem].map((u) => u.ctx.close()));
  } catch (e) {
    check("scenario completed", false, String(e));
  } finally {
    await browser.close();
  }
  return summary();
}
