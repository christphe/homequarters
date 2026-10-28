// Requests that fail on the network (no answer at all, as when the connection drops) through the real controls:
// each panel shows its error and the page has no unhandled rejection. The requests are aborted in the browser.
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo } from "../lib.mjs";

const click = (u, selector, text) => u.page.evaluate((selector, text) => {
  const b = [...document.querySelectorAll(selector)].find((x) => x.textContent.trim() === text);
  b?.click();
  return !!b;
}, selector, text);
const tileToClient = (u, tx, ty) =>
  u.page.evaluate((tx, ty) => {
    const v = window.__hq.view;
    const r = v.app.canvas.getBoundingClientRect();
    return { x: r.left + v.camX + (tx * 16 + 8) * v.S, y: r.top + v.camY + (ty * 16 + 8) * v.S };
  }, tx, ty);
async function drag(u, from, to) {
  const a = await tileToClient(u, ...from), b = await tileToClient(u, ...to);
  await u.page.mouse.move(a.x, a.y);
  await u.page.mouse.down();
  for (let i = 1; i <= 12; i++) await u.page.mouse.move(a.x + ((b.x - a.x) * i) / 12, a.y + ((b.y - a.y) * i) / 12);
  await u.page.mouse.up();
}

export async function run(ctx) {
  resetChecks();
  const browser = await launch();
  try {
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    const { page } = admin;
    // the request to drop, "METHOD /path" (a path ending in * is a prefix); everything else goes through
    let failing = "";
    let aborted = 0;
    const matches = (key) => failing && (failing.endsWith("*") ? key.startsWith(failing.slice(0, -1)) : key === failing);
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
    const offline = async (what, key, act, expected) => {
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

    // ---- Settings
    await page.evaluate(() => document.querySelector('button[title="Settings"]')?.click());
    await waitFor(() => page.$('.modal input[aria-label="Your name"]'), { what: "settings open" });
    await offline("Settings > Save profile", "PUT /api/profile", () => click(admin, ".modal button", "Save profile"), "Could not save the profile");
    await offline("Settings > Create a sign-in link", "POST /api/account-link", () => click(admin, ".modal button", "Create a sign-in link"), "Could not create a link.");
    await page.keyboard.press("Escape");

    // ---- Administration: loading a tab, renaming the office, an announcement
    await offline("Admin > Members", "GET /api/admin/members", () => waitFor(() => click(admin, ".topbar button", "Admin"), { what: "Admin button" }), "Something went wrong.");
    await click(admin, ".modal [role=tab]", "Office");
    const field = await waitFor(() => page.$("#office-name"), { what: "office name field" });
    const name = await field.evaluate((el) => el.value);
    await field.click({ clickCount: 3 });
    await field.type(name + " 2");
    await offline("Admin > Office > Rename", "PATCH /api/admin/office", () => click(admin, ".modal button", "Rename"), "Something went wrong.");
    await click(admin, ".modal [role=tab]", "Announce");
    await waitFor(() => page.$("#announce-text"), { what: "announce field" });
    await page.type("#announce-text", "Back in five");
    await offline("Admin > Announce", "POST /api/admin/announce", () => click(admin, ".modal form button", "Announce"), "Something went wrong.");
    await click(admin, ".modal [role=tab]", "Plugins");
    const toggle = await waitFor(() => page.evaluate(() => document.querySelector('.modal button[aria-label^="Turn "]')?.getAttribute("aria-label")), { what: "a plugin's on/off button" });
    const title = toggle.replace(/^Turn (on|off) /, "");
    await offline("Admin > Plugins > " + toggle, "PUT /api/admin/plugins/*", () => page.evaluate((l) => { const b = document.querySelector(`.modal button[aria-label="${l}"]`); b?.click(); return !!b; }, toggle), `${title} could not start: Something went wrong.`);
    await page.keyboard.press("Escape");

    // ---- map editor: an edit, then Save
    await walkTo(admin, 32 * 16 + 8, 22 * 16 + 8);
    await offline("Map editor > open", "GET /api/admin/map", () => waitFor(() => click(admin, "button", "Edit office"), { what: "Edit office" }), "Could not load the editable map. Close the editor and try again.");
    await click(admin, ".editor button", "Close");
    await waitFor(async () => !(await page.$(".editor")), { what: "editor closed" });
    await waitFor(() => click(admin, "button", "Edit office"), { what: "Edit office" });
    await waitFor(() => page.$(".editor"), { what: "editor open" });
    const savedMap = () => page.evaluate(() => fetch("/api/admin/map").then((r) => r.text()));
    const mapBefore = await savedMap();
    await drag(admin, [35, 20], [35, 24]);
    await offline("Map editor > Save", "PUT /api/map", () => click(admin, ".editor button", "Save"), "Could not save");
    check("the failed save leaves the server's map as it was", (await savedMap()) === mapBefore);
    await page.keyboard.press("Escape");
  } finally {
    await browser.close();
  }
  return summary();
}
