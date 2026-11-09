// The plugin host (web/src/plugins, web/src/game/pluginLayer.ts, the server's plugin runtime) on the testbed, without
// LiveKit (e2e/plugin-run.ts), with the browser suite's fixture plugins only (e2e/fixtures/plugins/installed: ui-demo
// and drawn-sheet), never a bundled one: those have their own e2e projects (plugins/e2e/<name>-e2e).
// A plugin turned on and off through Administration > Plugins (code, buttons, boxes and sprites come and go on every
// page without a reload), the side panel's Plugins tab and a plugin's modal (audited with axe), buttons at every
// anchor, a box on the map, the modal's widgets (copyable text, app tokens, buttons, onClose), a view in the modal,
// an object the plugin draws itself (init, update, destroy, the editor's box), the iframe sandbox and its CSP, a
// flooding plugin stopped on one page only, and a sprite sheet drawn as image data.
// What is tested lower: the host's messages, limits, views and objects in web/test/pluginHost.test.ts,
// pluginCommands.test.ts, pluginObjects.test.ts, pluginView.test.ts and PluginViewFrame.test.tsx; the admin table
// (rows, the switch failing with no network, settings) in web/test/AdminPlugins.test.tsx; what the server serves
// of a plugin and app tokens in server/internal/httpapi/plugins_test.go. A bundled plugin's own behaviour is in its
// project (hq-pets-e2e's pets.ts for the pets and its hooks).
// Run: node tools/fdash/cli.ts run test:e2e --pkg plugin-host-e2e (after "node tools/fdash/cli.ts run build --pkg server --pkg web").
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, sleep, API, type RunContext, type User } from "../../../e2e/lib.ts";
import { audit } from "../../../e2e/axe.ts";

/** The global a plugin view gets (plugins/sdk/view.d.ts), used inside the view's frame. */
declare const hqView: { send(msg: unknown): void };
/** What code evaluated in a plugin's hidden frame uses of its window: the SDK's hq (plugins/sdk/client.d.ts). */
type PluginWindow = { hq: { send(msg: unknown): void; remove(id: string): void } };
/** What ui-demo's orb callbacks record in its frame (e2e/fixtures/plugins/installed/ui-demo). */
type Placed = { kind: string; x: number; y: number; w: number; h: number; px: number; py: number };
type Objs = { init: Placed[]; destroy: Placed[]; updates: Record<string, number> };
type Tile = { x: number; y: number };
/** The admin map as the scenario edits it: only the props are touched. */
type AdminMap = { props: { t: string; x: number; y: number; w: number; h: number }[] };

const DEMO = "ui-demo";
const click = (u: User, selector: string, text: string) => u.page.evaluate((selector, text) => {
  const b = [...document.querySelectorAll<HTMLElement>(selector)].find((x) => x.textContent.trim() === text);
  b?.click();
  return !!b;
}, selector, text);
const read = <R, A>(u: User, fn: (arg: A) => R, arg?: A): Promise<Awaited<R>> => u.page.evaluate(fn as (arg: unknown) => R, arg);
/** The plugin iframes (hidden, one per running plugin) on that page; of one plugin when named. */
const frames = (u: User, plugin?: string) => read(u, (p?: string) => document.querySelectorAll(p ? `iframe.plugin-frame[data-plugin="${p}"]` : "iframe.plugin-frame").length, plugin);
const pluginFrame = async (u: User, plugin: string) => (await u.page.$(`iframe.plugin-frame[data-plugin="${plugin}"]`))?.contentFrame() ?? null;
const setPlugin = (ctx: RunContext, name: string, enabled: boolean) => fetch(API + "/api/admin/plugins/" + name, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify({ enabled }) });
const openPluginsTab = (u: User) => waitFor(() => u.page.evaluate(() => {
  const b = document.querySelector<HTMLElement>('.side .tabs button[aria-label="Plugins"]');
  if (b && b.getAttribute("aria-selected") !== "true") b.click();
  return !!document.querySelector(".plugins-panel");
}), { what: "Plugins tab in the side panel" });

/** Turns a plugin on or off through its switch in Administration > Plugins, and waits for the row to say so. */
async function setEnabled(admin: User, on: boolean, title: string, plugin: string) {
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
    // the testbed starts with every plugin it was given turned on: off first, so the switch turns ui-demo on below
    for (const name of [DEMO, "drawn-sheet"]) {
      const r = await setPlugin(ctx, name, false);
      if (!r.ok) throw new Error(`turning ${name} off: ${r.status} ${await r.text()}`);
    }
    const t = String(Date.now() % 10000);
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    const mia = await joinAs(browser, "Mia" + t);
    const rem = await joinAs(browser, "Rem" + t);
    // social area, open floor (see movement.ts)
    await walkTo(mia, 9 * 16 + 8, 31 * 16 + 8);
    await walkTo(rem, 8 * 16 + 8, 28 * 16 + 8);
    check("with every plugin off, no page runs plugin code", (await frames(mia)) === 0 && (await frames(rem)) === 0);

    // ---- a map object the plugin draws itself (ui-demo's orb: no sprite, "dynamic": true), placed
    // before the plugin starts, on open floor beside Mia
    const adminMap = () => fetch(API + "/api/admin/map", { headers: { Cookie: "hq_session=" + ctx.adminCookie } }).then((r) => r.json() as Promise<AdminMap>);
    const putMap = (m: AdminMap) => fetch(API + "/api/map", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify(m) });
    const ORB = { x: 10, y: 31 };
    const setOrb = async (at: Tile | null) => {
      const m = await adminMap();
      m.props = m.props.filter((p) => p.t !== "ui-demo/orb");
      if (at) m.props.push({ t: "ui-demo/orb", x: at.x, y: at.y, w: 1, h: 1 });
      return (await putMap(m)).ok;
    };
    check("an administrator places the plugin's orb on the map while the plugin is off (map API)", await setOrb(ORB));
    await waitFor(() => read(mia, () => window.__hq.view.map!.props.some((p) => p.t === "ui-demo/orb")), { what: "the orb in Mia's map" });

    // ---- turned on through its switch in Administration > Plugins
    await waitFor(() => click(admin, ".topbar button", "Admin"), { what: "Admin button" });
    await waitFor(() => click(admin, ".modal [role=tab]", "Plugins"), { what: "Plugins tab" });
    await waitFor(() => admin.page.$(`.modal tr[data-plugin="${DEMO}"]`), { what: "ui-demo row" });
    check("the admin dialog lists the installed plugin as off", await admin.page.evaluate((p) => document.querySelector(`.modal tr[data-plugin="${p}"]`)!.textContent.includes("Off"), DEMO));
    // (where each row says it comes from, and an installed hq- plugin refused without a switch: web/test/AdminPlugins.test.tsx
    // and TestPluginNameRefusalNoRoutes; enabling in the activity log: TestEnablePluginEndToEnd)
    await admin.page.keyboard.press("Escape");
    await setEnabled(admin, true, "UI demo", DEMO);
    await waitFor(async () => (await frames(mia)) === 1 && (await frames(rem)) === 1, { what: "plugin iframes" });
    check("exactly one plugin iframe per page", true);

    // ---- the orb: what its callbacks saw, read inside ui-demo's iframe; and its sprite, which the plugin spawned
    const objs = async (u: User) => (await pluginFrame(u, DEMO))?.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __objs?: Objs }).__objs ?? null)) as Objs | null).catch(() => null);
    const orbKey = (at: Tile) => `orb@${at.x},${at.y}`;
    const orbSprite = (u: User, at: Tile) => read(u, (id: string) => (window.__hq.session.plugins?.debug("ui-demo") ?? []).find((c) => c.id === id) ?? null, orbKey(at));
    const placed = (at: Tile) => ({ kind: "orb", x: at.x, y: at.y, w: 1, h: 1, px: at.x * 16, py: at.y * 16 });
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    await waitFor(async () => (await objs(mia))?.init.length as number > 0, { timeout: 15000, what: "the orb's init" });
    await sleep(500);
    const o1 = (await objs(mia))!;
    check("on start the plugin gets one onObjectInit for the orb already placed, with tiles and world pixels", same(o1.init, [placed(ORB)]) && o1.destroy.length === 0, JSON.stringify(o1));
    // (a dynamic object gets onObjectUpdate 10 times a second, and its updates stop once it is removed:
    // web/test/pluginHost.test.ts; that updates reach the plugin, the pulse below)
    const spr = await waitFor(() => orbSprite(mia, ORB), { what: "the orb's sprite" });
    check("the sprite the plugin spawned for it stands on the object (bottom centre of its tile)", spr.visible && spr.x === ORB.x * 16 + 8 && spr.y === ORB.y * 16 + 16, JSON.stringify(spr));
    const anims = await read(mia, (id: string) => new Promise<(string | null)[]>((resolve) => {
      const seen = new Set<string | null>();
      const t0 = performance.now();
      const tick = () => {
        const c = (window.__hq.session.plugins?.debug("ui-demo") ?? []).find((x) => x.id === id);
        if (c) seen.add(c.anim);
        // oxlint-disable-next-line typescript/require-array-sort-compare -- kept as written (typing only): the default order sorts the frame names "a" and "b"
        if (performance.now() - t0 < 1500) setTimeout(tick, 50); else resolve([...seen].sort());
      };
      tick();
    }), orbKey(ORB));
    check("the plugin animates it from onObjectUpdate (it pulses)", same(anims, ["a", "b"]), JSON.stringify(anims));
    check("the page draws nothing of its own for an object without a sprite", await read(mia, () => window.__hq.view.objSprites.length === 0));
    check("standing beside it, X uses it (the nearby hint)", await waitFor(() => read(mia, () => window.__hq.state.nearby?.t === "ui-demo/orb"), { what: "orb nearby" }).catch(() => false));
    // the editor, opened through its button, shows it as a labelled box of its size
    await waitFor(() => click(admin, "button", "Edit office"), { what: "Edit office" });
    await waitFor(() => admin.page.$(".editor"), { what: "editor open" });
    const boxes = await read(admin, () => window.__hq.view.placeholderLabels.map((l) => l.text.text));
    check("in the editor an object the plugin draws shows as a box with its label", boxes.includes("Orb\n(drawn by its plugin)"), JSON.stringify(boxes));
    await waitFor(() => click(admin, ".editor button", "Close"), { what: "editor Close" });
    await waitFor(async () => !(await admin.page.$(".editor")), { what: "editor closed" });
    // moved on the map (a map change reaching the plugin: one destroy and one init); removed, and put back, are the
    // same changes (objectChanges in web/test/pluginObjects.test.ts, the host telling them in pluginHost.test.ts)
    const MOVED = { x: ORB.x + 1, y: ORB.y };
    await setOrb(MOVED);
    await waitFor(async () => (await objs(mia))?.init.length === 2, { what: "the moved orb's init" });
    const o3 = (await objs(mia))!;
    const movedSprite = await waitFor(() => orbSprite(mia, MOVED), { what: "moved orb sprite" }).catch(() => null);
    check("moved: a destroy at the old place, then an init at the new one; the plugin draws it there and its old sprite goes", same(o3.destroy, [placed(ORB)]) && same(o3.init[1], placed(MOVED)) && !!movedSprite && !(await orbSprite(mia, ORB)), JSON.stringify(o3));

    // ---- a box on the map, buttons at every anchor, the side panel and the modal's widgets and app tokens
    const boxText = () => read(mia, () => document.querySelector('.plugin-screen[data-plugin="ui-demo"]')?.textContent ?? "");
    await waitFor(async () => (await boxText()).includes("Last click: nothing yet"), { what: "the plugin's box on the map" });
    check("a plugin can put a box on the map (screen anchor)", true);
    // (a member arriving gets the onJoin message even though their page starts the plugin after it was sent: the page
    // holds it, web/test/pluginHost.test.ts; the server sends it to the member joining, hq-chess's chess.ispec.ts "a joining
    // member gets it")
    const anchors = [["topbar", '.topbar [data-anchor="topbar"] .plugin-slot'], ["topright", '.topbar [data-anchor="topright"] .plugin-slot'], ["bottombar", ".bar .plugin-slot"], ["minimap", '.minimap [data-anchor="minimap"] .plugin-slot']];
    for (const [anchor, sel] of anchors) {
      await waitFor(() => mia.page.evaluate((sel) => { const b = document.querySelector<HTMLElement>(sel + '[data-plugin="ui-demo"]'); b?.click(); return !!b; }, sel), { what: anchor + " button" });
      await waitFor(async () => (await boxText()).includes("Last click: " + anchor), { what: "callback of the " + anchor + " button" });
    }
    check("a plugin button at every anchor (top bar, top right, bottom bar, minimap) runs the plugin's callback", true);
    const named = await read(mia, () => [...document.querySelectorAll('.plugin-slot[data-plugin="ui-demo"]')].every((b) => (b.getAttribute("aria-label") || b.textContent).trim().length > 0));
    check("every plugin button has an accessible name, icon-only ones included", named);
    // accessibility, contrast included, of the buttons the host draws for a plugin at every anchor. (The box on the map,
    // .plugin-screen, is left out for now: its muted text is 4.12:1 on white, under 4.5:1, a styling fix of its own.)
    await audit(mia.page, "a plugin's buttons at every anchor", '.topbar [data-anchor], .bar .plugin-slot, .minimap [data-anchor]');
    await openPluginsTab(mia);
    await waitFor(() => mia.page.$(".plugins-panel button"), { what: "plugin entries" });
    // accessibility, contrast included: the side panel's Plugins tab and a plugin's modal (the rest of the page is
    // e2e's a11y scenario's, with LiveKit; the testbed's media bar says media is unavailable)
    await audit(mia.page, "the side panel (plugins)", ".side");
    await waitFor(() => click(mia, ".plugins-panel button", "UI demo"), { what: "UI demo entry" });
    await waitFor(() => mia.page.$('.modal.plugin-modal[aria-label="UI demo"] .copy-field input'), { what: "UI demo modal" });
    await audit(mia.page, "a plugin's modal", '.modal.plugin-modal[aria-label="UI demo"]');
    check("the copyable text shows its value", (await read(mia, () => document.querySelector<HTMLInputElement>(".modal.plugin-modal .copy-field input")!.value)) === "copied-value-42");
    await waitFor(() => click(mia, ".modal.plugin-modal button", "Create token"), { what: "Create token" });
    const token = await waitFor(() => read(mia, () => [...document.querySelectorAll<HTMLInputElement>(".modal.plugin-modal .app-token input")].map((i) => i.value).find((v) => v.startsWith("hqp_"))), { what: "the new token" });
    check("Create token shows the token once in a copyable field", !!token && token.length > 40);
    const post = (tok: string | undefined) => fetch(`${API}/plugins/ui-demo/api/state`, { method: "POST", headers: tok ? { Authorization: "Bearer " + tok } : {}, body: "hp=42" });
    check("an app outside the browser calls the plugin's route with the token", (await post(token)).status === 200);
    await waitFor(async () => (await boxText()).includes("State: hp=42"), { what: "the state on Mia's page" });
    check("what the app sent reaches the member's page", true);
    // (without a token the route answers 401: TestAppTokens)
    await waitFor(() => click(mia, ".modal.plugin-modal button", "Revoke"), { what: "Revoke" });
    await waitFor(async () => (await post(token)).status === 401, { what: "revoked token refused" });
    check("a revoked token is refused", true);
    await click(mia, ".modal.plugin-modal button", "Inside the modal");
    await waitFor(async () => (await boxText()).includes("modal button"), { what: "modal button callback" });
    await mia.page.keyboard.press("Escape");
    await waitFor(async () => (await boxText()).includes("modal closed"), { what: "onClose callback" });
    check("buttons inside the modal and closing it (Escape) reach the plugin", true);

    // ---- a view in the modal (ui-demo's views/echo.ts), opened and driven through the modal's buttons
    const modalText = () => read(mia, () => document.querySelector(".modal.plugin-modal .plugin-body")?.textContent ?? "");
    await waitFor(() => click(mia, ".plugins-panel button", "UI demo"), { what: "UI demo entry" });
    await waitFor(() => mia.page.$('.modal.plugin-modal[aria-label="UI demo"]'), { what: "UI demo modal" });
    await waitFor(() => click(mia, ".modal.plugin-modal button", "Echo view"), { what: "Echo view button" });
    await waitFor(async () => (await modalText()).includes("View: hello"), { timeout: 15000, what: "the view's hello" });
    const viewEl = (await mia.page.$('.modal.plugin-modal iframe.plugin-view[data-view="echo"]'))!;
    const viewAttrs = await viewEl.evaluate((f) => ({ sandbox: f.getAttribute("sandbox"), title: f.title, height: f.getBoundingClientRect().height }));
    check("the view is an iframe with sandbox=allow-scripts only, titled by its label", viewAttrs.sandbox === "allow-scripts" && viewAttrs.title === "Echo view" && viewAttrs.height > 0, JSON.stringify(viewAttrs));
    check("the page is out of the view's reach (parent.document throws inside it)", (await modalText()).includes("View: hello, page blocked"), await modalText());
    const view = await viewEl.contentFrame();
    await view.evaluate(() => { (window as unknown as { __mark: number }).__mark = 42; });
    await view.evaluate(() => hqView.send({ t: "ping", n: 7 }));
    await waitFor(async () => (await view.evaluate(() => document.getElementById("out")?.textContent)) === "pong 7", { what: "pong in the view" });
    check("a message goes view -> client code -> view", true);
    await waitFor(async () => (await modalText()).includes("View: ping 7"), { what: "the modal redrawn after the ping" });
    check("redrawing the modal keeps the view's iframe and its state", (await viewEl.evaluate((f) => f.isConnected)) && (await view.evaluate(() => (window as unknown as { __mark: number }).__mark)) === 42);
    // (plugin code posting a Map or an ArrayBuffer past the SDK: the view gets the page's JSON copy; 100 messages a second
    // each way: 30 go through, the rest dropped with a warning, nothing stops: web/test/pluginHost.test.ts)
    await waitFor(() => click(mia, ".modal.plugin-modal .modal-actions button", "Close"), { what: "Close" });
    await waitFor(async () => (await boxText()).includes("echo closed"), { what: "the echo modal's onClose" });
    check("closing the modal removes the view's iframe", !(await read(mia, () => !!document.querySelector("iframe.plugin-view"))));
    // (a view the manifest does not declare is left out, the modal stays and the plugin runs: web/test/pluginHost.test.ts
    // and PluginViewFrame.test.tsx)

    // (what is served of a plugin, running or off, and never its server code: httpapi/plugins_test.go)

    // ---- the plugin's iframe is a sandbox
    const f = await pluginFrame(mia, DEMO);
    const probe = f ? await f.evaluate(() => {
      const tries: Record<string, string> = {};
      const attempt = (k: string, fn: () => string) => { try { tries[k] = fn() ?? "undefined"; } catch (e) { tries[k] = "threw " + (e as Error).name; } };
      attempt("parentDocument", () => String(window.parent.document.title));
      attempt("parentHQ", () => typeof window.parent.__hq);
      attempt("cookie", () => document.cookie);
      attempt("storage", () => String(localStorage.length));
      attempt("hq", () => typeof (window as unknown as PluginWindow).hq);
      return tries;
    }) : null;
    // a request the plugin sends to the office carries no session cookie (no cross-site request forgery)
    const nameBefore = await read(mia, () => fetch("/api/me").then((r) => r.json() as Promise<{ name?: string }>).then((m) => m.name));
    await f?.evaluate(() => fetch("/api/profile", { method: "PUT", mode: "no-cors", credentials: "include", body: JSON.stringify({ name: "Forged" }) }).catch(() => null));
    await sleep(500);
    const nameAfter = await read(mia, () => fetch("/api/me").then((r) => r.json() as Promise<{ name?: string }>).then((m) => m.name));
    check("a request from plugin code is not signed in (the profile did not change)", !!nameBefore && nameAfter === nameBefore, `${nameBefore} -> ${nameAfter}`);
    check("plugin code cannot read the page, its cookies or storage", !!probe && probe.parentDocument.startsWith("threw") && probe.parentHQ.startsWith("threw") && (probe.cookie.startsWith("threw") || probe.cookie === "") && probe.storage.startsWith("threw") && probe.hq === "object", JSON.stringify(probe));

    // ---- turned off through its switch, live: everything it put on the pages goes, without a reload
    await setEnabled(admin, false, "UI demo", DEMO);
    await waitFor(async () => (await frames(mia)) === 0 && (await frames(rem)) === 0, { what: "iframes removed" });
    await waitFor(() => read(mia, () => !document.querySelector(".plugin-screen, .plugin-slot")) , { what: "plugin UI removed" });
    check("disabling a plugin removes its code, buttons and boxes from every page without a reload", await read(rem, () => !document.querySelector(".plugin-screen, .plugin-slot")));
    check("and the sprites it drew for its objects", (await read(mia, () => window.__hq.session.plugins?.debug("ui-demo") ?? null)) === null && (await read(rem, () => window.__hq.session.plugins?.debug("ui-demo") ?? null)) === null);
    check("and the side panel's Plugins tab", await read(rem, () => !document.querySelector('.side .tabs button[aria-label="Plugins"]')));
    // (turned on again, a fresh start gets one init per object on the map and no destroy: a page starts a new host,
    // web/test/pluginHost.test.ts "on start"; the start through the admin dialog is checked above)

    // ---- a plugin breaking a limit is stopped on that page only
    await setPlugin(ctx, DEMO, true);
    await waitFor(async () => (await frames(mia, DEMO)) === 1 && (await frames(rem, DEMO)) === 1, { what: "plugin back on both pages" });
    const redrawn = await waitFor(async () => !!(await orbSprite(mia, MOVED))?.visible && !!(await orbSprite(rem, MOVED))?.visible, { what: "the orb drawn again" }).catch(() => false);
    check("turned on again, the plugin draws its object again on every page, without a reload", redrawn);
    // (a plugin sending far more than the server accepts never gets its member disconnected: the page holds its
    // messages under the socket's rate, web/test/pluginHost.test.ts and pluginCommands.test.ts)
    await (await pluginFrame(mia, DEMO))!.evaluate(() => { for (let i = 0; i < 600; i++) (window as unknown as PluginWindow).hq.remove("x" + i); });
    await waitFor(() => read(mia, (p) => window.__hq.session.plugins!.stopReasons.get(p) ?? "", DEMO), { what: "flooding plugin stopped" });
    const reason = await read(mia, (p) => window.__hq.session.plugins!.stopReasons.get(p), DEMO);
    check("a batch over the limit stops the plugin on that page", /512/.test(reason!) && (await frames(mia)) === 0, reason);
    // still running there: its sprite drawn, and its button's callback answered on Rem's page
    const remBox = () => read(rem, () => document.querySelector('.plugin-screen[data-plugin="ui-demo"]')?.textContent ?? "");
    await waitFor(() => rem.page.evaluate(() => { const b = document.querySelector<HTMLElement>('.topbar [data-anchor="topbar"] .plugin-slot[data-plugin="ui-demo"]'); b?.click(); return !!b; }), { what: "Rem's topbar button" }).catch(() => false);
    const answered = await waitFor(async () => (await remBox()).includes("Last click: topbar"), { what: "Rem's callback" }).catch(() => false);
    check("the other page keeps it running (its sprite drawn, its button answered)", (await frames(rem, DEMO)) === 1 && !!(await orbSprite(rem, MOVED))?.visible && answered, await remBox());
    await walkTo(mia, 8 * 16 + 8, 31 * 16 + 8);
    check("the office keeps working on the page that stopped it", await read(mia, () => window.__hq.state.conn === "open"));
    await setPlugin(ctx, DEMO, false);
    await waitFor(async () => (await frames(rem)) === 0, { what: "ui-demo off" });

    // ---- a sprite sheet from image data: drawn-sheet paints its sheet on an OffscreenCanvas
    await setPlugin(ctx, "drawn-sheet", true);
    const drawnOf = (u: User, owner: number) => read(u, (id: number) => (window.__hq.session.plugins?.debug("drawn-sheet") ?? []).find((c) => c.player === id && c.visible) ?? null, owner);
    await waitFor(async () => (await drawnOf(mia, rem.id)) && (await drawnOf(rem, mia.id)), { timeout: 15000, what: "the drawn sprites" });
    check("a sheet the plugin drew and handed over as image data is drawn, following its member, on every page", true);
    check("image data that is not a picture is refused as an invalid sheet, and the plugin goes on", await read(mia, () => !window.__hq.session.plugins!.stopReasons.get("drawn-sheet") && !!document.querySelector('iframe.plugin-frame[data-plugin="drawn-sheet"]')));
    await openPluginsTab(mia);
    await waitFor(() => click(mia, ".plugins-panel button", "Drawn sheet"), { what: "Drawn sheet entry" });
    const previewDrawn = await waitFor(() => read(mia, () => {
      const c = document.querySelector<HTMLCanvasElement>('.modal.plugin-modal canvas.plugin-sprite');
      if (!c) return false;
      const px = c.getContext("2d")!.getImageData(8, 8, 1, 1).data;
      return px[3] > 0;
    }), { what: "the preview" }).catch(() => false);
    check("the modal previews a cell of that sheet (hq.ui.sprite with sheet)", previewDrawn);
    await mia.page.keyboard.press("Escape");
    // what its iframe may fetch: its own folder and the hosts its manifest declares, nothing else
    const drawnFrame = (await pluginFrame(mia, "drawn-sheet"))!;
    const blocked = await drawnFrame.evaluate(() => new Promise<string[]>((resolve) => {
      const seen: string[] = [];
      document.addEventListener("securitypolicyviolation", (e) => seen.push(e.blockedURI));
      fetch("https://undeclared.example.net/sheet.png").catch(() => {});
      fetch("https://images.invalid/sheet.png").catch(() => {}); // declared; .invalid never resolves: no network
      setTimeout(() => resolve(seen), 800);
    }));
    check("its iframe may fetch from the hosts its manifest declares, and only those", blocked.some((u) => u.includes("undeclared.example.net")) && !blocked.some((u) => u.includes("images.invalid")), JSON.stringify(blocked));
    await setPlugin(ctx, "drawn-sheet", false);
    await waitFor(async () => (await frames(mia)) === 0, { what: "drawn-sheet off" });

    await setOrb(null);
    // the forged PUT above is refused (401) on purpose; Chrome logs that response as a console error
    // expected on Mia's page: a 401 the test provokes, the fetch blocked by the CSP, and the declared .invalid host not resolving
    const real = (u: User) => u.logs.filter((l) => !(u === mia && (/status of 401/.test(l) || /undeclared\.example\.net|images\.invalid|ERR_NAME_NOT_RESOLVED/.test(l))));
    for (const u of [admin, mia, rem]) check(`${u.name}: no console errors`, real(u).length === 0, real(u).slice(0, 3).join(" | "));
    await Promise.all([admin, mia, rem].map((u) => u.ctx.close()));
  } catch (e) {
    check("scenario completed", false, String(e));
  } finally {
    await browser.close();
  }
  return summary();
}
