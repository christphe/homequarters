// Administration through the real dialog against the real server: a role change reaching the online member, an invite
// created, the office renamed for everybody, a member removed and told why; and the top bar's office name and area, on
// a desktop and on a phone (layout only a browser shows).
// What moved below the browser (decision 0037), and where it lives now:
// - roles: the Admin button only for admins, the members list with "(you)" and no Remove on one's own row, the role
//   select and Remove's confirmation sending their requests: web/test/AdminMembers.test.tsx; demoting, the last admin
//   (409), members kept out of the admin API (403): TestRoleChangeRemovalAndTheLastAdminGuard,
//   TestAdminEndpointsRequireTheAdminRole (server/internal/httpapi/admin_test.go).
// - invites: the link shown once and the request sent, Revoke: AdminMembers.test.tsx; the list never holding the secret,
//   a revoked invite refused (403): TestInviteLifecycleThroughTheAPI.
// - rename: an empty name (400), a member renaming (403), the audit row with the old and new name:
//   TestAdminRenamesTheOfficeForEverybodyOnline (server/internal/httpapi/office_test.go).
// - the activity log naming role changes, invites and the rename: AdminMembers.test.tsx and TestAuditTrailOrderAndPruning.
// - removal: the removed session dead and the admin API closed to it, everybody seeing the member leave:
//   TestRoleChangeRemovalAndTheLastAdminGuard, TestEvictRemovesThePlayerEndsTheCallAndTellsTheConnection.
// - each tab failing on the network: web/test/Offline.test.tsx.
import os from "node:os";
import path from "node:path";
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, API, type User, type RunContext } from "../lib.ts";

const click = (u: User, selector: string, text: string) => u.page.evaluate((selector, text) => {
  const b = [...document.querySelectorAll<HTMLElement>(selector)].find((x) => x.textContent.trim() === text);
  b?.click();
  return !!b;
}, selector, text);
const api = (cookie: string, method: string, path: string, body?: unknown) => fetch(API + path, { method, headers: { "Content-Type": "application/json", Cookie: "hq_session=" + cookie }, body: body ? JSON.stringify(body) : undefined });
const passes = (p: Promise<unknown>) => p.then(() => true, () => false);

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  try {
    const t = String(Date.now() % 10000);
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    const mia = await joinAs(browser, "Mia" + t);
    const rem = await joinAs(browser, "Rem" + t);

    // ---- a role change through the Members tab: Mia is disconnected, reconnects and gets the new role
    await waitFor(() => click(admin, ".topbar button", "Admin"), { what: "Admin button" });
    await waitFor(() => admin.page.$(".modal .admin-table"), { what: "members table" });
    const role = (r: string) => waitFor(() => mia.page.evaluate((r) => window.__hq.state.role === r && window.__hq.state.conn === "open", r), { timeout: 20000, what: "Mia reconnects as " + r });
    await admin.page.select('.modal select[aria-label="Role of Mia' + t + '"]', "admin");
    const promoted = (await passes(role("admin"))) && (await passes(waitFor(() => mia.page.evaluate(() => [...document.querySelectorAll(".topbar button")].some((b) => b.textContent.trim() === "Admin")), { timeout: 5000 })));
    check("a role change reaches the online member without a reload (evict, reconnect, new role), and her top bar offers Admin", promoted);
    await admin.page.select('.modal select[aria-label="Role of Mia' + t + '"]', "member"); // shared office: leave no extra admin
    await role("member");

    // ---- invites tab
    await click(admin, ".modal [role=tab]", "Invites");
    await waitFor(() => click(admin, ".modal .admin-form button", "Create invite link"), { what: "invite form" });
    const link = await waitFor(() => admin.page.evaluate(() => document.querySelector<HTMLInputElement>(".modal .composer input")?.value), { what: "invite link" });
    const token = new URL(link).searchParams.get("invite");
    check("creating an invite through the Invites tab shows its link", link.includes("?invite=") && (token?.length ?? 0) > 20, link.replace(token ?? "", "<token>"));

    // ---- office tab: rename, seen live by everybody (top bar and browser tab)
    const errors: string[] = [];
    admin.page.on("pageerror", (e) => errors.push((e as Error).message));
    admin.page.on("response", (r) => { if (r.url().includes("/api/admin/office")) errors.push("PATCH " + r.status()); });
    const before = await mia.page.evaluate(() => window.__hq.state.office);
    await click(admin, ".modal [role=tab]", "Office");
    const field = await waitFor(() => admin.page.$("#office-name"), { what: "office name field" });
    await field.click();
    await field.evaluate((el) => (el as HTMLInputElement).select()); // typing replaces the current name
    await field.type("Harbour " + t);
    await click(admin, ".modal form button", "Rename");
    const seen = await passes(waitFor(() => mia.page.evaluate((n) => document.querySelector(".topbar .brand")?.textContent === n, "Harbour " + t), { timeout: 5000 }));
    const why = seen ? "" : JSON.stringify(await Promise.all([mia.page.evaluate(() => document.querySelector(".topbar .brand")?.textContent), admin.page.evaluate(() => ({ field: document.querySelector<HTMLInputElement>("#office-name")?.value, toast: document.querySelector(".toast")?.textContent, brand: document.querySelector(".topbar .brand")?.textContent }))]));
    const title = await mia.page.title();
    check("a rename through the Office tab reaches an online member's top bar and browser tab without a reload", seen && title === "Home Quarters - Harbour " + t, why + " " + title + " " + errors.join(" | ") + " " + admin.page.url());

    // ---- the office name has no red frame; the current area hangs under it in the hint style
    await walkTo(mia, 8 * 16 + 8, 28 * 16 + 8); // social area
    await waitFor(() => mia.page.evaluate(() => !!window.__hq.state.currentArea), { what: "Mia in an area" });
    const look = await mia.page.evaluate(() => {
      const brand = document.querySelector(".topbar .brand"), hint = document.querySelector(".topbar .area-hint");
      const b = brand!.getBoundingClientRect(), h = hint?.getBoundingClientRect();
      return { border: getComputedStyle(brand!).borderTopWidth, area: hint?.textContent, want: window.__hq.state.currentArea, below: h ? h.top >= b.bottom && Math.abs(h.left - b.left) < 2 : false, pill: [...document.querySelectorAll(".topbar .pill")].some((p) => p.textContent === window.__hq.state.currentArea), hintStyle: !!hint?.classList.contains("hint") };
    });
    check("the office name has no border", look.border === "0px", look.border);
    check("the current area shows under the office name, left-aligned, as a hint (not a pill)", look.area === look.want && look.below && !look.pill && look.hintStyle, JSON.stringify(look));
    await mia.page.screenshot({ path: path.join(os.tmpdir(), "homequarters-office-name.png"), clip: { x: 0, y: 0, width: 420, height: 110 } });
    // ---- a touch phone with a 40-character name: one line, the area readable, every top-bar control on screen
    const phone = await joinAs(browser, "Pho" + t, { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } });
    await api(ctx.adminCookie, "PATCH", "/api/admin/office", { name: "The Very Long Office Name Of Forty Chars" });
    await waitFor(() => phone.page.evaluate(() => window.__hq.state.office.length === 40), { what: "phone sees the long name" });
    await walkTo(phone, 8 * 16 + 8, 28 * 16 + 8); // social area
    await waitFor(() => phone.page.evaluate(() => !!document.querySelector(".topbar .area-hint")), { what: "area under the name on the phone" });
    const small = await phone.page.evaluate(() => {
      const rect = (el: Element) => el.getBoundingClientRect();
      const brand = rect(document.querySelector(".topbar .brand")!), hint = document.querySelector(".topbar .area-hint")!, h = rect(hint), mm = document.querySelector(".minimap");
      const m = mm ? rect(mm) : null;
      const overlaps = m && h.left < m.right && h.right > m.left && h.top < m.bottom && h.bottom > m.top;
      // what is seen there: the first element with a background (transparent containers hide nothing)
      const hit = document.elementsFromPoint((h.left + h.right) / 2, (h.top + h.bottom) / 2).find((el) => hint.contains(el) || getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)");
      const off = [...document.querySelectorAll(".topbar button")].filter((b) => { const r = rect(b); return r.width && (r.left < 0 || r.right > innerWidth); }).map((b) => b.textContent.trim());
      const bar = document.querySelector(".bar .hint"), pads = [...document.querySelectorAll(".touchpad button")].map(rect);
      const b = bar ? rect(bar) : null, row = rect(document.querySelector(".bar-row")!);
      const onPad = pads.some((p) => p.left < row.right && p.right > row.left && p.top < row.bottom && p.bottom > row.top);
      return { brandH: Math.round(brand.height), overlaps, hintOnTop: hint.contains(hit as Node | null), off, barHintH: b ? Math.round(b.height) : 0, onPad };
    });
    check("on a phone \"Proximity audio and video are off.\" fits on one line, clear of the touch pad", small.barHintH > 0 && small.barHintH < 30 && !small.onPad, JSON.stringify(small));
    check("on a phone a long office name stays on one line", small.brandH < 50, JSON.stringify(small));
    check("on a phone the area under the name is not covered by the minimap", !small.overlaps && small.hintOnTop, JSON.stringify(small));
    check("on a phone every top-bar button stays on screen", small.off.length === 0, JSON.stringify(small.off));
    await phone.page.screenshot({ path: path.join(os.tmpdir(), "homequarters-office-name-phone.png"), clip: { x: 0, y: 0, width: 390, height: 260 } });
    await phone.ctx.close();
    await api(ctx.adminCookie, "PATCH", "/api/admin/office", { name: before }); // shared office: put the name back


    // ---- removal: the member is disconnected at once and told why
    await click(admin, ".modal [role=tab]", "Members");
    await waitFor(() => admin.page.$(".modal .admin-table"), { what: "members again" });
    await admin.page.evaluate((n) => document.querySelector<HTMLButtonElement>('.modal button[aria-label="Remove ' + n + '"]')!.click(), "Rem" + t);
    await waitFor(() => click(admin, ".modal button", "Confirm removal"), { what: "confirm button" });
    await waitFor(() => rem.page.evaluate(() => !!document.querySelector(".join-card")), { timeout: 20000, what: "removed member lands on the join screen" });
    const note = await rem.page.evaluate(() => document.querySelector(".join-card .error")?.textContent ?? "");
    check("a removed member is disconnected at once and told why", note.includes("removed from this office"), note);
    return summary();
  } finally {
    await browser.close();
  }
}
