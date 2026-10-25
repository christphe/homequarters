// Office layouts: an administrator switches the office to another template from Admin > Office; everybody
// online reconnects into the new map at its entrance, desk assignments carry over by number, the switch is
// in the activity log. The shared office is put back as it was at the end.
import os from "node:os";
import path from "node:path";
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, API } from "../lib.mjs";

const click = (u, selector, text) => u.page.evaluate((selector, text) => {
  const b = [...document.querySelectorAll(selector)].find((x) => x.textContent.trim() === text || x.getAttribute("aria-label") === text);
  b?.click();
  return !!b;
}, selector, text);
const api = (cookie, method, path, body) => fetch(API + path, { method, headers: { "Content-Type": "application/json", Cookie: "hq_session=" + cookie }, body: body ? JSON.stringify(body) : undefined });
const mapOf = (u) => u.page.evaluate(() => { const m = window.__hq.view.map; return { w: m.w, h: m.h, props: m.props }; });

export async function run(ctx) {
  resetChecks();
  const original = await (await api(ctx.adminCookie, "GET", "/api/admin/map")).json();
  const browser = await launch();
  try {
    const t = String(Date.now() % 10000);
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    const mia = await joinAs(browser, "Mia" + t);
    const miaId = (await (await api(ctx.adminCookie, "GET", "/api/admin/members")).json()).members.find((m) => m.name === "Mia" + t).id;
    // Mia owns the Loft's Desk 2
    const assigned = structuredClone(original);
    for (const p of assigned.props) if (p.t === "desk") p.assign = p.label === "Desk 2" ? miaId : undefined;
    check("setup: Mia gets Desk 2", (await api(ctx.adminCookie, "PUT", "/api/map", assigned)).ok);
    check("a member cannot switch the layout (403)", (await fetch(API + "/api/admin/map/template", { method: "POST", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + (await mia.ctx.cookies()).find((c) => c.name === "hq_session").value }, body: JSON.stringify({ template: "manor" }) })).status === 403);

    // ---- the Office tab lists the layouts, the one in use marked
    await waitFor(() => click(admin, ".topbar button", "Admin"), { what: "Admin button" });
    await waitFor(() => click(admin, ".modal [role=tab]", "Office"), { what: "Office tab" });
    const rows = await waitFor(async () => {
      const r = await admin.page.evaluate(() => [...document.querySelectorAll(".modal .layout")].map((li) => li.textContent));
      return r.length ? r : null;
    }, { what: "layout list" });
    check("the three layouts are listed with what they offer", rows.length === 3 && rows.some((r) => r.startsWith("Loft") && r.includes("in use")) &&
      rows.some((r) => r.startsWith("Manor") && r.includes("48 desks") && r.includes("10 rooms") && r.includes("12 corners")) && rows.some((r) => r.startsWith("Lodge") && r.includes("36 desks")), rows.join(" | "));

    // ---- switching asks first, saying what is overwritten and what carries over
    await click(admin, ".modal .layout button", "Use the Manor layout");
    const dialog = await waitFor(() => admin.page.evaluate(() => {
      const d = [...document.querySelectorAll(".modal")].find((m) => m.textContent.includes("Switch to Manor?"));
      return d ? d.textContent : null;
    }), { what: "confirmation" });
    check("the confirmation says the whole map is replaced and how many desks carry over", dialog.includes("whole map is replaced") && dialog.includes("1 kept"), dialog);
    const before = await mapOf(mia);
    await click(admin, ".modal button", "Switch to Manor");
    const toast = await waitFor(() => admin.page.evaluate(() => [...document.querySelectorAll(".toast")].map((x) => x.textContent).find((x) => x.includes("layout"))), { what: "toast" }).catch(() => "");
    check("the admin is told the layout changed", toast.includes("Manor"), toast);

    // ---- Mia is online: she reconnects into the new map, at its entrance
    await waitFor(async () => (await mapOf(mia)).w === 85, { timeout: 20000, what: "Mia gets the Manor" });
    const told = await waitFor(() => mia.page.evaluate(() => [...document.querySelectorAll(".toast")].map((x) => x.textContent).find((x) => x.includes("moved to"))), { timeout: 3000, what: "Mia is told" }).catch(() => "");
    check("an online member is told the office moved to the new layout, not left guessing", told.includes("Manor"), told);
    const after = await mapOf(mia);
    check("an online member gets the new map without a reload", before.w === 60 && after.w === 85 && after.h === 51, `${before.w} -> ${after.w}x${after.h}`);
    await waitFor(() => mia.page.evaluate(() => window.__hq.state.conn === "open"), { timeout: 20000, what: "Mia connected" });
    const at = await mia.page.evaluate(() => window.__hq.view.position());
    const tx = Math.floor(at.x / 16), ty = Math.floor(at.y / 16);
    check("she stands in the welcome area (the new spawn)", tx >= 23 && tx <= 29 && ty >= 1 && ty <= 13, `${tx},${ty}`);
    const desk2 = after.props.find((p) => p.t === "desk" && p.label === "Desk 2");
    check("her desk carried over by number (Desk 2 of the Manor)", desk2?.assign === miaId && after.props.filter((p) => p.t === "desk" && p.assign).length === 1);
    // she can walk in the whole new map, to the right corridor, east of the old 60-tile edge
    const reached = await walkTo(mia, 71 * 16 + 8, 20 * 16 + 8).then(() => true).catch((e) => String(e));
    const moved = await mia.page.evaluate(() => window.__hq.view.position());
    check("movement works in the whole new map (walked past the old edge)", reached === true && moved.x / 16 > 60, `${reached} ${moved.x / 16},${moved.y / 16}`);
    await mia.page.screenshot({ path: path.join(os.tmpdir(), "homequarters-template-manor.png") });

    await waitFor(() => admin.page.evaluate(() => window.__hq.state.conn === "open"), { timeout: 20000, what: "admin reconnected" });
    // ---- the activity log names the switch
    if (!(await admin.page.$(".modal [role=tab]"))) await waitFor(() => click(admin, ".topbar button", "Admin"), { what: "Admin button" });
    await waitFor(() => click(admin, ".modal [role=tab]", "Activity"), { what: "Activity tab" });
    const log = await waitFor(() => admin.page.evaluate(() => [...document.querySelectorAll(".modal li, .modal tr")].map((x) => x.textContent).find((x) => x.includes("Manor layout"))), { what: "audit row" });
    check("the activity log shows the switch", log.includes("switched the office to the Manor layout"), log);
  } finally {
    await browser.close();
    // put the shared office back: the Loft (same size as the original), then the original map itself
    await api(ctx.adminCookie, "POST", "/api/admin/map/template", { template: "loft" });
    const back = await api(ctx.adminCookie, "PUT", "/api/map", original);
    check("the office is put back as it was", back.ok, String(back.status));
  }
  return summary();
}
