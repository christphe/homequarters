// Office layouts through their real controls: an administrator switches the office to the Manor from Admin > Office
// (Use the Manor layout, then the confirmation's Switch to Manor); a member online gets the new map without a reload
// and walks in the whole of it, past the old map's edge. The shared office is put back as it was at the end.
// Moved down (no longer checked here):
// - the layouts listed with what they offer, the confirmation's text (the whole map replaced, the desks that carry
//   over), the administrator's toast, a refused switch explained: web/test/AdminOffice.test.tsx;
// - a member cannot switch (403), the desk carried over by number, the switch in the activity log:
//   Go TestAdminAppliesATemplateAndDesksCarryOver (httpapi/templates_test.go), the log's row in AdminOffice.test.tsx;
// - everybody online told the office moved, then reconnected at the new entrance: Go
//   TestReplaceMapChangesSizeAndRespawnsEverybody (world/template_test.go), the toast's text in web/test/replies.test.ts.
import os from "node:os";
import path from "node:path";
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, API, type RunContext, type User } from "../lib.ts";
import type { MapData } from "../../web/src/net/protocol.ts";

const click = (u: User, selector: string, text: string) => u.page.evaluate((selector, text) => {
  const b = [...document.querySelectorAll<HTMLElement>(selector)].find((x) => x.textContent.trim() === text || x.getAttribute("aria-label") === text);
  b?.click();
  return !!b;
}, selector, text);
const api = (cookie: string, method: string, path: string, body?: object) => fetch(API + path, { method, headers: { "Content-Type": "application/json", Cookie: "hq_session=" + cookie }, body: body ? JSON.stringify(body) : undefined });
const sizeOf = (u: User) => u.page.evaluate(() => { const m = window.__hq.view.map!; return { w: m.w, h: m.h }; });

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const original = (await (await api(ctx.adminCookie, "GET", "/api/admin/map")).json()) as MapData;
  const browser = await launch();
  try {
    const t = String(Date.now() % 10000);
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    const mia = await joinAs(browser, "Mia" + t);

    // ---- the administrator switches through Admin > Office, confirming
    await waitFor(() => click(admin, ".topbar button", "Admin"), { what: "Admin button" });
    await waitFor(() => click(admin, ".modal [role=tab]", "Office"), { what: "Office tab" });
    await waitFor(() => click(admin, ".modal .layout button", "Use the Manor layout"), { what: "the Manor in the layout list" });
    await waitFor(() => click(admin, ".modal button", "Switch to Manor"), { what: "confirmation" });
    const before = await sizeOf(mia);

    // ---- Mia is online: she reconnects into the new map
    await waitFor(async () => (await sizeOf(mia)).w === 85, { timeout: 20000, what: "Mia gets the Manor" });
    const after = await sizeOf(mia);
    check("an online member gets the new map without a reload", before.w === 60 && after.w === 85 && after.h === 51, `${before.w} -> ${after.w}x${after.h}`);
    await waitFor(() => mia.page.evaluate(() => window.__hq.state.conn === "open"), { timeout: 20000, what: "Mia connected" });
    // she can walk in the whole new map, to the right corridor, east of the old 60-tile edge
    const reached = await walkTo(mia, 71 * 16 + 8, 20 * 16 + 8).then(() => true).catch((e) => String(e));
    const moved = await mia.page.evaluate(() => window.__hq.view.position());
    check("movement works in the whole new map (walked past the old edge)", reached === true && moved.x / 16 > 60, `${reached} ${moved.x / 16},${moved.y / 16}`);
    await mia.page.screenshot({ path: path.join(os.tmpdir(), "homequarters-template-manor.png") });
    const errs = [admin, mia].flatMap((u) => u.logs).filter((l) => !/WebSocket|ERR_|net::|closed/.test(l));
    check("no unexpected console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
    // put the shared office back: the Loft (same size as the original), then the original map itself
    await api(ctx.adminCookie, "POST", "/api/admin/map/template", { template: "loft" });
    const back = await api(ctx.adminCookie, "PUT", "/api/map", original);
    check("the office is put back as it was", back.ok, String(back.status));
  }
  return summary();
}
