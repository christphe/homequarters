// Reconnection after a WebSocket drop: same place, same call, audio still flowing through the real SFU.
// The server's side of resilience is Go tests in server/internal/httpapi/resilience_test.go: an input flood
// (TestInputFloodCannotOutrunTheServerSpeed), the 1009 close and a plain 401 on /ws
// (TestOversizedFrameClosesWith1009AndNoSessionIs401), positions and sessions across a restart
// (TestPositionAndSessionSurviveARestart).
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, pos, st, sleep, rtpBytes } from "../lib.ts";

export async function run(): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  try {
    const t = String(Date.now() % 10000);
    const a = await joinAs(browser, "Ra" + t);
    const b = await joinAs(browser, "Rb" + t);
    await walkTo(a, 30 * 16 + 8, 24 * 16 + 8);
    await walkTo(b, 30 * 16 + 40, 24 * 16 + 8);
    await Promise.all([a, b].map((u) => u.page.evaluate(() => window.__hq.session.setConsent(true))));
    await waitFor(async () => (await st(a)).conv?.state === "live" && (await st(b)).conv?.state === "live", { timeout: 15000, what: "conversation" });
    const room = await a.page.evaluate(() => window.__hq.media.currentRoom);
    const p0 = await pos(a);

    // --- WebSocket drop: reconnect, same place, conversation and media survive
    await a.page.evaluate(() => (window.__hq.session.socket as unknown as { ws: WebSocket }).ws.close());
    await waitFor(() => a.page.evaluate(() => window.__hq.state.conn === "reconnecting"), { timeout: 3000, what: "reconnecting state" });
    await waitFor(() => a.page.evaluate(() => window.__hq.state.conn === "open"), { timeout: 10000, what: "reconnected" });
    await sleep(800);
    const p1 = await pos(a);
    check("after a WebSocket drop the player reconnects at the same position", Math.hypot(p1.x - p0.x, p1.y - p0.y) < 4, JSON.stringify([p0, p1]));
    check("conversation membership survives the reconnect", (await st(a)).conv?.state === "live" && (await a.page.evaluate(() => window.__hq.media.currentRoom)) === room);
    const rb0 = await rtpBytes(a, "inbound", "audio");
    await sleep(1500);
    const rb1 = await rtpBytes(a, "inbound", "audio");
    check("audio keeps flowing after the WebSocket reconnect", rb1 > rb0, rb0 + " -> " + rb1);
    check("remote player still sees the reconnected player", await b.page.evaluate((id) => window.__hq.view.debugEntities().some((e) => e.id === id), a.id));

    const errs = [a, b].flatMap((u) => u.logs).filter((l) => !/WebSocket|ERR_|closed|net::/.test(l));
    check("no unexpected console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
  }
  return summary();
}
