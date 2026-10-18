// Administration: members, roles, removal, invites, the office name and the activity log, driven through the real UI.
import os from "node:os";
import path from "node:path";
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, sleep, API } from "../lib.mjs";

const click = (u, selector, text) => u.page.evaluate((selector, text) => {
  const b = [...document.querySelectorAll(selector)].find((x) => x.textContent.trim() === text);
  b?.click();
  return !!b;
}, selector, text);
const cookieOf = async (u) => (await u.ctx.cookies()).find((c) => c.name === "hq_session").value;
const api = (cookie, method, path, body) => fetch(API + path, { method, headers: { "Content-Type": "application/json", Cookie: "hq_session=" + cookie }, body: body ? JSON.stringify(body) : undefined });

export async function run(ctx) {
  resetChecks();
  const browser = await launch();
  try {
    const t = String(Date.now() % 10000);
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    const mia = await joinAs(browser, "Mia" + t);
    const rem = await joinAs(browser, "Rem" + t);
    const miaCookie = await cookieOf(mia);
    const remCookie = await cookieOf(rem);

    check("a member does not see the Admin button", !(await click(mia, ".topbar button", "Admin")));

    // ---- members tab
    await waitFor(() => click(admin, ".topbar button", "Admin"), { what: "Admin button" });
    await waitFor(() => admin.page.$(".modal .admin-table"), { what: "members table" });
    const names = await admin.page.evaluate(() => [...document.querySelectorAll(".modal .admin-table tbody tr td:first-child")].map((x) => x.textContent));
    check("the members tab lists everybody, with the admin marked as you", names.some((n) => n.startsWith("Admin") && n.includes("(you)")) && names.some((n) => n === "Mia" + t) && names.some((n) => n === "Rem" + t), names.join());
    check("the admin cannot remove themselves from the UI", await admin.page.evaluate(() => ![...document.querySelectorAll(".modal .admin-table tbody tr")].find((r) => r.textContent.startsWith("Admin"))?.querySelector("button")));

    // ---- promote Mia: she is disconnected, reconnects and gets the new role
    await admin.page.select('.modal select[aria-label="Role of Mia' + t + '"]', "admin");
    await waitFor(() => mia.page.evaluate(() => window.__hq.state.role === "admin" && window.__hq.state.conn === "open"), { timeout: 20000, what: "Mia reconnects as admin" });
    check("a role change reaches the online member without a reload (evict, reconnect, new role)", true);
    check("the new admin now sees the Admin button", await waitFor(() => click(mia, ".topbar button", "Admin"), { timeout: 5000 }).then(() => true).catch(() => false));
    await mia.page.keyboard.press("Escape");
    await admin.page.select('.modal select[aria-label="Role of Mia' + t + '"]', "member");
    await waitFor(() => mia.page.evaluate(() => window.__hq.state.role === "member" && window.__hq.state.conn === "open"), { timeout: 20000, what: "Mia back to member" });
    check("demoting works the same way", true);
    // earlier scenarios may have minted other admins in this shared office: demote them, so that ours is the last one
    const all = await (await api(ctx.adminCookie, "GET", "/api/admin/members")).json();
    for (const m of all.members) if (m.role === "admin" && m.id !== ctx.adminId) await api(ctx.adminCookie, "PATCH", "/api/admin/members/" + m.id, { role: "member" });
    const selfDemote = await api(ctx.adminCookie, "PATCH", "/api/admin/members/" + ctx.adminId, { role: "member" });
    check("the last admin cannot be demoted (409)", selfDemote.status === 409);
    check("a member cannot call the admin API (403)", (await api(miaCookie, "GET", "/api/admin/members")).status === 403);

    // ---- invites tab
    await click(admin, ".modal [role=tab]", "Invites");
    await waitFor(() => click(admin, ".modal .admin-form button", "Create invite link"), { what: "invite form" });
    const link = await waitFor(() => admin.page.evaluate(() => document.querySelector(".modal .composer input")?.value), { what: "invite link" });
    const token = new URL(link).searchParams.get("invite");
    check("creating an invite shows its link once", link.includes("?invite=") && token.length > 20);
    await waitFor(() => admin.page.evaluate(() => [...document.querySelectorAll(".modal .admin-table tbody tr")].some((r) => r.textContent.includes("Active"))), { what: "active invite listed" });
    const listed = await (await api(ctx.adminCookie, "GET", "/api/admin/invites")).text();
    check("the invite list never contains the secret", !listed.includes(token));
    await click(admin, ".modal .admin-table button", "Revoke");
    await waitFor(() => admin.page.evaluate(() => [...document.querySelectorAll(".modal .admin-table tbody tr")].some((r) => r.textContent.includes("Revoked"))), { what: "revoked status" });
    const use = await fetch(API + "/api/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Late" + t, invite: token }) });
    check("a revoked invite link stops working (403)", use.status === 403);

    // ---- office tab: rename, seen live by everybody (top bar and browser tab)
    const errors = [];
    admin.page.on("pageerror", (e) => errors.push(e.message));
    admin.page.on("response", (r) => { if (r.url().includes("/api/admin/office")) errors.push("PATCH " + r.status()); });
    const before = await mia.page.evaluate(() => window.__hq.state.office);
    check("the browser tab names the office", (await mia.page.title()) === "Home Quarters - " + before, await mia.page.title());
    await click(admin, ".modal [role=tab]", "Office");
    const field = await waitFor(() => admin.page.$("#office-name"), { what: "office name field" });
    await field.click();
    await field.evaluate((el) => el.select()); // typing replaces the current name
    await field.type("Harbour " + t);
    await click(admin, ".modal form button", "Rename");
    const seen = await waitFor(() => mia.page.evaluate((n) => document.querySelector(".topbar .brand")?.textContent === n, "Harbour " + t), { timeout: 5000 }).then(() => true, () => false);
    const why = seen ? "" : JSON.stringify(await Promise.all([mia.page.evaluate(() => document.querySelector(".topbar .brand")?.textContent), admin.page.evaluate(() => ({ field: document.querySelector("#office-name")?.value, toast: document.querySelector(".toast")?.textContent, brand: document.querySelector(".topbar .brand")?.textContent }))]));
    check("a rename reaches an online member's top bar without a reload", seen, why + " " + errors.join(" | ") + " " + admin.page.url());
    check("and her browser tab", (await mia.page.title()) === "Home Quarters - Harbour " + t, await mia.page.title());
    const stored = await (await api(ctx.adminCookie, "PATCH", "/api/admin/office", { name: "" })).status;
    check("an empty name is refused (400)", stored === 400, String(stored));
    const byMember = (await api(miaCookie, "PATCH", "/api/admin/office", { name: "Mine" })).status;
    check("a member cannot rename the office (403)", byMember === 403, String(byMember));

    // ---- the office name has no red frame; the current area hangs under it in the hint style
    await walkTo(mia, 8 * 16 + 8, 28 * 16 + 8); // social area
    await waitFor(() => mia.page.evaluate(() => !!window.__hq.state.currentArea), { what: "Mia in an area" });
    const look = await mia.page.evaluate(() => {
      const brand = document.querySelector(".topbar .brand"), hint = document.querySelector(".topbar .area-hint");
      const b = brand.getBoundingClientRect(), h = hint?.getBoundingClientRect();
      return { border: getComputedStyle(brand).borderTopWidth, area: hint?.textContent, want: window.__hq.state.currentArea, below: h ? h.top >= b.bottom && Math.abs(h.left - b.left) < 2 : false, pill: [...document.querySelectorAll(".topbar .pill")].some((p) => p.textContent === window.__hq.state.currentArea), hintStyle: !!hint?.classList.contains("hint") };
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
      const rect = (el) => el.getBoundingClientRect();
      const brand = rect(document.querySelector(".topbar .brand")), hint = document.querySelector(".topbar .area-hint"), h = rect(hint), mm = document.querySelector(".minimap");
      const m = mm ? rect(mm) : null;
      const overlaps = m && h.left < m.right && h.right > m.left && h.top < m.bottom && h.bottom > m.top;
      // what is seen there: the first element with a background (transparent containers hide nothing)
      const hit = document.elementsFromPoint((h.left + h.right) / 2, (h.top + h.bottom) / 2).find((el) => hint.contains(el) || getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)");
      const off = [...document.querySelectorAll(".topbar button")].filter((b) => { const r = rect(b); return r.width && (r.left < 0 || r.right > innerWidth); }).map((b) => b.textContent.trim());
      const bar = document.querySelector(".bar .hint"), pads = [...document.querySelectorAll(".touchpad button")].map(rect);
      const b = bar ? rect(bar) : null, row = rect(document.querySelector(".bar-row"));
      const onPad = pads.some((p) => p.left < row.right && p.right > row.left && p.top < row.bottom && p.bottom > row.top);
      return { brandH: Math.round(brand.height), overlaps, hintOnTop: hint.contains(hit), off, barHintH: b ? Math.round(b.height) : 0, onPad };
    });
    check("on a phone \"Proximity audio and video are off.\" fits on one line, clear of the touch pad", small.barHintH > 0 && small.barHintH < 30 && !small.onPad, JSON.stringify(small));
    check("on a phone a long office name stays on one line", small.brandH < 50, JSON.stringify(small));
    check("on a phone the area under the name is not covered by the minimap", !small.overlaps && small.hintOnTop, JSON.stringify(small));
    check("on a phone every top-bar button stays on screen", small.off.length === 0, JSON.stringify(small.off));
    await phone.page.screenshot({ path: path.join(os.tmpdir(), "homequarters-office-name-phone.png"), clip: { x: 0, y: 0, width: 390, height: 260 } });
    await phone.ctx.close();
    await api(ctx.adminCookie, "PATCH", "/api/admin/office", { name: before }); // shared office: put the name back

    // ---- activity tab
    await click(admin, ".modal [role=tab]", "Activity");
    await waitFor(() => admin.page.$(".modal .audit li"), { what: "activity list" });
    const audit = await admin.page.evaluate(() => document.querySelector(".modal .audit").textContent);
    check("the activity log records role changes and invite actions, by name", audit.includes("Admin changed the role of Mia" + t) && audit.includes("created an invite") && audit.includes("revoked an invite"), audit.slice(0, 160));
    check("and the rename, with the old and new name", audit.includes(`Admin renamed the office (${before} -> Harbour ${t})`), audit.slice(0, 200));

    // ---- removal
    await click(admin, ".modal [role=tab]", "Members");
    await waitFor(() => admin.page.$(".modal .admin-table"), { what: "members again" });
    await admin.page.evaluate((n) => document.querySelector('.modal button[aria-label="Remove ' + n + '"]').click(), "Rem" + t);
    await waitFor(() => click(admin, ".modal button", "Confirm removal"), { what: "confirm button" });
    await waitFor(() => rem.page.evaluate(() => !!document.querySelector(".join-card")), { timeout: 20000, what: "removed member lands on the join screen" });
    const note = await rem.page.evaluate(() => document.querySelector(".join-card .error")?.textContent ?? "");
    check("a removed member is disconnected at once and told why", note.includes("removed from this office"), note);
    const me = await (await fetch(API + "/api/me", { headers: { Cookie: "hq_session=" + remCookie } })).json();
    check("the removed member's session no longer works", me.authenticated === false);
    await waitFor(() => admin.page.evaluate((n) => ![...window.__hq.state.roster.values()].some((p) => p.n === n && p.s !== "offline"), "Rem" + t), { what: "roster no longer shows Rem online" });
    check("everybody sees the removed member leave", true);
    const ws = await api(remCookie, "GET", "/api/admin/members");
    check("the removed session cannot use the admin API either (401)", ws.status === 401);
    await sleep(200);
    return summary();
  } finally {
    await browser.close();
  }
}
