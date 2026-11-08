// A request that fails on the network (no answer at all, as when the connection drops), through the real page: the map
// editor's Save with the request aborted in the browser shows its error and leaves no unhandled rejection. One
// bundle-level check of the path every panel shares (request() in web/src/net/http.ts never throws).
// What moved below the browser (decision 0037): each panel's own failure, with fetch rejecting as offline, in component
// tests: Settings > Save profile and Create a sign-in link in web/test/SettingsDialog.test.tsx; Admin > Members,
// Invites, Activity, Office > Rename, Announce, Plugins' on/off and the map editor opening in web/test/Offline.test.tsx.
// "The failed save leaves the server's map as it was" went: the server never got the request.
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, type RunContext, type User } from "../lib.ts";

const click = (u: User, selector: string, text: string) => u.page.evaluate((selector, text) => {
  const b = [...document.querySelectorAll<HTMLElement>(selector)].find((x) => x.textContent.trim() === text);
  b?.click();
  return !!b;
}, selector, text);
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
  for (let i = 1; i <= 12; i++) await u.page.mouse.move(a.x + ((b.x - a.x) * i) / 12, a.y + ((b.y - a.y) * i) / 12);
  await u.page.mouse.up();
}

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  try {
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    const { page } = admin;
    // the request to drop, "METHOD /path" (a path ending in * is a prefix); everything else goes through
    let failing = "";
    let aborted = 0;
    const matches = (key: string) => failing && (failing.endsWith("*") ? key.startsWith(failing.slice(0, -1)) : key === failing);
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.isInterceptResolutionHandled()) return;
      if (matches(req.method() + " " + new URL(req.url()).pathname)) {
        aborted++;
        void req.abort("internetdisconnected");
      } else void req.continue();
    });
    const toasts = () => page.evaluate(() => [...document.querySelectorAll(".toast")].map((x) => x.textContent ?? ""));
    // the console error of the aborted request itself is expected; an uncaught rejection is the bug
    const uncaught = () => admin.logs.filter((l) => /^pageerror|Uncaught/.test(l));
    const offline = async (what: string, key: string, act: () => Promise<unknown>, expected: string) => {
      // the store shows one toast at a time, for 4 s: wait for the previous step's one to go, so this
      // step's toast is its own even when the text is the same
      await waitFor(async () => (await toasts()).length === 0, { timeout: 6000, what: "no toast before " + what });
      failing = key;
      aborted = 0;
      const before = uncaught().length;
      const acted = await act();
      const seen = await waitFor(async () => (await toasts()).find((x) => x === expected) ?? null, { timeout: 5000, what }).catch(() => null);
      await new Promise((r) => setTimeout(r, 300)); // a rejection is reported right after the failed fetch
      const thrown = uncaught().slice(before);
      check(`${what} with no network: "${expected}" and no uncaught error`, acted !== false && aborted > 0 && !!seen && thrown.length === 0, JSON.stringify({ acted, aborted, toasts: await toasts(), thrown }));
      failing = "";
    };

    // ---- map editor: an edit, then Save
    await walkTo(admin, 32 * 16 + 8, 22 * 16 + 8);
    await waitFor(() => click(admin, "button", "Edit office"), { what: "Edit office" });
    await waitFor(() => page.$(".editor"), { what: "editor open" });
    await drag(admin, [35, 20], [35, 24]);
    await offline("Map editor > Save", "PUT /api/map", () => click(admin, ".editor button", "Save"), "Could not save");
    await page.keyboard.press("Escape");
  } finally {
    await browser.close();
  }
  return summary();
}
