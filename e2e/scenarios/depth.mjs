// Desks and their PCs have depth: they are drawn again as sprites over the baked map, sorted with the
// avatars, so somebody behind a desk is hidden by it. With nobody around the office looks exactly as
// baked; a saved map without pc props keeps its built-in screens; the editor erases a desk with its PC.
// The shared office is put back as it was at the end.
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, API } from "../lib.mjs";

const api = (cookie, method, path, body) => fetch(API + path, { method, headers: { "Content-Type": "application/json", Cookie: "hq_session=" + cookie }, body: body ? JSON.stringify(body) : undefined });
const tileToClient = (u, tx, ty) =>
  u.page.evaluate((tx, ty) => {
    const v = window.__hq.view;
    const r = v.app.canvas.getBoundingClientRect();
    return { x: r.left + v.camX + (tx * 16 + 8) * v.S, y: r.top + v.camY + (ty * 16 + 8) * v.S };
  }, tx, ty);
const clickTile = async (u, tx, ty) => { const p = await tileToClient(u, tx, ty); await u.page.mouse.click(p.x, p.y); };
const chip = (u, text) => u.page.evaluate((text) => { const b = [...document.querySelectorAll(".editor .chip")].find((x) => x.textContent === text); b?.click(); return !!b; }, text);
const editorButton = (u, text) => u.page.evaluate((text) => { const b = [...document.querySelectorAll(".editor button")].find((x) => x.textContent === text); b?.click(); return !!b; }, text);
const viewMap = (u) => u.page.evaluate(() => JSON.parse(JSON.stringify(window.__hq.view.map)));
const depth = (u) => u.page.evaluate(() => window.__hq.view.debugDepth());
// a hash of the world's pixels (1 world px each) over rect, with or without the depth sprites and the people
const pixels = (u, opts) => u.page.evaluate((opts) => window.__hq.view.debugWorldPixels(opts), opts);
const bakeHash = (u, map) => u.page.evaluate((map) => window.__hq.view.debugBakeHash(map), map);
const stripPCs = (m) => ({ ...structuredClone(m), props: m.props.filter((p) => p.t !== "pc") });
const deskCount = (m) => m.props.filter((p) => p.t === "desk").length;
const solidAt = (m, x, y) => m.solid?.[y]?.[x] === "1" || m.walls[y][x] === "#";

export async function run(ctx) {
  resetChecks();
  const original = await (await api(ctx.adminCookie, "GET", "/api/admin/map")).json();
  const browser = await launch();
  try {
    const t = String(Date.now() % 10000);
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    const walker = await joinAs(browser, "Walker" + t);
    const put = async (m) => {
      const r = await api(ctx.adminCookie, "PUT", "/api/map", m);
      const want = m.props.filter((p) => p.t === "pc").length;
      await waitFor(async () => (await viewMap(admin)).props.filter((p) => p.t === "pc").length === want && (await viewMap(admin)).props.length === m.props.length, { what: "the new map" });
      return r.ok;
    };
    const whole = (m) => ({ x: 0, y: 0, w: m.w * 16, h: m.h * 16 });
    const sameWithAndWithout = async (m) => {
      const a = await pixels(admin, { depth: false, ents: false, rect: whole(m) });
      const b = await pixels(admin, { depth: true, ents: false, rect: whole(m) });
      return a === b && typeof a === "string";
    };

    // ---- a map saved before PCs existed: desks keep their built-in screens, depth adds nothing visible
    const old = stripPCs(original);
    check("setup: a map without pc props is accepted", await put(old));
    const oldMap = await viewMap(admin);
    check("a saved map without PCs gets a depth sprite per desk and none for PCs", JSON.stringify(await depth(admin)) === JSON.stringify({ desks: deskCount(oldMap), pcs: 0 }), JSON.stringify(await depth(admin)));
    check("with nobody near, a map without PCs looks the same with and without depth sprites", await sameWithAndWithout(oldMap));

    // ---- the Loft as a template makes it: one pc per desk, the same picture as the built-in screens
    check("setup: the map with PCs is accepted", await put(original));
    const withMap = await viewMap(admin);
    check("the starter map has a pc on every desk", withMap.props.filter((p) => p.t === "pc").length === deskCount(withMap) && deskCount(withMap) > 0);
    check("each desk and each pc gets a depth sprite", JSON.stringify(await depth(admin)) === JSON.stringify({ desks: deskCount(withMap), pcs: deskCount(withMap) }), JSON.stringify(await depth(admin)));
    check("with nobody near, the map with PCs looks the same with and without depth sprites", await sameWithAndWithout(withMap));
    check("desks with pc props bake exactly like desks with built-in screens", (await bakeHash(admin, withMap)) === (await bakeHash(admin, stripPCs(withMap))));
    const nudged = structuredClone(withMap);
    nudged.props.find((p) => p.t === "pc").dx += 1;
    check("(the bake comparison sees a 1 px shift of one pc)", (await bakeHash(admin, nudged)) !== (await bakeHash(admin, withMap)));

    // ---- a baked neighbour drawn over a desk (the reception's monitor over a desk leg) stays over it
    const deskA = withMap.props.find((p) => p.t === "desk" && !p.up && p.x >= 5 && p.y + 1 < withMap.h - 1);
    const overlap = structuredClone(withMap);
    overlap.props.push({ t: "reception_desk", x: deskA.x - 5, y: deskA.y + 1 });
    check("setup: a reception desk under a desk", await put(overlap));
    check("a baked neighbour drawn over a desk is not covered by the desk's sprite", await sameWithAndWithout(await viewMap(admin)));
    await put(original);

    // ---- depth: somebody north of a desk is behind it, somebody south of it in front
    const free = (m, x, y) => x >= 0 && y >= 0 && x < m.w && y < m.h && !solidAt(m, x, y);
    const north = withMap.props.find((p) => p.t === "desk" && !p.up && free(withMap, p.x, p.y - 1) && free(withMap, p.x + 1, p.y - 1) && free(withMap, p.x, p.y - 2));
    const south = withMap.props.find((p) => p.t === "desk" && free(withMap, p.x, p.y + 1));
    // what rises above a desk's tile: its screen (a front desk: 12 px wide, 11 px up, all opaque) or its
    // top (a turned desk: 6 px up, the full width)
    const screenRect = (d) => ({ x: d.x * 16 + (d.w ?? 2) * 8 - 6, y: d.y * 16 - 11, w: 12, h: 11 });
    const topRect = (d) => ({ x: d.x * 16 + 2, y: d.y * 16 - 6, w: (d.w ?? 2) * 16 - 4, h: 6 });
    const seen = async (rect) => ({
      on: await pixels(admin, { depth: true, ents: true, rect }), onEmpty: await pixels(admin, { depth: true, ents: false, rect }),
      off: await pixels(admin, { depth: false, ents: true, rect }), offEmpty: await pixels(admin, { depth: false, ents: false, rect }),
    });
    if (north) {
      await walkTo(walker, north.x * 16 + 16, (north.y - 1) * 16 + 14).catch(() => {}); // feet against the desk
      await walkTo(admin, north.x * 16 + 8, (north.y + 3) * 16 + 8).catch(() => {});
      const s = await seen(screenRect(north));
      check("(without depth, the person north of a desk is drawn over its top)", s.off !== s.offEmpty);
      check("a person north of a desk is hidden by its screen", s.on === s.onEmpty);
    } else check("setup: a desk with free tiles north of it", false);
    if (south) {
      await walkTo(walker, south.x * 16 + 8, (south.y + 1) * 16 + 8);
      const s = await seen({ x: south.x * 16 + 2, y: south.y * 16 + 2, w: 12, h: 14 }); // its tile, where a sitter's head is
      check("a person south of a desk (on its chair) is drawn in front of it", s.on !== s.onEmpty);
    } else check("setup: a desk with a free chair south of it", false);

    // ---- the editor: one click erases a desk with its pc, and it shows; a pc is not offered on its own
    const target = withMap.props.find((p) => p.t === "desk" && !p.up && free(withMap, p.x, p.y + 2));
    await walkTo(walker, 5 * 16 + 8, 5 * 16 + 8).catch(() => {}); // out of the way
    await walkTo(admin, target.x * 16 + 8, (target.y + 2) * 16 + 8).catch(() => {});
    await admin.page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Edit office")?.click());
    await waitFor(() => admin.page.$(".editor"), { what: "editor open" });
    await chip(admin, "Objects");
    const offered = await admin.page.evaluate(() => [...document.querySelectorAll(".editor select option")].map((o) => o.value));
    check("the editor does not offer a pc on its own (a desk without one draws its screen)", offered.includes("desk") && !offered.includes("pc"), offered.join(","));
    const deskArea = { x: target.x * 16, y: target.y * 16 - 12, w: (target.w ?? 2) * 16, h: 28 };
    const before = await pixels(admin, { depth: true, ents: false, rect: deskArea });
    await chip(admin, "Erase object");
    await clickTile(admin, target.x, target.y); // the tile its pc stands on
    const pcsOn = async (d) => (await viewMap(admin)).props.filter((p) => p.t === "pc" && p.y === d.y && p.x >= d.x && p.x < d.x + (d.w ?? 2));
    const gone = await viewMap(admin);
    check("one click of the eraser on a desk removes the desk and its pc", !gone.props.some((p) => p.t === "desk" && p.x === target.x && p.y === target.y) && (await pcsOn(target)).length === 0);
    check("and the change shows at once", (await pixels(admin, { depth: true, ents: false, rect: deskArea })) !== before);
    const saved = await editorButton(admin, "Save") && await waitFor(() => admin.page.evaluate(() => [...document.querySelectorAll(".toast")].map((x) => x.textContent).find((x) => /saved|error|invalid|refused/i.test(x))), { timeout: 5000, what: "save toast" }).catch(() => "");
    check("the edited map saves", !!saved && !/error|invalid|refused/i.test(saved), saved);
    await editorButton(admin, "Close");

    // ---- switching layout rebuilds the depth sprites; turned desks hide whoever sits behind them
    const sw = await api(ctx.adminCookie, "POST", "/api/admin/map/template", { template: "manor" });
    check("setup: switch to the Manor", sw.ok);
    await waitFor(async () => (await viewMap(admin)).w === 85, { timeout: 20000, what: "the Manor" });
    await waitFor(() => admin.page.evaluate(() => window.__hq.state.conn === "open"), { timeout: 20000, what: "admin back" });
    await waitFor(async () => (await depth(admin)).desks === 48, { timeout: 5000, what: "depth sprites" }).catch(() => {});
    check("after a layout switch, the depth sprites are the new map's (48 desks, 48 PCs)", JSON.stringify(await depth(admin)) === JSON.stringify({ desks: 48, pcs: 48 }), JSON.stringify(await depth(admin)));
    const manor = await viewMap(admin);
    check("with nobody near, the Manor looks the same with and without depth sprites", await sameWithAndWithout(manor));
    check("the Manor's desks with PCs bake like desks with built-in screens", (await bakeHash(admin, manor)) === (await bakeHash(admin, stripPCs(manor))));
    await waitFor(() => walker.page.evaluate(() => window.__hq.state.conn === "open"), { timeout: 20000, what: "walker back" });
    const turned = manor.props.find((p) => p.t === "desk" && p.up && free(manor, p.x + 1, p.y - 1));
    await walkTo(walker, (turned.x + 1) * 16 + 8, (turned.y - 1) * 16 + 14).catch(() => {}); // on its chair, feet against the desk
    await walkTo(admin, (turned.x + 1) * 16 + 8, (turned.y + 4) * 16 + 8).catch(() => {});
    const s = await seen(topRect(turned));
    check("(without depth, the person on the chair of a turned desk is drawn over it)", s.off !== s.offEmpty);
    check("a person on the chair of a turned desk is hidden by the desk's top", s.on === s.onEmpty);
  } finally {
    await browser.close();
    // the Loft (same size as the original), then the original map itself
    await api(ctx.adminCookie, "POST", "/api/admin/map/template", { template: "loft" });
    const back = await api(ctx.adminCookie, "PUT", "/api/map", original);
    if (!back.ok) console.log("# could not restore the office map:", back.status);
  }
  return summary();
}
