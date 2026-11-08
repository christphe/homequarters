// Admin map editor through its real controls: painting walls previews at once, a new room is drawn, named
// and saved, and the saved edits reach another connected member live. The server's side of the same edit
// (admin only, validation, the size guard, the wall and the admins-only room enforced, no call alone in
// the new room, the edit kept across a restart) is tested in Go: httpapi/editor_test.go and
// world/editor_test.go.
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, API, type RunContext, type User } from "../lib.ts";
import type { MapData } from "../../web/src/net/protocol.ts";

const tileToClient = (u: User, tx: number, ty: number) =>
  u.page.evaluate((tx, ty) => {
    const v = window.__hq.view;
    const r = v.app.canvas.getBoundingClientRect();
    return { x: r.left + v.camX + (tx * 16 + 8) * v.S, y: r.top + v.camY + (ty * 16 + 8) * v.S };
  }, tx, ty);

async function drag(u: User, from: [number, number], to: [number, number]) {
  const a = await tileToClient(u, ...from), b = await tileToClient(u, ...to);
  await u.page.mouse.move(a.x, a.y);
  await u.page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) await u.page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  await u.page.mouse.up();
}
const chip = (u: User, text: string) => u.page.evaluate((text) => { const b = [...document.querySelectorAll<HTMLElement>(".editor .chip")].find((x) => x.textContent === text); b?.click(); return !!b; }, text);

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  try {
    const t = String(Date.now() % 10000);
    const [admin, mem] = await Promise.all([joinAs(browser, "Admin", { cookie: ctx.adminCookie }), joinAs(browser, "Ed" + t)]);
    const areas0 = await mem.page.evaluate(() => window.__hq.view.map!.areas.length);
    const map = await admin.page.evaluate(() => JSON.parse(JSON.stringify(window.__hq.view.map)) as MapData);
    // The world map redacts interactive-object content; round-trip the full map so later
    // scenarios (and real offices) do not lose note text, embed URLs or portal destinations.
    const full = (await (await fetch(API + "/api/admin/map", { headers: { Cookie: "hq_session=" + ctx.adminCookie } })).json()) as MapData;
    Object.assign(map, { props: full.props });
    const put = (cookie: string, body: object) => fetch(API + "/api/map", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + cookie }, body: JSON.stringify(body) });

    // ---- drive the real editor UI (the camera follows the admin: walk next to what is being edited)
    await walkTo(admin, 32 * 16 + 8, 22 * 16 + 8);
    await admin.page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Edit office")?.click());
    await waitFor(() => admin.page.$(".editor"), { what: "editor open" });
    await drag(admin, [35, 20], [35, 24]); // default tool: Walls
    check("painting walls updates the local preview immediately", await admin.page.evaluate(() => [20, 21, 22, 23, 24].every((y) => window.__hq.view.map!.walls[y][35] === "#")));
    await admin.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".editor button")].find((b) => b.textContent === "Save")?.click());
    await waitFor(() => mem.page.evaluate(() => window.__hq.view.map!.walls[22][35] === "#"), { what: "member receives the new wall" });
    await walkTo(admin, 12 * 16 + 8, 30 * 16 + 8);
    await chip(admin, "New room");
    await drag(admin, [14, 28], [19, 32]);
    await admin.page.type('.editor input[placeholder]', "Test room");
    await admin.page.select(".editor select[aria-label]", "admins");
    await admin.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".editor button")].find((b) => b.textContent === "Create room")?.click());
    await admin.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".editor button")].find((b) => b.textContent === "Save")?.click());

    await waitFor(() => mem.page.evaluate((n) => window.__hq.view.map!.areas.length === n, areas0 + 1), { what: "member receives the new room" });
    const room = await mem.page.evaluate(() => window.__hq.view.map!.areas.find((a) => a.name === "Test room"));
    check("saved edits reach other connected users live", !!room && room.access.mode === "admins" && room.x === 14 && room.y === 28 && room.w === 6 && room.h === 5, JSON.stringify(room));

    // Leave the shared office as we found it so later scenarios do not depend on this one.
    const restore = await put(ctx.adminCookie, map);
    check("the original map can be restored by the administrator", restore.status === 200);
    const errs = [admin, mem].flatMap((u) => u.logs).filter((l) => !/WebSocket|ERR_|net::|closed/.test(l));
    check("no unexpected console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
  }
  return summary();
}
