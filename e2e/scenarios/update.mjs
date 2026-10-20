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

// Installable as an app (Chrome/Edge "Install"): Chrome itself reports no installability error and reads
// the manifest, with no service worker in the way of deploys.
async function installable(browser) {
  const page = await browser.newPage();
  try {
    await page.goto(APP + "/", { waitUntil: "load" });
    const cdp = await page.createCDPSession();
    const { manifest } = await waitFor(async () => {
      const r = await cdp.send("Page.getAppManifest");
      return r.url && r.data ? { manifest: { url: r.url, data: JSON.parse(r.data) } } : null;
    }, { timeout: 10000, what: "manifest" });
    const m = manifest.data;
    const icons = (m.icons ?? []).map((i) => i.sizes + "/" + (i.purpose ?? "any"));
    check("the page links a manifest for Home Quarters, standalone, from /",
      m.name === "Home Quarters" && m.display === "standalone" && m.start_url === "/" && m.scope === "/", JSON.stringify({ name: m.name, display: m.display, start: m.start_url, scope: m.scope }));
    check("...with 192 and 512 px icons, one of them maskable",
      icons.includes("192x192/any") && icons.includes("512x512/any") && icons.some((i) => i.endsWith("/maskable")), icons.join(","));
    const res = await page.evaluate(async (u) => { const r = await fetch(u); return { ok: r.ok, type: r.headers.get("content-type") }; }, manifest.url);
    check("...and every icon it names loads", (await page.evaluate(async (list, base) => {
      for (const i of list) { const r = await fetch(new URL(i.src, base)); if (!r.ok || !(r.headers.get("content-type") ?? "").startsWith("image/")) return false; }
      return true;
    }, m.icons ?? [], manifest.url)) && res.ok, res.type ?? "");
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    check("Chrome finds the client installable", installabilityErrors.length === 0, installabilityErrors.map((e) => e.errorId).join(","));
    check("...without a service worker", !(await page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0)));
  } finally {
    await page.close();
  }
}

export async function run(ctx) {
  resetChecks();
  const external = !!process.env.HQ_EXTERNAL_URL;
  const browser = await launch();
  const t = String(Date.now() % 10000);
  try {
    await keepsLegacyStorage(browser, t);
    await installable(browser);
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
