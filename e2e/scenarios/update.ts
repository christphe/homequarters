// Deploy versions: a page from the previous deploy notices the server moved on (once the socket reconnects) and asks
// to reload, and Reload brings the new version; and Chrome's own verdict that the client installs as an app, with no
// service worker in the way of deploys.
// What moved below the browser (decision 0037), and where it lives now:
// - the dialog staying open on Escape and a click outside: web/test/UpdateBanner.test.tsx; a page from another deploy
//   being outdated: web/test/version.test.ts; the page naming the server's version: TestThePageCarriesTheServerVersion
//   (server/internal/httpapi/static_test.go).
// - the manifest's name, display, start and scope, its 192, 512 and maskable icons, each a PNG of its size:
//   web/test/manifest.test.ts; served as a manifest, revalidated: TestTheManifestIsServedAsAManifestAndRevalidated.
// - a browser upgraded from the Tilework keys keeping its name, avatar, settings and consent under hq.*:
//   web/test/storageMigration.test.ts, run as the store loads: storeLoad.test.ts; the join field showing the saved name:
//   web/test/JoinScreen.test.tsx.
import type { Browser } from "puppeteer-core";
import { check, resetChecks, summary, launch, joinAs, waitFor, APP, type RunContext, type User } from "../lib.ts";

const meta = (u: User) => u.page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="hq-version"]')?.content ?? "");
const dialog = (u: User) => u.page.evaluate(() => [...document.querySelectorAll(".modal")].find((m) => m.textContent.includes("new version"))?.textContent ?? "");

// Installable as an app (Chrome/Edge "Install"): Chrome itself reports no installability error and reads
// the manifest, with no service worker in the way of deploys.
async function installable(browser: Browser) {
  const page = await browser.newPage();
  try {
    await page.goto(APP + "/", { waitUntil: "load" });
    const cdp = await page.createCDPSession();
    await waitFor(async () => { const r = await cdp.send("Page.getAppManifest"); return r.url && r.data ? true : null; }, { timeout: 10000, what: "manifest" });
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    check("Chrome finds the client installable", installabilityErrors.length === 0, installabilityErrors.map((e: { errorId: string }) => e.errorId).join(","));
    check("...without a service worker", !(await page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0)));
  } finally {
    await page.close();
  }
}

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const external = !!process.env.HQ_EXTERNAL_URL;
  const browser = await launch();
  const t = String(Date.now() % 10000);
  try {
    await installable(browser);
    if (external) return summary(); // the rest restarts the server
    const u = await joinAs(browser, "Upd" + t);
    await waitFor(async () => (await meta(u)).length > 0 && (await dialog(u)) === "", { what: "the page up to date" });

    // a deploy: the server comes back with another version
    process.env.HQ_VERSION = "e2e-next-" + t;
    await ctx.stopServer();
    await ctx.startServer();
    await waitFor(async () => (await dialog(u)) !== "", { timeout: 20000, what: "update dialog" });
    check("after a deploy the page asks to reload", (await dialog(u)).includes("Reload"));
    await Promise.all([u.page.waitForNavigation({ waitUntil: "domcontentloaded" }), u.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Reload")?.click())]);
    await waitFor(() => u.page.evaluate(() => window.__hq?.state?.conn === "open"), { timeout: 20000, what: "back in" });
    check("Reload brings the new version, and the dialog is gone", (await meta(u)) === "e2e-next-" + t && (await dialog(u)) === "");
  } catch (e) {
    check("scenario completed", false, (e as Error).message);
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
