// Private offices and desks through their real controls, one browser check per feature: an administrator assigns an
// office in the editor and everybody sees it labelled with its owner; a visitor knocks with the Knock button, the
// owner is asked and lets them in, and the visitor walks in; Ctrl+D runs the owner back into their office from the
// hall; a member with no place (the administrator) takes a free desk with Take this desk and its confirmation, and
// everybody sees it taken. The walks run at once where the story allows: they are most of the scenario's time.
// Moved down (no longer checked here):
// - the map stores the owner's id, not their name; a rename follows on the office for everybody: Go
//   TestOwnerNamesAreJoinedNotStored (httpapi/owners_test.go), TestPlacesAreNamedAfterTheirOwnersCurrentName
//   (world/desk_test.go), the label in web/test/places.test.ts;
// - which door and desk buttons show (Knock at a closed door, Enter anyway for an administrator, Lock desk and
//   Release desk in my desk room, Take this desk next to a free desk): web/test/doors.test.ts, web/test/home.test.ts;
//   Release desk and Enter anyway asking the session: web/test/SocialControlsPlaces.test.tsx;
// - owner and admitted visitor share the office's own call: Go TestAssignedOfficeOwnerKnockAndAdmit
//   (world/office_test.go);
// - an administrator forces the door, walks in, and the owner is told: TestAssignedOfficeOwnerKnockAndAdmit,
//   TestAForcedDoorIsInTheActivityLog (httpapi/doors_test.go), the toast's text in web/test/replies.test.ts;
// - the new owner of a desk stands in its room and can lock it; releasing frees the desk and its room for everybody:
//   Go TestClaimAFreeDeskNextToIt, TestReleaseMyDesk (world/desk_test.go), TestClaimDeskThroughTheAPI
//   (httpapi/desk_test.go).
// The other rules (who may walk in, lock or take a desk) are Go tests as well: world/office_test.go,
// world/desk_test.go, gamemap/offices_test.go; the editor's assign tool is web/test/mapModel.test.ts.
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, API, type RunContext, type User } from "../lib.ts";
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

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  const cookie = ctx.adminCookie;
  const full = (await (await fetch(API + "/api/admin/map", { headers: { Cookie: "hq_session=" + cookie } })).json()) as MapData;
  try {
    const t = String(Date.now() % 10000);
    const [boss, owner, guest] = await Promise.all([joinAs(browser, "Admin", { cookie }), joinAs(browser, "Owner" + t), joinAs(browser, "Guest" + t)]);

    // the owner heads for Office 2 (still free) and the visitor for its door, while the administrator takes a desk
    // and assigns the office: the walks are the scenario's time, so they run at once
    const placed = Promise.all([walkTo(owner, ...at(13, 42)), walkTo(guest, ...at(15, 37))]);

    // ---- a member without a place (the administrator, near the entrance) takes a free desk with the button next to it
    const desk = await boss.page.evaluate(() => window.__hq.view.map!.props.find((p) => p.t === "desk" && !p.assign && p.y < 14)!);
    const assigned = (u: User) => u.page.evaluate((x, y) => window.__hq.view.map!.props.find((p) => p.t === "desk" && p.x === x && p.y === y)?.assign, desk.x, desk.y);
    await walkTo(boss, ...at(desk.x + 1, desk.y + 1));
    await waitFor(() => hasButton(boss, /^Take this desk$/), { what: "Take this desk button" });
    await button(boss, /^Take this desk$/);
    await waitFor(() => boss.page.$("[role=dialog]"), { what: "confirmation" });
    await button(boss, /^Take it$/);
    await waitFor(async () => (await assigned(guest)) === boss.id, { what: "everybody sees the desk taken" });
    check("Take this desk and its confirmation give the desk to the member, for everybody", true);

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
    const office = await areaOf(guest, "office-2");
    check("the editor assigns the office: everybody sees it labelled with its owner's name", shown && office!.access.users?.[0] === owner.id,
      (await labels(guest)).filter((l) => l.startsWith("Office")).join(" | ") + " " + JSON.stringify(office!.access));
    await boss.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".editor button")].find((b) => b.textContent === "Close")?.click());
    const oi = await areaIndex(guest, "office-2");

    // ---- the owner sits in their office; a visitor knocks from the hall with the Knock button and is let in
    await placed;
    await waitFor(async () => (await here(owner)) === oi, { what: "owner in their office" });
    await waitFor(() => hasButton(guest, /^Knock · Office 2/), { what: "knock button" });
    await button(guest, /^Knock · Office 2/);
    await waitFor(() => owner.page.evaluate(() => !!window.__hq.state.knock), { what: "owner asked" });
    await waitFor(() => owner.page.evaluate(() => [...document.querySelectorAll(".modal button")].some((b) => b.textContent === "Let in")), { what: "knock dialog" });
    check("the owner is asked who is knocking", await owner.page.evaluate((n) => !!document.querySelector(".modal")?.textContent.includes(n), guest.name));
    await owner.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Let in")?.click());
    await waitFor(() => guest.page.evaluate((oi) => !window.__hq.view.deny.has(oi), oi), { what: "visitor admitted" }).catch(async (e) => {
      console.log("DIAG", JSON.stringify({ ownerKnock: await owner.page.evaluate(() => window.__hq.state.knock), guestDeny: await guest.page.evaluate(() => [...window.__hq.view.deny]), toast: await guest.page.evaluate(() => document.querySelector(".toast")?.textContent), ownerArea: await here(owner), oi }));
      throw e;
    });

    // ---- the visitor walks in while Ctrl+D brings the owner back to their office from the hall, with the real keys
    const walkedIn = walkTo(guest, ...at(15, 42)).then(async () => (await here(guest)) === oi, () => false);
    await walkTo(owner, ...at(13, 37));
    await owner.page.keyboard.down("Control");
    await owner.page.keyboard.press("d");
    await owner.page.keyboard.up("Control");
    await waitFor(async () => (await here(owner)) === oi && !(await owner.page.evaluate(() => window.__hq.view.guided)), { timeout: 20000, what: "owner back in their office" });
    check("Ctrl+D runs the owner back into their own office", true);
    check("the admitted visitor walks in", await walkedIn);
    const errs = [boss, owner, guest].flatMap((u) => u.logs);
    check("no console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  } catch (e) {
    check("scenario completed", false, (e as Error).message);
  } finally {
    // the original map, with the office and the desk free again
    const put = await fetch(API + "/api/map", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + cookie }, body: JSON.stringify(full) });
    if (!put.ok) console.log("could not restore the map", put.status);
    await browser.close();
  }
  return summary();
}
