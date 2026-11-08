// Pets: the bundled hq-pets plugin (plugins/bundled/hq-pets) on the testbed, without LiveKit (e2e/plugin-run.ts), with two
// of the browser suite's fixture plugins that use its hooks (e2e/fixtures/plugins/installed/critters and drawn-pet).
// Turned on through Administration > Plugins, pets added, named, recoloured and removed in its modal (audited with
// axe) and following their owners on other pages, the office's limit behind the plugin's gear, its top-bar button
// (Let wander / Call), the hover tag, another plugin's pets through its hooks, and turning it off live.
// Rules and logic are tested lower: the gaps, moods and the modal's content in plugins/bundled/hq-pets/test/client.test.ts,
// the server side (adding, naming, the limit, malformed messages, guest pets through the hooks) in
// plugins/bundled/hq-pets/test/pets.ispec.ts, where the page puts a pet in web/test/petFollow.test.ts. The plugin host
// itself (iframe sandbox, a flooding plugin stopped, buttons at every anchor, views, objects, app tokens) is
// plugins/e2e/plugin-host-e2e/host.ts, with fixture plugins only.
// Run: node tools/fdash/cli.ts run test:e2e --pkg hq-pets-e2e (after "node tools/fdash/cli.ts run build --pkg server --pkg web").
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, sleep, API, type RunContext, type User } from "../../../e2e/lib.ts";
import { audit } from "../../../e2e/axe.ts";

/** What code evaluated in a plugin's hidden frame uses of its window: the SDK's hq (plugins/sdk/client.d.ts). */
type PluginWindow = { hq: { send(msg: unknown): void } };
/** What the plugin layer reports of one sprite a plugin drew (PluginManager.debug). */
type Creature = NonNullable<ReturnType<NonNullable<Window["__hq"]["session"]["plugins"]>["debug"]>>[number];
type Tile = { x: number; y: number };

const PLUGIN = "hq-pets";
/** Turns a plugin on or off through the admin API (the switch itself is used for hq-pets, below). */
const setPlugin = (ctx: RunContext, name: string, enabled: boolean) => fetch(API + "/api/admin/plugins/" + name, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify({ enabled }) });
const click = (u: User, selector: string, text: string) => u.page.evaluate((selector, text) => {
  const b = [...document.querySelectorAll<HTMLElement>(selector)].find((x) => x.textContent.trim() === text);
  b?.click();
  return !!b;
}, selector, text);
const read = <R, A>(u: User, fn: (arg: A) => R, arg?: A): Promise<Awaited<R>> => u.page.evaluate(fn as (arg: unknown) => R, arg);
/** What the plugin drew on that page, or null when it does not run there. */
const creatures = (u: User) => read(u, (p: string) => window.__hq.session.plugins?.debug(p) ?? null, PLUGIN);
const creatureOf = async (u: User, owner: number) => ((await creatures(u)) ?? []).find((c) => c.player === owner);
const frames = (u: User) => read(u, () => document.querySelectorAll("iframe.plugin-frame").length);
const pluginFrame = (u: User) => u.page.frames().find((f) => f.url() === "about:srcdoc");
const petsOf = async (u: User, owner: number) => ((await creatures(u)) ?? []).filter((c) => c.player === owner);
/** One of owner's pets by its sheet key: n<kind> in its own colours, t<kind> tinted. */
const pet = async (u: User, owner: number, key: string) => (await petsOf(u, owner)).find((c) => c.key === key);
const modalHas = (u: User, text: string) => u.page.evaluate((text) => [...document.querySelectorAll(".modal.plugin-modal button, .modal.plugin-modal p")].some((x) => x.textContent === text), text);
/** Puts text in a field of the plugin's modal with the keyboard, then Enter. */
async function setField(u: User, selector: string, text: string) {
  const sel = ".modal.plugin-modal " + selector;
  await waitFor(() => u.page.$(sel), { what: selector });
  await u.page.focus(sel);
  await u.page.evaluate((sel) => document.querySelector<HTMLInputElement>(sel)!.select(), sel);
  await u.page.keyboard.type(text);
  await u.page.keyboard.press("Enter");
}
/** Moves the real mouse over one of owner's pets on u's page, and reads the hover tag. */
async function hoverOver(u: User, owner: number, sprite: string): Promise<string> {
  const c = (await petsOf(u, owner)).find((x) => x.id === sprite);
  if (!c) return "missing";
  const at = await read(u, ({ x, y }: { x: number; y: number }) => window.__hq.view.pageOf(x, y - 8), { x: c.x, y: c.y });
  // a pet under the top bar or off the canvas cannot be pointed at on this page (CI's 800x450 view)
  if (!(await u.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName === "CANVAS", at))) return "covered";
  await u.page.mouse.move(at.x, at.y);
  // a wandering pet keeps walking: read the tag on the next frames, before it walks out from under the mouse
  return read(u, () => new Promise<string>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.__hq.view.hoverText())))));
}
/** hoverOver on the first of these pages where the pet is in view. */
async function hoverOn(pages: User[], owner: number, sprite: string) {
  let tag = "covered";
  for (const u of pages) if ((tag = await hoverOver(u, owner, sprite)) !== "covered") break;
  return tag;
}
async function openPets(u: User) {
  await waitFor(() => u.page.evaluate(() => {
    const b = document.querySelector<HTMLElement>('.side .tabs button[aria-label="Plugins"]');
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

async function setEnabled(admin: User, on: boolean, title = "Pets", plugin = PLUGIN) {
  await waitFor(() => click(admin, ".topbar button", "Admin"), { what: "Admin button" });
  await waitFor(() => click(admin, ".modal [role=tab]", "Plugins"), { what: "Plugins tab" });
  const label = (on ? "Turn on " : "Turn off ") + title;
  await waitFor(() => admin.page.evaluate((l) => { const b = document.querySelector<HTMLElement>(`.modal button[aria-label="${l}"]`); b?.click(); return !!b; }, label), { what: label });
  await waitFor(() => admin.page.evaluate((s) => document.querySelector(`.modal tr[data-plugin="${s[1]}"]`)?.textContent!.includes(s[0]), [on ? "Running" : "Off", plugin]), { what: "plugin state " + (on ? "running" : "off") });
  await admin.page.keyboard.press("Escape");
}

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  try {
    // the testbed starts with every plugin it was given turned on: off first, so the switch turns hq-pets on below
    for (const name of [PLUGIN, "critters", "drawn-pet"]) {
      const r = await setPlugin(ctx, name, false);
      if (!r.ok) throw new Error(`turning ${name} off: ${r.status} ${await r.text()}`);
    }
    const t = String(Date.now() % 10000);
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    const mia = await joinAs(browser, "Mia" + t);
    const rem = await joinAs(browser, "Rem" + t);
    // social area, open floor (see movement.ts)
    await walkTo(mia, 8 * 16 + 8, 31 * 16 + 8);
    await walkTo(rem, 8 * 16 + 8, 28 * 16 + 8);
    check("with the plugin off, no page runs plugin code", (await frames(mia)) === 0 && (await frames(rem)) === 0);

    // ---- enable through the admin dialog
    await waitFor(() => click(admin, ".topbar button", "Admin"), { what: "Admin button" });
    await waitFor(() => click(admin, ".modal [role=tab]", "Plugins"), { what: "Plugins tab" });
    await waitFor(() => admin.page.$('.modal tr[data-plugin="hq-pets"]'), { what: "hq-pets row" });
    check("the admin dialog lists the bundled pets plugin as off", await admin.page.evaluate(() => document.querySelector('.modal tr[data-plugin="hq-pets"]')!.textContent.includes("Off")));
    // (where each row says it comes from, and an installed hq- plugin refused without a switch: web/test/AdminPlugins.test.tsx
    // and TestPluginNameRefusalNoRoutes; enabling in the activity log: TestEnablePluginEndToEnd)
    await admin.page.keyboard.press("Escape");
    await setEnabled(admin, true);
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
    const [cat, seedling] = await Promise.all([pet(mia, rem.id, "n0"), pet(mia, rem.id, "n8")]) as [Creature, Creature];
    check("a member can have several pets, of any kind including the seedling", !!cat && !!seedling, JSON.stringify((await petsOf(mia, rem.id)).map((c) => c.key)));
    // accessibility, the modal with two pets (each a row of name, colour and Remove) and its Add buttons: the modal
    // only, the side panel and the rest of the page are the platform's (plugin-host-e2e's host.ts, e2e's a11y)
    await waitFor(() => modalHas(rem, "Add a pet (2 of 3)"), { what: "modal redrawn with two pets" });
    await audit(rem.page, "the Pets modal with two pets", '.modal.plugin-modal[aria-label="Pets"]');
    await rem.page.keyboard.press("Escape");
    await waitFor(async () => !(await rem.page.$(".modal.plugin-modal")), { what: "modal closed by Escape" });
    check("Escape closes the plugin's modal", true);
    await openPets(mia);
    await waitFor(() => click(mia, ".modal.plugin-modal button", "Dog"), { what: "Mia's Dog button" });
    await waitFor(async () => (await petsOf(rem, mia.id)).length === 1 && (await petsOf(rem, rem.id)).length === 2, { what: "pets on Rem's page" });
    check("each page shows every member's pets, mine included", true);
    // (the modal has no office setting: hq-pets/test/client.test.ts)
    await mia.page.keyboard.press("Escape");

    // ---- the pets walk behind their owner in a line, recorded on the observer's page: the gaps the plugin asks for
    // (hq-pets/test/client.test.ts) and how the page keeps one (web/test/petFollow.test.ts) are unit-tested, but
    // only here does the gap travel from the plugin through pluginLayer to what is drawn (a pet once shipped glued
    // to its owner). Rem walks east, which also lets the walk-to below run far enough to judge it
    const rec = read(mia, ({ id, plugin, a, b }: { id: number; plugin: string; a: string; b: string }) => new Promise<number[][]>((resolve) => {
      const out: number[][] = [];
      const t0 = performance.now();
      const tick = (now: number) => {
        const e = window.__hq.view.ents.get(id);
        const list = window.__hq.session.plugins!.debug(plugin)!;
        const ca = list.find((x) => x.id === a), cb = list.find((x) => x.id === b);
        if (e && ca && cb) out.push([now - t0, e.x, e.y, ca.x, ca.y, cb.x, cb.y]);
        if (now - t0 < 2600) requestAnimationFrame(tick); else resolve(out);
      };
      requestAnimationFrame(tick);
    }), { id: rem.id, plugin: PLUGIN, a: cat.id, b: seedling.id });
    await read(rem, async () => {
      const v = window.__hq.view, wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      await wait(200);
      v.setDirection(1, 0); await wait(1600);
      v.setDirection(0, 0);
    });
    const S = await rec;
    const ga: number[] = [], gb: number[] = [];
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
    const med = (l: number[]) => l.sort((x, y) => x - y)[Math.floor(l.length / 2)];
    const [ma, mb] = [med(ga), med(gb)];
    check("while the owner walks, the first pet keeps about 20 px behind and the next one about 36 px", ga.length > 10 && ma > 14 && ma < 28 && mb > 28 && mb < 44, `medians ${ma?.toFixed(1)} and ${mb?.toFixed(1)} px over ${ga.length} frames`);
    check("no pet walks on top of its owner", closest > 12, `closest ${closest.toFixed(1)} px`);

    // ---- a walk-to (double-click on the map, Cmd+D, joining someone): the server runs the owner there,
    // and the pets run after them on every page: smoothly, every frame, with their walk animation (they
    // used to sit still, then hop after an owner moved only at the server's 15 Hz). A browser drawing
    // under 15 fps (CI's software renderer) sees a server move on nearly every frame even in hops, so
    // there the owner's pace is judged too: a smooth run covers ground in step with the time between
    // frames. Above it, hops show as still frames: at f fps, 15 Hz moves leave 1 - 15/f of the frames
    // still, and the still bound (10 %) rejects that from 16.7 fps; the pace is judged only while hops
    // would leave under 15 % still (under 17.6 fps), since frame jitter on a busy runner moves the pace
    // more than hops would at higher rates (CI has measured 9 of 52 frames off pace at 49 fps, and
    // 5 of 21 just under 20 fps, with no still frame).
    const runAfter = (u: User) => read(u, ({ plugin, owner, ms }: { plugin: string; owner: number; ms: number }) => new Promise<{ max: number; frames: number; ownerStill: number; petStill: number; uneven: number; span: number; fps: number }>((resolve) => {
      const last = new Map<string | number, number[]>();
      let max = 0, frames = 0, ownerStill = 0, petStill = 0, since = 0, prev = 0, span = 0;
      const paces: number[] = [];
      const t0 = performance.now();
      const tick = (now: number): void | number => {
        const v = window.__hq.view, e = v.ents.get(owner)!;
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
        for (const c of window.__hq.session.plugins!.debug(plugin)!.filter((x) => x.player === owner && x.visible)) {
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
    const arrived = await read(rem, () => { const e = window.__hq.view.ents.get(window.__hq.view.meId)!; return [e.x, e.y]; });
    check("a double-click on the map runs the owner there", Math.hypot(arrived[0] - (4 * 16 + 8), arrived[1] - (27 * 16 + 8)) < 12, JSON.stringify(arrived));
    const say = (r: typeof jr) => `${r.ownerStill} still owner frames, ${r.uneven} off its pace, ${r.petStill} still pet frames of ${r.frames} (${r.fps.toFixed(0)} fps over ${(r.span / 1000).toFixed(1)} s), largest pet step ${r.max.toFixed(1)} px`;
    check("on a walk-to the owner's own avatar runs smoothly, moving every frame (not in 15 Hz hops)", jr.frames >= 8 && jr.span >= 600 && jr.ownerStill <= jr.frames * 0.1 && (1 - 15 / jr.fps >= 0.15 || jr.uneven <= jr.frames * 0.2), say(jr));
    check("its pets run after it every frame with their walk animation, on the owner's page and on others, never jumping",
      jr.frames >= 8 && jm.frames >= 8 && jr.span >= 600 && jm.span >= 600 && jr.petStill <= jr.frames * 0.05 && jm.petStill <= jm.frames * 0.05 && jr.max < 24 && jm.max < 24, `owner's page: ${say(jr)}; other page: ${say(jm)}`);

    // ---- render on demand still holds with pets standing
    await sleep(1500);
    const draws = await read(mia, () => new Promise<number>((resolve) => {
      const v = window.__hq.view, r0 = v.rendersTotal;
      setTimeout(() => resolve(v.rendersTotal - r0), 3000);
    }));
    // resting pets potter about (a short stroll every 5-10 s each): the page redraws while one walks, not all the time
    check("an idle page with pottering pets does not redraw continuously", draws <= 120, `${draws} draws in 3 s`);
    // (at rest the pets potter within 28 px of their owner's feet, 12 px above or below: hq-pets/test/client.test.ts
    // for what the plugin asks, web/test/petFollow.test.ts for where the page puts them)

    // ---- a name and a colour per pet, through the modal's fields
    await openPets(rem);
    await setField(rem, 'input[type="text"]', "Biscuit");
    await waitFor(async () => (await pet(mia, rem.id, "n0"))?.label === null && (await read(rem, () => document.querySelector<HTMLInputElement>('.modal.plugin-modal input[type="text"]')?.value === "Biscuit")), { what: "the name kept in the redrawn modal" });
    check("naming a pet in the modal is kept (redrawn with it)", true);
    const picked = await read(rem, () => {
      const input = document.querySelector<HTMLInputElement>('.modal.plugin-modal input[type="color"]');
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
      const b = [...document.querySelectorAll<HTMLElement>(".modal.plugin-modal button")].filter((x) => x.textContent === "Remove")[1];
      b?.click();
      return !!b;
    }), { what: "Remove button" });
    await waitFor(async () => (await petsOf(mia, rem.id)).length === 1, { what: "seedling removed on Mia's page" });
    check("removing a pet takes that one away and leaves the other as it was", (await petsOf(mia, rem.id))[0]?.id === cat.id);
    await rem.page.keyboard.press("Escape");

    // ---- the office's limit: the plugin's setting, in Administration > Plugins
    const setLimit = async (n: number) => {
      await waitFor(() => click(admin, ".topbar button", "Admin"), { what: "Admin button" });
      await waitFor(() => click(admin, ".modal [role=tab]", "Plugins"), { what: "Plugins tab" });
      await waitFor(() => admin.page.evaluate(() => { const b = document.querySelector<HTMLElement>('.modal button[aria-label="Settings of Pets"]'); b?.click(); return !!b; }), { what: "the gear button" });
      const sel = `.modal .plugin-setting input`;
      await waitFor(() => admin.page.$(sel), { what: "the limit field" });
      const before = await read(admin, (sel: string) => document.querySelector<HTMLInputElement>(sel)!.value, sel);
      await admin.page.focus(sel);
      await admin.page.evaluate((sel) => document.querySelector<HTMLInputElement>(sel)!.select(), sel);
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
    // (changing it is in the activity log: TestPluginSettingsFromTheAdminDialog)

    // ---- another plugin's pet through the pets plugin's hooks: critters (e2e/fixtures/plugins/installed), called by an app
    // outside the browser with Rem's app token, draws a critter that the pets plugin walks for Rem
    await setPlugin(ctx, "critters", true);
    const critterToken = await waitFor(() => read(rem, () => fetch("/api/plugins/critters/token", { method: "POST" }).then((r) => r.ok ? (r.json() as Promise<{ token?: string }>) : null).then((j) => j?.token)), { what: "a critters token" });
    const petCall = (path: string, body: string) => fetch(`${API}/plugins/critters/api/${path}`, { method: "POST", headers: { Authorization: "Bearer " + critterToken }, body });
    const put = (await (await petCall("pet", "Bramble")).json()) as { ok?: boolean };
    await waitFor(async () => (await petsOf(mia, rem.id)).some((c) => c.key.startsWith("g") && c.visible), { what: "the critter on Mia's page" });
    check("another plugin puts a pet of its own drawing with the member whose token it served, and it follows them", put.ok === true, JSON.stringify(put));
    // (that pet is not in the Pets modal and does not count in the limit: hq-pets/test/client.test.ts, pets.ispec.ts)
    const gone = (await (await petCall("unpet", "")).json()) as { removed?: boolean };
    await waitFor(async () => !(await petsOf(mia, rem.id)).some((c) => c.key.startsWith("g")), { what: "the critter gone" });
    check("the plugin that put it takes it away", gone.removed === true);
    await setPlugin(ctx, "critters", false);

    // ---- a guest pet whose sheet its plugin draws on each page: drawn-pet (e2e/fixtures/plugins/installed) gives one by
    // metadata (setPet without a sheet) and provides its sheet from an OffscreenCanvas (hq.provideSheet)
    await setPlugin(ctx, "drawn-pet", true);
    const drawnPet = (u: User, owner: number) => read(u, (id: string) => (window.__hq.session.plugins?.debug("hq-pets") ?? []).find((c) => c.id.startsWith(id + ":x:drawn-pet:") && c.visible) ?? null, String(owner));
    // left out, not only hidden: no place behind its owner, nobody to go along with
    const leftOut = (u: User, owner: number) => read(u, (id: string) => !(window.__hq.session.plugins?.debug("hq-pets") ?? []).some((c) => c.id.startsWith(id + ":x:drawn-pet:")), String(owner));
    const dp = await waitFor(async () => (await drawnPet(mia, rem.id)) ?? false, { timeout: 15000, what: "Rem's drawn pet on Mia's page" }).catch(() => null);
    check("a guest pet put by metadata is drawn by its plugin on every page and follows its owner like a pet", dp?.mode === "follow" && dp?.player === rem.id, JSON.stringify(dp));
    const drawnPetOn = (enabled: boolean) => setPlugin(ctx, "drawn-pet", enabled);
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
      const v = window.__hq.view, me = v.ents.get(v.meId)!, T = 16;
      const free = (x: number, y: number) => { for (let r = 16; r <= 64; r += 16) for (let a = 0; a < 16; a++) if (!v.canStandStatic(x + Math.cos(a * Math.PI / 8) * r, y + Math.sin(a * Math.PI / 8) * r)) return false; return v.canStandStatic(x, y); };
      let best: { x: number; y: number; d: number; at: { x: number; y: number } } | null = null;
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
      await waitFor(() => read(rem, ({ x, y }: Tile) => { const v = window.__hq.view, e = v.ents.get(v.meId)!; return !v.guided && Math.hypot(e.x - x, e.y - y) < 12; }, open), { timeout: 15000, what: "Rem on open floor" }).catch(() => {});
      await sleep(600); // the pets settle behind Rem
    }
    // the cat's walks are recorded on Mia's page from the moment it is let go: its first one starts within
    // 2 s; the recording goes on until it walked (up to 25 s: a spot it cannot reach costs it one pause). How far
    // its moods take it, and that it never goes back behind its owner: hq-pets/test/client.test.ts
    const strolling = read(mia, ({ id, plugin }: { id: string; plugin: string }) => new Promise<[number, number, string][]>((resolve) => {
      const seen: [number, number, string][] = [];
      const t0 = performance.now();
      const tick = () => {
        const c = window.__hq.session.plugins!.debug(plugin)!.find((x) => x.id === id);
        if (c && (seen.length || c.mode !== "follow")) seen.push([c.x, c.y, c.mode]); // from the moment it wanders
        const moved = seen.some(([x, y], i) => i > 0 && Math.hypot(x - seen[i - 1][0], y - seen[i - 1][1]) > 0.5);
        if (!moved && performance.now() - t0 < 25000) setTimeout(tick, 100); else resolve(seen);
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
      await pluginFrame(mia)!.evaluate((goal) => (window as unknown as PluginWindow).hq.send({ t: "wander", g: [goal] }), cat.id);
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
    const strolls = await strolling;
    const moved = strolls.some(([x, y], i) => i > 0 && Math.hypot(x - strolls[i - 1][0], y - strolls[i - 1][1]) > 0.5);
    check("a wandering pet walks on its own while its owner stands still, on another member's page", moved && strolls.every((x) => x[2] !== "follow"), `moved ${moved} over ${strolls.length} samples`);
    // Call: the pet walks back (around walls), it never jumps; recorded frame by frame on Mia's page
    const back = read(mia, ({ id, plugin }: { id: number; plugin: string }) => new Promise<{ maxJump: number; frames: number; mode: string | undefined }>((resolve) => {
      let prev: Tile | null = null, maxJump = 0, frames = 0;
      const t0 = performance.now();
      const tick = (now: number) => {
        const c = window.__hq.session.plugins!.debug(plugin)!.find((x) => x.player === id);
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

    // ---- turned off through its switch: its code, pets and button leave every page without a reload (the
    // host's side of it, with a fixture plugin, in plugin-host-e2e's host.ts)
    await setEnabled(admin, false);
    await waitFor(async () => (await frames(mia)) === 0 && (await frames(rem)) === 0, { what: "iframes removed" });
    await waitFor(async () => (await creatures(mia)) === null && (await creatures(rem)) === null, { what: "pets removed" });
    check("turning Pets off removes its code and every pet from every page without a reload", true);
    check("and its button, and the side panel's Plugins tab", await read(rem, () => !document.querySelector(".topbar .plugin-slot") && !document.querySelector('.side .tabs button[aria-label="Plugins"]')));
    for (const u of [admin, mia, rem]) check(`${u.name}: no console errors`, u.logs.length === 0, u.logs.slice(0, 3).join(" | "));
    await Promise.all([admin, mia, rem].map((u) => u.ctx.close()));
  } catch (e) {
    check("scenario completed", false, String(e));
  } finally {
    await browser.close();
  }
  return summary();
}
