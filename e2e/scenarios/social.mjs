// Chat scopes and privacy, chat history persistence, profile changes and desk labels.
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, st, sleep, API } from "../lib.mjs";

const chatOf = (u) => u.page.evaluate(() => window.__hq.state.chat.map((m) => ({ sc: m.sc, from: m.from, text: m.text, n: m.n })));
const send = (u, sc, text, id) => u.page.evaluate((sc, text, id) => window.__hq.session.chat(sc, text, id), sc, text, id);

export async function run(ctx) {
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
    const crashes = [];
    for (const u of [b, c]) {
      u.page.on("pageerror", (e) => crashes.push(u.name + ": " + e.message));
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
    await sleep(4000); // let the chat rate-limit buckets refill before the checks below

    // ---- office chat reaches everyone; text is trimmed and bounded server-side
    await send(a, "o", "  hello office  ");
    await waitFor(async () => (await chatOf(c)).some((m) => m.sc === "o" && m.text === "hello office"), { what: "office chat reaches C" });
    check("office chat reaches everybody (trimmed)", (await chatOf(b)).some((m) => m.sc === "o" && m.text === "hello office" && m.from === a.id));
    await sleep(700);
    await send(a, "o", "x".repeat(900));
    await waitFor(async () => (await chatOf(b)).some((m) => m.text.startsWith("xxxx")), { what: "long message" });
    check("messages are cut to 500 characters by the server", (await chatOf(b)).find((m) => m.text.startsWith("xxxx")).text.length === 500);

    // ---- rate limit: a burst of 30 cannot flood the office
    await sleep(3000);
    const before = (await chatOf(b)).length;
    await a.page.evaluate(() => { for (let i = 0; i < 30; i++) window.__hq.session.chat("o", "flood " + i); });
    await sleep(1500);
    const got = (await chatOf(b)).filter((m) => m.text.startsWith("flood")).length;
    check("chat flooding is rate limited (30 sent, burst of ~8 accepted)", got > 0 && got <= 10, got + " delivered, " + (before) + " earlier");

    // ---- direct messages are private
    await send(a, "d", "secret between A and B", b.id);
    await waitFor(async () => (await chatOf(b)).some((m) => m.sc === "d"), { what: "DM to B" });
    await sleep(500);
    check("a direct message reaches only its recipient (and the sender)", (await chatOf(a)).some((m) => m.sc === "d") && !(await chatOf(c)).some((m) => m.text.includes("secret")));

    // ---- conversation chat: only members of the group, and only inside one
    await send(a, "g", "nobody should receive this");
    await sleep(600);
    check("conversation chat outside a conversation goes nowhere", !(await chatOf(b)).some((m) => m.sc === "g"));
    await walkTo(a, 12 * 16 + 8, 30 * 16 + 8);
    await walkTo(b, 12 * 16 + 40, 30 * 16 + 8);
    await walkTo(c, 30 * 16 + 8, 30 * 16 + 8);
    await Promise.all([a, b, c].map((u) => u.page.evaluate(() => window.__hq.session.setConsent(true))));
    await waitFor(async () => (await st(a)).conv?.state === "live" && (await st(b)).conv?.state === "live", { timeout: 20000, what: "A and B converse" }).catch(async (e) => {
      console.log("DIAG", JSON.stringify(await Promise.all([a, b, c].map(async (u) => ({ st: await st(u), pos: await u.page.evaluate(() => window.__hq.view.position()), conn: await u.page.evaluate(() => window.__hq.state.conn) })))), JSON.stringify([a, b, c].map((u) => u.logs)));
      throw e;
    });
    await send(a, "g", "only for people in the conversation");
    await waitFor(async () => (await chatOf(b)).some((m) => m.sc === "g"), { what: "group chat to B" });
    await sleep(500);
    check("conversation chat reaches group members only", (await chatOf(b)).some((m) => m.sc === "g" && m.text.includes("conversation")) && !(await chatOf(c)).some((m) => m.sc === "g"));

    // ---- profile change through the real settings dialog
    await b.page.evaluate(() => document.querySelector(".bar-row .round.ghost")?.click());
    await waitFor(() => b.page.$('.modal input[aria-label]'), { what: "settings dialog" });
    // no sign-in provider here: the cookie is the account, so there is nothing to sign out of
    check("without sign-in the settings offer no sign out", !(await b.page.evaluate(() => [...document.querySelectorAll(".modal button")].some((x) => x.textContent.trim() === "Sign out"))));
    await b.page.$eval('.modal input[aria-label]', (el) => el.select());
    await b.page.type('.modal input[aria-label]', "Novo" + t);
    // the look is edited in its own dialog, opened from the settings
    await b.page.evaluate(() => [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Change appearance")?.click());
    await waitFor(() => b.page.$(".modal.huge"), { what: "appearance dialog" });
    // hair style, beard and hat through the avatar editor's own radio groups
    const pick = (group, label) => b.page.evaluate((g, l) => {
      const r = [...document.querySelectorAll(`.modal [role=radiogroup][aria-labelledby=${g}] [role=radio]`)].find((x) => x.textContent === l);
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
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "#12ab9f");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await b.page.evaluate(() => [...document.querySelectorAll(".modal.huge button")].find((x) => x.textContent === "Save")?.click());
    await waitFor(async () => !(await b.page.$(".modal.huge")), { what: "appearance dialog closes on Save" });
    await waitFor(() => a.page.evaluate((n, id) => window.__hq.state.roster.get(id)?.n === n, "Novo" + t, b.id), { what: "roster shows the new name" });
    check("a profile change reaches other people's roster live", true);
    const seen = await a.page.evaluate((id) => window.__hq.state.roster.get(id)?.av, b.id);
    check("another person sees the new hair, beard and hat", seen?.hs === 7 && seen?.bd === 4 && seen?.ht === 7 && seen?.hk === 2);
    check("another person sees the custom shirt colour", seen?.sh === "#12ab9f", JSON.stringify(seen));
    // someone changing look over and over leaves at most one look per person in other people's memory
    const looks0 = await a.page.evaluate(() => window.__hq.cachedLooks());
    const bCookie = (await b.ctx.cookies()).find((k) => k.name === "hq_session").value;
    for (let i = 0; i < 4; i++) { // the profile rate limit allows a burst of 5; one save is already spent
      await fetch(API + "/api/profile", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + bCookie }, body: JSON.stringify({ name: "Novo" + t, avatar: { sk: 1, hs: i, hc: 3, sh: "#0000" + (10 + i), pa: 1 } }) });
      await waitFor(() => a.page.evaluate((id, sh) => window.__hq.state.roster.get(id)?.av.sh === sh, b.id, "#0000" + (10 + i)), { what: "look " + i });
    }
    await sleep(300);
    const looks1 = await a.page.evaluate(() => window.__hq.cachedLooks());
    const bSeen = await a.page.evaluate((id) => window.__hq.view.debugEntities().some((e) => e.id === id), b.id);
    check("four look changes leave other people's avatar cache the same size", bSeen && looks1 === looks0, `B in view: ${bSeen}, looks ${looks0} -> ${looks1}`);
    const bad = await fetch(API + "/api/profile", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + (await c.ctx.cookies()).find((k) => k.name === "hq_session").value }, body: JSON.stringify({ name: "   ", avatar: {} }) });
    check("an empty name is refused", bad.status === 400);
    const anon = await fetch(API + "/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    check("anonymous profile changes are refused", anon.status === 401);

    // ---- desk assignment shows the owner's label
    // The world map redacts interactive-object content; editors round-trip through the full map.
    const map = await (await fetch(API + "/api/admin/map", { headers: { Cookie: "hq_session=" + ctx.adminCookie } })).json();
    const desk = map.props.find((p) => p.t === "desk");
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
    await c.page.evaluate(() => { window.__oldDeskLabels = window.__hq.view.deskLabels; });
    desk.label = "Renamed desk " + t;
    await fetch(API + "/api/map", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "hq_session=" + ctx.adminCookie }, body: JSON.stringify(map) });
    await waitFor(() => c.page.evaluate(() => window.__hq.view.deskLabels !== window.__oldDeskLabels), { what: "labels rebuilt by the map reload" });
    const fonts1 = await fontsAfterMeasuring();
    check("name tags and labels share one bitmap font per look, and a map reload adds none", fonts0 <= 6 && fonts1 === fonts0, `fonts ${fonts0} -> ${fonts1}`);

    // ---- history: a newcomer sees the office chat; it survives a restart; DMs and group chat do not
    // ---- the chat panel is usable on small screens: nothing covers its controls (real hit tests)
    for (const [label, vp] of [["800x450", { width: 800, height: 450 }], ["390x844 touch", { width: 390, height: 844, isMobile: true, hasTouch: true }]]) {
      const u = await joinAs(browser, "Sl" + t + label.slice(0, 3), { viewport: vp });
      if (!(await u.page.$(".composer input"))) await u.page.click('.tabs button[title="Chat"]');
      await u.page.waitForSelector(".composer input");
      const blocked = await u.page.evaluate(() => {
        const hit = (el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el.contains(top) ? null : (el.textContent || el.className).trim().slice(0, 20) + " covered by " + (top?.className || top?.tagName); };
        return [...document.querySelectorAll(".chat .chips .chip"), document.querySelector(".msgs"), document.querySelector(".composer input")].map(hit).filter(Boolean);
      });
      check("the chat panel's controls are not covered at " + label, blocked.length === 0, blocked.join("; "));
      await u.page.evaluate(() => [...document.querySelectorAll(".chat .chips .chip")].find((c) => c.textContent === "Conversation")?.click());
      check("without a conversation the conversation composer is disabled at " + label, await u.page.evaluate(() => document.querySelector(".composer input")?.disabled === true));
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

    const d = await joinAs(browser, "Sd" + t);
    const hist = await chatOf(d);
    check("a newcomer receives the persisted office chat", hist.some((m) => m.text === "hello office" && m.n));
    check("history never contains direct or conversation messages", !hist.some((m) => m.sc !== "o") && !hist.some((m) => m.text.includes("secret") || m.text.includes("conversation")));
    await sleep(1500); // let the async writer flush
    await ctx.stopServer();
    await ctx.startServer();
    const e = await joinAs(browser, "Se" + t);
    check("office chat history survives a server restart", (await chatOf(e)).some((m) => m.text === "hello office"));
    const errs = [a, b, c, d, e].flatMap((u) => u.logs).filter((l) => !/WebSocket|ERR_|net::|closed/.test(l));
    check("no unexpected console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
  }
  return summary();
}
