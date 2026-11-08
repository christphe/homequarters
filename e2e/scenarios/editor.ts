// Admin map editor through its real controls, on the real map: walls painted with the mouse show in the preview at
// once, and the editor's Save button stores them on the server.
// Moved down (no longer checked here):
// - a room dragged, named, given its access, created and saved in one PUT; a refused save explained:
//   web/test/MapEditor.test.tsx;
// - the saved edits reach the other people online at once, and survive a restart; admin only, validated, the size
//   guard: Go TestPutMapIsAdminOnlyValidatedLiveAndSurvivesARestart (httpapi/editor_test.go), the new walls and
//   rooms enforced at once in TestAnEditedMapAppliesItsNewWallsAndRoomsAtOnce (world/editor_test.go).
// The editor's other real-controls checks: a private office assigned (offices.ts), a desk erased and drawn (depth.ts).
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

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  const get = async () => (await (await fetch(API + "/api/admin/map", { headers: { Cookie: "hq_session=" + ctx.adminCookie } })).json()) as MapData;
  // The world map redacts interactive-object content: keep the full map, so later scenarios (and real offices) do
  // not lose note text, embed URLs or portal destinations when it is put back.
  const original = await get();
  try {
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });

    // ---- drive the real editor UI (the camera follows the admin: walk next to what is being edited)
    await walkTo(admin, 32 * 16 + 8, 22 * 16 + 8);
    await admin.page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Edit office")?.click());
    await waitFor(() => admin.page.$(".editor"), { what: "editor open" });
    await drag(admin, [35, 20], [35, 24]); // default tool: Walls
    check("painting walls updates the local preview immediately", await admin.page.evaluate(() => [20, 21, 22, 23, 24].every((y) => window.__hq.view.map!.walls[y][35] === "#")));
    await waitFor(() => admin.page.evaluate(() => !document.querySelector<HTMLButtonElement>(".editor .primary")?.disabled), { what: "Save enabled" });
    await admin.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".editor button")].find((b) => b.textContent === "Save")?.click());
    await waitFor(() => admin.page.evaluate(() => [...document.querySelectorAll(".toast")].some((x) => x.textContent.includes("Office saved"))), { what: "saved toast" });
    const saved = await get();
    check("Save stores the painted walls on the server", [20, 21, 22, 23, 24].every((y) => saved.walls[y][35] === "#"));
    const errs = admin.logs.filter((l) => !/WebSocket|ERR_|net::|closed/.test(l));
    check("no unexpected console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
    // leave the shared office as we found it so later scenarios do not depend on this one
    const restore = await fetch(API + "/api/map", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify(original) });
    check("the original map is put back", restore.status === 200);
  }
  return summary();
}
