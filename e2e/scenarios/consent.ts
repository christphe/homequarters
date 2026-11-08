// Consent, busy status and eligibility for automatic conversations, through the real opt-in and leave controls.
// The server's rules (no consent or one side only: no conversation; busy blocks entry; a second client of the
// same account that never opted in leaves the call) are Go tests: TestConsentIsNeededFromBothSides,
// TestBusyAndNoConsentNeverJoin, TestASecondClientThatHasNotConsentedLeavesTheCall (server/internal/world),
// with the client's half in web/test/helloReplies.test.ts.
import { check, launch, joinAs, waitFor, walkTo, st, resetChecks, type User } from "../lib.ts";

/** Opts in through the media bar's "Enable audio and video" and the consent dialog's Enable. */
async function enable(u: User): Promise<boolean> {
  const opened = await u.page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /enable audio/i.test(x.textContent)); b?.click(); return !!b; });
  await waitFor(() => u.page.$(".modal"), { what: "consent dialog of " + u.name });
  await u.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Enable")?.click());
  await waitFor(async () => (await st(u)).consent, { what: u.name + " consented" });
  return opened;
}

export async function run(): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  try {
    const t = String(Date.now() % 10000);
    const a = await joinAs(browser, "Cia" + t);
    const b = await joinAs(browser, "Cib" + t);
    await walkTo(a, 12 * 16 + 8, 30 * 16 + 8);
    await walkTo(b, 12 * 16 + 40, 30 * 16 + 8);

    const before = [await st(a), await st(b)];
    check("before anybody opts in nothing is captured and nobody is in a conversation", before.every((s) => !s.consent && s.conv === null && !s.mic && !s.cam), JSON.stringify(before));

    const opened = (await enable(a)) && (await enable(b));
    await waitFor(async () => (await st(a)).conv?.state === "live" && (await st(b)).conv?.state === "live", { timeout: 15000, what: "conversation after both enabled" });
    check("both opt in through the media bar's Enable and the dialog: the conversation forms", opened);

    await b.page.evaluate(() => window.__hq.session.setStatus("busy"));
    await waitFor(async () => (await st(b)).conv === null, { timeout: 8000, what: "B leaves when busy" });
    // Leaving is asynchronous (the room disconnects and tracks stop); it must finish within a moment.
    const stopped = await waitFor(async () => (await st(b)).mic === false && (await b.page.evaluate(() => (window.__hq.media as unknown as { room: unknown }).room === null || (window.__hq.media as unknown as { room: unknown }).room === undefined)), { timeout: 4000, what: "capture stops" }).catch(() => false);
    check("becoming Busy leaves the conversation and stops B's capture", !!stopped);

    // Invisible: other clients no longer see the avatar; roster shows offline
    await b.page.evaluate(() => window.__hq.session.setStatus("invisible"));
    await waitFor(async () => !(await a.page.evaluate((id) => window.__hq.view.debugEntities().some((e) => e.id === id), b.id)), { timeout: 3000, what: "B hidden" }).catch(() => {});
    const seen = await a.page.evaluate((id) => window.__hq.view.debugEntities().some((e) => e.id === id), b.id);
    const rosterSt = await a.page.evaluate((id) => window.__hq.state.roster.get(id)?.s, b.id);
    check("Invisible hides the avatar from others and shows offline in the roster", !seen && rosterSt === "offline", "seen=" + seen + " roster=" + rosterSt);

    // Consent revoked through the media bar's Leave button: leaves immediately
    await b.page.evaluate(() => { window.__hq.session.setStatus("available"); });
    await waitFor(async () => (await st(b)).conv?.state === "live", { timeout: 15000, what: "rejoin" });
    await waitFor(() => b.page.$('button[title="Leave conversation"]'), { what: "the media bar's Leave button" });
    await b.page.click('button[title="Leave conversation"]');
    await waitFor(async () => (await st(b)).conv === null, { timeout: 5000, what: "leave on consent off" });
    check("the media bar's Leave turns consent off and leaves the conversation immediately", (await st(b)).consent === false);

    const errs = [...a.logs, ...b.logs];
    check("no console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
  }
  return (await import("../lib.ts")).summary();
}
