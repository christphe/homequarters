// Private offices and desks through the real UI: an administrator assigns an office in the editor, a
// visitor knocks with the Knock button, the owner lets them in, and the two share the office's own call;
// an administrator forces the door with Enter anyway; a member takes a free desk and releases it with
// its buttons. The rules behind them are tested lower down: who may walk in, lock, force or take a desk
// in Go (world/office_test.go, world/desk_test.go, gamemap/offices_test.go, httpapi/desk_test.go,
// httpapi/doors_test.go, httpapi/owners_test.go), which buttons show in web/test/doors.test.ts and
// web/test/home.test.ts, the editor's assign tool in web/test/mapModel.test.ts.
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, st, API, type RunContext, type User } from "../lib.ts";
import type { MapData } from "../../web/src/net/protocol.ts";

const T = 16;
const at = (tx: number, ty: number): [number, number] => [tx * T + 8, ty * T + 8];
const button = (u: User, re: RegExp) => u.page.evaluate((src) => {
  const b = [...document.querySelectorAll("button")].find((x) => new RegExp(src).test(x.textContent.trim()));
  b?.click(); return !!b;
}, re.source);
const hasButton = (u: User, re: RegExp) => u.page.evaluate((src) => [...document.querySelectorAll("button")].some((x) => new RegExp(src).test(x.textContent.trim())), re.source);
const areaOf = (u: User, id: string) => u.page.evaluate((id) => window.__hq.view.map!.areas.find((a) => a.id === id), id);
const areaIndex = (u: User, id: string) => u.page.evaluate((id) => window.__hq.view.map!.areas.findIndex((a) => a.id === id), id);
const here = (u: User) => u.page.evaluate(() => window.__hq.view.mArea);
// the desk and area labels as drawn on the map: owner names are joined there, never stored in the map
const labels = (u: User) => u.page.evaluate(() => window.__hq.view.labels().map((l) => l.replace(/ 🔒$/, "")));
const clickText = (u: User, selector: string, text: string) => u.page.evaluate((selector, text) => {
  const b = [...document.querySelectorAll<HTMLElement>(selector)].find((x) => x.textContent.trim() === text);
  b?.click();
  return !!b;
}, selector, text);

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  const cookie = ctx.adminCookie;
  const full = (await (await fetch(API + "/api/admin/map", { headers: { Cookie: "hq_session=" + cookie } })).json()) as MapData;
  try {
    const t = String(Date.now() % 10000);
    const [boss, owner, guest] = await Promise.all([joinAs(browser, "Admin", { cookie }), joinAs(browser, "Owner" + t), joinAs(browser, "Guest" + t)]);

    // ---- the administrator assigns Office 2 to Owner in the editor (same tool as desks)
    await walkTo(boss, ...at(12, 37));
    await boss.page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Edit office")?.click());
    await waitFor(() => boss.page.$(".editor"), { what: "editor open" });
    await boss.page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".editor .chip")].find((x) => x.textContent === "Assign desk or office")?.click());
    await waitFor(() => boss.page.$(".editor select"), { what: "person picker" });
    await boss.page.select(".editor select", String(owner.id));
    const p = await boss.page.evaluate((tx, ty) => { const v = window.__hq.view, r = v.app.canvas.getBoundingClientRect(); return { x: r.left + v.camX + (tx * 16 + 8) * v.S, y: r.top + v.camY + (ty * 16 + 8) * v.S }; }, 13, 43);
    await boss.page.mouse.click(p.x, p.y);
    await waitFor(() => boss.page.evaluate(() => !document.querySelector<HTMLButtonElement>(".editor .primary")?.disabled), { what: "editor dirty" });
    await boss.page.evaluate(() => document.querySelector<HTMLButtonElement>(".editor .primary")!.click());
    const shown = await waitFor(async () => (await labels(guest)).includes("Office 2 · " + owner.name), { what: "office label reaches others" }).then(() => true, () => false);
    check("everybody sees the office labelled with its owner's name", shown, (await labels(guest)).filter((l) => l.startsWith("Office")).join(" | "));
    const office = await areaOf(guest, "office-2");
    check("the editor assigns the office and everybody sees its owner's name", office!.access.users?.[0] === owner.id, office!.name);
    check("the map stores the owner's id, not their name", office!.name === "Office 2", office!.name);
    await boss.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".editor button")].find((b) => b.textContent === "Close")?.click());

    // ---- the owner renames themselves in the settings: their office shows the new name for everybody
    const renamed = "Ren" + t;
    await owner.page.evaluate(() => document.querySelector<HTMLButtonElement>('button[title="Settings"]')!.click());
    await waitFor(() => owner.page.$('.modal input[aria-label="Your name"]'), { what: "settings dialog" });
    await owner.page.focus('.modal input[aria-label="Your name"]');
    await owner.page.keyboard.down("Control");
    await owner.page.keyboard.press("KeyA");
    await owner.page.keyboard.up("Control");
    await owner.page.keyboard.press("Backspace");
    await owner.page.type('.modal input[aria-label="Your name"]', renamed);
    await clickText(owner, ".modal button", "Save profile");
    const followed = await waitFor(async () => (await labels(guest)).includes("Office 2 · " + renamed), { timeout: 5000, what: "renamed label" }).then(() => true, () => false);
    check("a rename shows on the owner's office for everybody, without a reload", followed, (await labels(guest)).filter((l) => l.startsWith("Office 2")).join());
    await owner.page.keyboard.press("Escape");
    owner.name = renamed;
    const oi = await areaIndex(guest, "office-2");

    // ---- the owner sits in their office; a visitor knocks from the hall, is let in, shares the office call
    await Promise.all([walkTo(owner, ...at(13, 42)), walkTo(guest, ...at(15, 37))]);
    await waitFor(async () => (await here(owner)) === oi, { what: "owner in their office" });
    await waitFor(() => hasButton(guest, /^Knock · Office 2/), { what: "knock button" });
    check("standing at the door, the visitor sees a Knock button", true);
    await button(guest, /^Knock · Office 2/);
    await waitFor(() => owner.page.evaluate(() => !!window.__hq.state.knock), { what: "owner asked" });
    await waitFor(() => owner.page.evaluate(() => [...document.querySelectorAll(".modal button")].some((b) => b.textContent === "Let in")), { what: "knock dialog" });
    check("the owner is asked who is knocking", await owner.page.evaluate((n) => !!document.querySelector(".modal")?.textContent.includes(n), guest.name));
    await owner.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Let in")?.click());
    await waitFor(() => guest.page.evaluate((oi) => !window.__hq.view.deny.has(oi), oi), { what: "visitor admitted" }).catch(async (e) => {
      console.log("DIAG", JSON.stringify({ ownerKnock: await owner.page.evaluate(() => window.__hq.state.knock), guestDeny: await guest.page.evaluate(() => [...window.__hq.view.deny]), toast: await guest.page.evaluate(() => document.querySelector(".toast")?.textContent), ownerArea: await here(owner), oi }));
      throw e;
    });
    await walkTo(guest, ...at(15, 42));
    check("the admitted visitor walks in", (await here(guest)) === oi);
    await Promise.all([owner, guest].map((u) => u.page.evaluate(() => window.__hq.session.setConsent(true))));
    await waitFor(async () => (await st(owner)).conv?.kind === "r" && (await st(guest)).conv?.kind === "r" && (await st(guest)).conv?.state === "live", { timeout: 30000, what: "office call" });
    const conv = (await st(owner)).conv;
    check("owner and visitor share the office's own call", !!conv!.name?.startsWith("Office 2"), JSON.stringify(conv));

    // the visitor heads for a free desk (taken below) while the owner and the administrator go on
    const desk = await boss.page.evaluate(() => window.__hq.view.map!.props.find((p) => p.t === "desk" && !p.assign && p.y < 14)!);
    const guestAtDesk = walkTo(guest, ...at(desk.x + 1, desk.y + 1)).then(() => null, (e: Error) => e);

    // ---- Ctrl+D brings the owner back to their office from the hall, with the real keys
    await walkTo(owner, ...at(13, 37));
    await owner.page.keyboard.down("Control");
    await owner.page.keyboard.press("d");
    await owner.page.keyboard.up("Control");
    await waitFor(async () => (await here(owner)) === oi && !(await owner.page.evaluate(() => window.__hq.view.guided)), { timeout: 20000, what: "owner back in their office" });
    check("Ctrl+D runs the owner back into their own office", true);

    // ---- an administrator at the closed door forces it on purpose with Enter anyway; the owner is told
    await walkTo(boss, ...at(14, 37));
    await waitFor(() => hasButton(boss, /^Enter anyway \(admin\)$/), { what: "force button" });
    await button(boss, /^Enter anyway \(admin\)$/);
    await waitFor(() => boss.page.evaluate((oi) => !window.__hq.view.deny.has(oi), oi), { what: "door forced" });
    await walkTo(boss, ...at(14, 41));
    check("after forcing, the administrator walks in", (await here(boss)) === oi);
    await waitFor(() => owner.page.evaluate(() => document.querySelector(".toast")?.textContent.includes("(admin) entered")), { what: "owner told" });
    check("the owner is told an administrator entered", true);

    // ---- a member without a place takes a free desk with the button shown next to it
    const takeDesk = /^Take this desk$/;
    const assigned = (u: User) => u.page.evaluate((x, y) => window.__hq.view.map!.props.find((p) => p.t === "desk" && p.x === x && p.y === y)?.assign, desk.x, desk.y);
    const deskRoom = (u: User) => u.page.evaluate((id) => window.__hq.view.map!.areas.find((a) => a.id === id) ?? null, `desk-${desk.x}-${desk.y}`);
    const walkErr = await guestAtDesk;
    if (walkErr) throw walkErr;
    await waitFor(() => hasButton(guest, takeDesk), { what: "Take this desk button" });
    check("a member with no desk sees Take this desk next to a free desk", true);
    await button(guest, takeDesk);
    await waitFor(() => guest.page.$("[role=dialog]"), { what: "confirmation" });
    await button(guest, /^Take it$/);
    await waitFor(async () => (await assigned(boss)) === guest.id, { what: "everybody sees the desk taken" });
    check("confirming gives the desk to the member, for everybody", true);
    const lockable = await waitFor(() => hasButton(guest, /^Lock desk$/), { timeout: 3000, what: "Lock desk without moving" }).then(() => true, () => false);
    check("without moving, the new owner is in their desk room and can lock it", lockable);

    // ---- the owner frees it with Release desk, next to Lock desk
    await waitFor(() => hasButton(guest, /^Release desk$/), { what: "Release desk button" });
    check("the owner sees Release desk next to Lock desk in their desk room", await hasButton(guest, /^Lock desk$/));
    await button(guest, /^Release desk$/);
    await waitFor(() => guest.page.$("[role=dialog]"), { what: "release confirmation" });
    await button(guest, /^Release it$/);
    await waitFor(async () => !(await assigned(boss)) && (await deskRoom(boss)) === null, { what: "the desk is free again for everybody" });
    check("releasing frees the desk and removes its room for everybody", true);
    const errs = [boss, owner, guest].flatMap((u) => u.logs);
    check("no console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  } catch (e) {
    check("scenario completed", false, (e as Error).message);
  } finally {
    const put = await fetch(API + "/api/map", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + cookie }, body: JSON.stringify(full) });
    if (!put.ok) console.log("could not restore the map", put.status);
    await browser.close();
  }
  return summary();
}
