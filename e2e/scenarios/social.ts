// The chat panel, a profile change and the chat panel on small screens, through the real controls: a message sent
// through the composer with both panels open, a name and look saved through the settings and appearance dialogs
// reaching another person, labels sharing one bitmap font per look, nothing covering the chat panel's controls at
// 800x450 and on a phone, and the phone's reactions fitting the screen.
// The chat rules are Go tests: scopes, trimming, the 500-character cut and what history keeps in
// server/internal/world/chat_test.go (TestChatScopesReachTheirAudienceTrimmedAndCut); the rate limit, history for
// newcomers and across a restart, and profile refusals in server/internal/httpapi/resilience_test.go.
// What moved below the browser (decision 0037), and where it lives now:
// - the avatar editor's hair, beards, hats, hat colours once a hat is on, any shirt colour: web/test/AvatarEditor.test.tsx;
//   the appearance dialog's look saved with the profile, and no Sign out without sign-in: web/test/SettingsDialog.test.tsx.
// - another person seeing the new hair, beard, hat and custom shirt: web/test/avatarLook.test.ts and
//   TestNormalizeAvatarDropsUnknownFields; a profile change reaching the roster (also checked here):
//   TestHelloCarriesOfficeChatHistoryAndProfileChangesReachTheRoster (server/internal/world/world_test.go); look changes
//   leaving the avatar cache the same size: web/test/lookCache.test.ts.
// - a desk assigned by an admin and its owner's label: server/internal/httpapi/desk_test.go, owners_test.go and
//   web/test/places.test.ts (the map edit stays here, as the setup of the bitmap font check).
// - the conversation composer off without a conversation, a phone reaction closing the menu:
//   web/test/SocialPanel.test.tsx.
import { check, summary, resetChecks, launch, joinAs, waitFor, API, type RunContext } from "../lib.ts";
import type { MapData } from "../../web/src/net/protocol.ts";

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  try {
    const t = String(Date.now() % 10000);
    const a = await joinAs(browser, "Sa" + t);
    const b = await joinAs(browser, "Sb" + t);
    const c = await joinAs(browser, "Sc" + t);

    // ---- the chat panel itself: type and send through the real composer while both panels are open.
    // Regression: an effect returned scrollIntoView()'s Promise (Chrome 154+), and React crashed the
    // whole UI on the next message.
    const crashes: string[] = [];
    for (const u of [b, c]) {
      u.page.on("pageerror", (e) => crashes.push(u.name + ": " + (e as Error).message));
      await u.page.click('.tabs button[title="Chat"]');
      await u.page.waitForSelector(".composer input");
    }
    for (const msg of ["ui one", "ui two", "ui three"]) {
      if (!(await b.page.$(".composer input"))) break; // the UI crashed: reported below
      await b.page.click(".composer input");
      await b.page.keyboard.type(msg);
      await b.page.keyboard.press("Enter");
      for (const u of [b, c]) await waitFor(() => u.page.evaluate((m) => [...document.querySelectorAll(".msgs .msg span")].some((s) => s.textContent === m), msg), { what: "message rendered: " + msg }).catch(() => {});
    }
    const ui = await Promise.all([b, c].map((u) => u.page.evaluate(() => ({ composer: !!document.querySelector(".composer input"), shown: [...document.querySelectorAll(".msgs .msg span")].filter((s) => s.textContent.startsWith("ui ")).length }))));
    check("sending through the chat panel keeps the whole UI alive for sender and receiver", crashes.length === 0 && ui.every((x) => x.composer && x.shown === 3), crashes[0] ?? JSON.stringify(ui));
    for (const u of [b, c]) await u.page.click('.tabs button[title="Chat"]').catch(() => {});

    // ---- a profile change through the real settings dialog and its appearance dialog
    await b.page.evaluate(() => document.querySelector<HTMLButtonElement>(".bar-row .round.ghost")?.click());
    await waitFor(() => b.page.$('.modal input[aria-label]'), { what: "settings dialog" });
    await b.page.$eval('.modal input[aria-label]', (el) => el.select());
    await b.page.type('.modal input[aria-label]', "Novo" + t);
    await b.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((x) => x.textContent === "Change appearance")?.click());
    await waitFor(() => b.page.$(".modal.huge"), { what: "appearance dialog" });
    const picked = await b.page.evaluate(() => {
      const r = [...document.querySelectorAll<HTMLElement>(".modal [role=radiogroup][aria-labelledby=ae-hair] [role=radio]")].find((x) => x.textContent === "Afro");
      r?.click();
      return !!r;
    });
    await b.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal.huge button")].find((x) => x.textContent === "Save")?.click());
    await waitFor(async () => !(await b.page.$(".modal.huge")), { what: "appearance dialog closes on Save" });
    const reached = await waitFor(() => a.page.evaluate((n, id) => { const p = window.__hq.state.roster.get(id); return p?.n === n && p.av.hs === 7; }, "Novo" + t, b.id), { what: "roster shows the new name and hair" }).then(() => true, () => false);
    check("a name and look saved through the settings and appearance dialogs reach other people's roster live", picked && reached, JSON.stringify(await a.page.evaluate((id) => window.__hq.state.roster.get(id), b.id)));
    await b.page.keyboard.press("Escape"); // the settings dialog

    // ---- a desk assigned to a person: its owner's label, then a map reload
    // The world map redacts interactive-object content; editors round-trip through the full map.
    const map = (await (await fetch(API + "/api/admin/map", { headers: { Cookie: "hq_session=" + ctx.adminCookie } })).json()) as MapData;
    const desk = map.props.find((p) => p.t === "desk")!;
    desk.assign = b.id;
    desk.label = "New desk " + t;
    const put = await fetch(API + "/api/map", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify(map) });
    if (put.status !== 200) throw new Error("assigning a desk: " + put.status);
    await waitFor(() => c.page.evaluate(() => window.__hq.view.deskLabels.length > 0), { what: "desk label" });
    // labels share one bitmap font per look (WorldView has 6): Pixi makes a glyph atlas per font.
    // It makes a font when a text is first measured, and labels out of view are not: measure them all.
    const fontsAfterMeasuring = () => c.page.evaluate(() => {
      const v = window.__hq.view;
      for (const l of [...v.areaLabels, ...v.deskLabels]) void l.text.width;
      return window.__hq.bitmapFonts();
    });
    const fonts0 = await fontsAfterMeasuring();
    await c.page.evaluate(() => { (window as unknown as { __oldDeskLabels: unknown }).__oldDeskLabels = window.__hq.view.deskLabels; });
    desk.label = "Renamed desk " + t;
    await fetch(API + "/api/map", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify(map) });
    await waitFor(() => c.page.evaluate(() => window.__hq.view.deskLabels !== (window as unknown as { __oldDeskLabels: unknown }).__oldDeskLabels), { what: "labels rebuilt by the map reload" });
    const fonts1 = await fontsAfterMeasuring();
    check("name tags and labels share one bitmap font per look, and a map reload adds none", fonts0 <= 6 && fonts1 === fonts0, `fonts ${fonts0} -> ${fonts1}`);

    // ---- the chat panel is usable on small screens: nothing covers its controls (real hit tests)
    for (const [label, vp] of [["800x450", { width: 800, height: 450 }], ["390x844 touch", { width: 390, height: 844, isMobile: true, hasTouch: true }]] as [string, { width: number; height: number; isMobile?: boolean; hasTouch?: boolean }][]) {
      const u = await joinAs(browser, "Sl" + t + label.slice(0, 3), { viewport: vp });
      if (!(await u.page.$(".composer input"))) await u.page.click('.tabs button[title="Chat"]');
      await u.page.waitForSelector(".composer input");
      const blocked = await u.page.evaluate(() => {
        const hit = (el: Element) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el.contains(top) ? null : (el.textContent || el.className).trim().slice(0, 20) + " covered by " + (top?.className || top?.tagName); };
        return [...document.querySelectorAll(".chat .chips .chip"), document.querySelector(".msgs")!, document.querySelector(".composer input")!].map(hit).filter(Boolean);
      });
      check("the chat panel's controls are not covered at " + label, blocked.length === 0, blocked.join("; "));
      if (vp.hasTouch) {
        await u.page.click(".reaction-toggle");
        const inaccessible = await u.page.evaluate(() => [...document.querySelectorAll(".reaction-row button")].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight || !el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }).map((el) => el.getAttribute("aria-label")));
        check("every expanded phone reaction fits the screen and can be tapped", inaccessible.length === 0, inaccessible.join(", "));
        await u.page.screenshot({ path: ctx.dir + "/phone-reactions.png" });
        await u.page.click('.reaction-row button[aria-label^="Dance"]');
        const usable = await u.page.evaluate(() => [...document.querySelectorAll(".chat .chips .chip")].every((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }));
        check("after a phone reaction nothing covers the chat scopes", usable);
      }
      await u.ctx.close();
    }

    const errs = [a, b, c].flatMap((u) => u.logs).filter((l) => !/WebSocket|ERR_|net::|closed/.test(l));
    check("no unexpected console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
  }
  return summary();
}
