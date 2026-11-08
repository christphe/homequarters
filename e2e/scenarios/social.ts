// The chat panel, profile changes, desk labels and the chat panel on small screens. The chat rules are Go tests:
// scopes, trimming, the 500-character cut and what history keeps in server/internal/world/chat_test.go
// (TestChatScopesReachTheirAudienceTrimmedAndCut); the rate limit, history for newcomers and across a restart,
// and profile refusals in server/internal/httpapi/resilience_test.go.
import { check, summary, resetChecks, launch, joinAs, waitFor, sleep, API, type RunContext } from "../lib.ts";
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

    // ---- profile change through the real settings dialog
    await b.page.evaluate(() => document.querySelector<HTMLButtonElement>(".bar-row .round.ghost")?.click());
    await waitFor(() => b.page.$('.modal input[aria-label]'), { what: "settings dialog" });
    // no sign-in provider here: the cookie is the account, so there is nothing to sign out of
    check("without sign-in the settings offer no sign out", !(await b.page.evaluate(() => [...document.querySelectorAll(".modal button")].some((x) => x.textContent.trim() === "Sign out"))));
    await b.page.$eval('.modal input[aria-label]', (el) => el.select());
    await b.page.type('.modal input[aria-label]', "Novo" + t);
    // the look is edited in its own dialog, opened from the settings
    await b.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((x) => x.textContent === "Change appearance")?.click());
    await waitFor(() => b.page.$(".modal.huge"), { what: "appearance dialog" });
    // hair style, beard and hat through the avatar editor's own radio groups
    const pick = (group: string, label: string) => b.page.evaluate((g, l) => {
      const r = [...document.querySelectorAll<HTMLElement>(`.modal [role=radiogroup][aria-labelledby=${g}] [role=radio]`)].find((x) => x.textContent === l);
      r?.click();
      return !!r;
    }, group, label);
    const hatColourRow = () => b.page.evaluate(() => !!document.querySelector('.modal [role=radiogroup][aria-label="Hat colour"]'));
    const noHatColourBefore = !(await hatColourRow());
    const picked = (await pick("ae-hair", "Afro")) && (await pick("ae-beard", "Full beard")) && (await pick("ae-hat", "Tricorne"));
    await waitFor(hatColourRow, { what: "hat colour swatches" });
    await b.page.click('.modal [role=radiogroup][aria-label="Hat colour"] [aria-label="Hat colour 3"]');
    check("the avatar editor offers hair styles, beards and hats; hat colours appear once a hat is chosen", picked && noHatColourBefore);
    // any colour through the shirt's own colour picker (React listens to "input")
    await b.page.$eval('.modal input[type=color][aria-label="Shirt: custom colour"]', (el) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "#12ab9f");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await b.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal.huge button")].find((x) => x.textContent === "Save")?.click());
    await waitFor(async () => !(await b.page.$(".modal.huge")), { what: "appearance dialog closes on Save" });
    await waitFor(() => a.page.evaluate((n, id) => window.__hq.state.roster.get(id)?.n === n, "Novo" + t, b.id), { what: "roster shows the new name" });
    check("a profile change reaches other people's roster live", true);
    const seen = await a.page.evaluate((id) => window.__hq.state.roster.get(id)?.av, b.id);
    check("another person sees the new hair, beard and hat", seen?.hs === 7 && seen?.bd === 4 && seen?.ht === 7 && seen?.hk === 2);
    check("another person sees the custom shirt colour", seen?.sh === "#12ab9f", JSON.stringify(seen));
    // someone changing look over and over leaves at most one look per person in other people's memory
    const looks0 = await a.page.evaluate(() => window.__hq.cachedLooks());
    const bCookie = (await b.ctx.cookies()).find((k) => k.name === "hq_session")!.value;
    for (let i = 0; i < 4; i++) { // the profile rate limit allows a burst of 5; one save is already spent
      await fetch(API + "/api/profile", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + bCookie }, body: JSON.stringify({ name: "Novo" + t, avatar: { sk: 1, hs: i, hc: 3, sh: "#0000" + (10 + i), pa: 1 } }) });
      await waitFor(() => a.page.evaluate((id, sh) => window.__hq.state.roster.get(id)?.av.sh === sh, b.id, "#0000" + (10 + i)), { what: "look " + i });
    }
    await sleep(300);
    const looks1 = await a.page.evaluate(() => window.__hq.cachedLooks());
    const bSeen = await a.page.evaluate((id) => window.__hq.view.debugEntities().some((e) => e.id === id), b.id);
    check("four look changes leave other people's avatar cache the same size", bSeen && looks1 === looks0, `B in view: ${bSeen}, looks ${looks0} -> ${looks1}`);

    // ---- desk assignment shows the owner's label
    // The world map redacts interactive-object content; editors round-trip through the full map.
    const map: MapData = await (await fetch(API + "/api/admin/map", { headers: { Cookie: "hq_session=" + ctx.adminCookie } })).json();
    const desk = map.props.find((p) => p.t === "desk")!;
    desk.assign = b.id;
    desk.label = "New desk " + t;
    const put = await fetch(API + "/api/map", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify(map) });
    check("an admin can assign a desk to a person", put.status === 200);
    await waitFor(() => c.page.evaluate(() => window.__hq.view.deskLabels.length > 0), { what: "desk label" });
    check("clients render the desk owner label", true);
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
      await u.page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".chat .chips .chip")].find((c) => c.textContent === "Conversation")?.click());
      check("without a conversation the conversation composer is disabled at " + label, await u.page.evaluate(() => document.querySelector<HTMLInputElement>(".composer input")?.disabled === true));
      if (vp.hasTouch) {
        await u.page.click(".reaction-toggle");
        const inaccessible = await u.page.evaluate(() => [...document.querySelectorAll(".reaction-row button")].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight || !el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }).map((el) => el.getAttribute("aria-label")));
        check("every expanded phone reaction fits the screen and can be tapped", inaccessible.length === 0, inaccessible.join(", "));
        await u.page.screenshot({ path: ctx.dir + "/phone-reactions.png" });
        await u.page.click('.reaction-row button[aria-label^="Dance"]');
        const usable = await u.page.evaluate(() => document.querySelector(".reaction-toggle")?.getAttribute("aria-expanded") === "false" && [...document.querySelectorAll(".chat .chips .chip")].every((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }));
        check("choosing a phone reaction closes the menu and leaves chat scopes usable", usable);
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
