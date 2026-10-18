// Deploy versions: a page from the previous deploy notices the server moved on (once the socket
// reconnects) and asks to reload, in a dialog that cannot be dismissed.
import { check, resetChecks, summary, launch, joinAs, waitFor, sleep, APP } from "../lib.mjs";

const meta = (u) => u.page.evaluate(() => document.querySelector('meta[name="hq-version"]')?.content ?? "");
const dialog = (u) => u.page.evaluate(() => [...document.querySelectorAll(".modal")].find((m) => m.textContent.includes("new version"))?.textContent ?? "");

// The rename from Tilework: a browser that saved its name, avatar, settings and consent under the old
// keys keeps them, read through the join screen's real name field.
async function keepsLegacyStorage(browser, t) {
  const bctx = await browser.createBrowserContext();
  try {
    const page = await bctx.newPage();
    await page.goto(APP + "/", { waitUntil: "domcontentloaded" });
    await page.evaluate((t) => {
      localStorage.clear();
      localStorage.setItem("tilework.name", "Legacy" + t);
      localStorage.setItem("tilework.avatar", JSON.stringify({ sk: 3, hs: 2, hc: 1, sh: 0, pa: 2 }));
      localStorage.setItem("tilework.settings", JSON.stringify({ minimap: false }));
      localStorage.setItem("tilework.consent", "1");
    }, t);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("input", { timeout: 10000 });
    const got = await page.evaluate(() => ({
      field: document.querySelector("input")?.value ?? "",
      keys: Object.keys(localStorage).sort(),
      avatar: JSON.parse(localStorage.getItem("hq.avatar") ?? "null"),
      settings: JSON.parse(localStorage.getItem("hq.settings") ?? "null"),
      consent: localStorage.getItem("hq.consent"),
    }));
    check("an upgraded browser keeps its name in the join screen's field", got.field === "Legacy" + t, got.field);
    check("...and its avatar, settings and consent under hq.*, with no tilework.* key left",
      got.avatar?.sk === 3 && got.settings?.minimap === false && got.consent === "1" && !got.keys.some((k) => k.startsWith("tilework.")), got.keys.join(","));
  } finally {
    await bctx.close();
  }
}

export async function run(ctx) {
  resetChecks();
  const external = !!process.env.HQ_EXTERNAL_URL;
  const browser = await launch();
  const t = String(Date.now() % 10000);
  try {
    await keepsLegacyStorage(browser, t);
    if (external) return summary(); // the rest restarts the server
    const u = await joinAs(browser, "Upd" + t);
    const v1 = await meta(u);
    check("the page names the server's version and is up to date", v1.length > 0 && (await dialog(u)) === "", v1);

    // a deploy: the server comes back with another version
    process.env.HQ_VERSION = "e2e-next-" + t;
    await ctx.stopServer();
    await ctx.startServer();
    await waitFor(async () => (await dialog(u)) !== "", { timeout: 20000, what: "update dialog" });
    check("after a deploy the page asks to reload", (await dialog(u)).includes("Reload"));
    await u.page.keyboard.press("Escape");
    await u.page.mouse.click(5, 5); // outside the dialog
    await sleep(300);
    check("...in a dialog that Escape and a click outside do not close", (await dialog(u)) !== "");
    await Promise.all([u.page.waitForNavigation({ waitUntil: "domcontentloaded" }), u.page.evaluate(() => [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Reload")?.click())]);
    await waitFor(() => u.page.evaluate(() => window.__hq?.state?.conn === "open"), { timeout: 20000, what: "back in" });
    check("Reload brings the new version, and the dialog is gone", (await meta(u)) === "e2e-next-" + t && (await dialog(u)) === "");
  } catch (e) {
    check("scenario completed", false, e.message);
  } finally {
    await browser.close();
    if (!external) {
      delete process.env.HQ_VERSION;
      await ctx.stopServer();
      await ctx.startServer();
    }
  }
  return summary();
}
