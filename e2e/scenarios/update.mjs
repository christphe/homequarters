// Deploy versions: a page from the previous deploy notices the server moved on (once the socket
// reconnects) and asks to reload, in a dialog that cannot be dismissed.
import { check, resetChecks, summary, launch, joinAs, waitFor, sleep } from "../lib.mjs";

const meta = (u) => u.page.evaluate(() => document.querySelector('meta[name="tilework-version"]')?.content ?? "");
const dialog = (u) => u.page.evaluate(() => [...document.querySelectorAll(".modal")].find((m) => m.textContent.includes("new version"))?.textContent ?? "");

export async function run(ctx) {
  resetChecks();
  if (process.env.TILEWORK_EXTERNAL_URL) return summary(); // needs to restart the server
  const browser = await launch();
  const t = String(Date.now() % 10000);
  try {
    const u = await joinAs(browser, "Upd" + t);
    const v1 = await meta(u);
    check("the page names the server's version and is up to date", v1.length > 0 && (await dialog(u)) === "", v1);

    // a deploy: the server comes back with another version
    process.env.TILEWORK_VERSION = "e2e-next-" + t;
    await ctx.stopServer();
    await ctx.startServer();
    await waitFor(async () => (await dialog(u)) !== "", { timeout: 20000, what: "update dialog" });
    check("after a deploy the page asks to reload", (await dialog(u)).includes("Reload"));
    await u.page.keyboard.press("Escape");
    await u.page.mouse.click(5, 5); // outside the dialog
    await sleep(300);
    check("...in a dialog that Escape and a click outside do not close", (await dialog(u)) !== "");
    await Promise.all([u.page.waitForNavigation({ waitUntil: "domcontentloaded" }), u.page.evaluate(() => [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Reload")?.click())]);
    await waitFor(() => u.page.evaluate(() => window.__tilework?.state?.conn === "open"), { timeout: 20000, what: "back in" });
    check("Reload brings the new version, and the dialog is gone", (await meta(u)) === "e2e-next-" + t && (await dialog(u)) === "");
  } catch (e) {
    check("scenario completed", false, e.message);
  } finally {
    await browser.close();
    delete process.env.TILEWORK_VERSION;
    await ctx.stopServer();
    await ctx.startServer();
  }
  return summary();
}
