// Media isolation attacks against the real SFU: replayed, tampered and expired tokens.
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, st, lkParticipants, metrics, LK } from "../lib.mjs";

const prefixOf = (room) => room.split(".").slice(0, 2).join(".");
const TTL = Number(process.env.TILEWORK_MEDIA_TOKEN_TTL_SECONDS ?? 20);
// the SFU's own token check (the one a signal connection runs): 200 accepted, 401 rejected
const validate = async (token) => (await fetch(LK + "/rtc/validate?access_token=" + encodeURIComponent(token))).status;

export async function run(ctx) {
  resetChecks();
  const browser = await launch();
  try {
    const t = String(Date.now() % 10000);
    const a = await joinAs(browser, "Xa" + t);
    const b = await joinAs(browser, "Xb" + t);
    await a.page.evaluate(() => {
      const m = window.__tilework.media;
      const j = m.join.bind(m);
      m.join = (i) => { window.__stale = i; window.__RoomCtor = null; return j(i).then(() => { window.__RoomCtor = m.room.constructor; }); };
    });
    await walkTo(a, 12 * 16 + 8, 30 * 16 + 8);
    await walkTo(b, 12 * 16 + 40, 30 * 16 + 8);
    await Promise.all([a, b].map((u) => u.page.evaluate(() => window.__tilework.session.setConsent(true))));
    await waitFor(async () => (await st(a)).conv?.state === "live" && (await st(b)).conv?.state === "live", { timeout: 20000, what: "conversation" });
    await waitFor(() => a.page.evaluate(() => !!window.__RoomCtor), { what: "room constructor captured" });
    const room = await a.page.evaluate(() => window.__tilework.media.currentRoom);
    await a.page.evaluate((r) => { window.__privateRoom = r; }, prefixOf(room) + ".r.boardroom");
    const issued = Date.now();

    // Everyone leaves the group; the server revokes A's access.
    const before = await metrics();
    await walkTo(b, 34 * 16 + 8, 30 * 16 + 8);
    await waitFor(async () => (await st(a)).conv === null, { timeout: 15000, what: "conversation ends" });
    await waitFor(async () => (await lkParticipants(room)).length === 0, { timeout: 8000, what: "SFU room empty" });
    check("after leaving, the SFU room is empty (server-side revocation)", true);

    // Attack 1: replay A's still-valid token from a "hacked" client after leaving the group.
    const attack = (tokenTweak) => a.page.evaluate(async (tweak) => {
      const s = window.__stale;
      const r = new window.__RoomCtor();
      window.__attacker = r;
      let token = s.token;
      if (tweak === "room") {
        const [h, p, sg] = token.split(".");
        const payload = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
        payload.video.room = window.__privateRoom;
        token = h + "." + btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + "." + sg;
      }
      try {
        await r.connect(s.url, token, { autoSubscribe: true });
        return "connected";
      } catch (e) {
        return "rejected: " + String(e?.message ?? e).slice(0, 80);
      }
    }, tokenTweak);

    // The attacker must be seen in the SFU room before its eviction means anything: a connection that drops on
    // its own (a headless ICE/DTLS flake, 1 run in 8 here) empties the room without the reconciler.
    const seenInRoom = () => waitFor(async () => (await lkParticipants(room)).length > 0, { timeout: 5000, every: 100 }).then(() => true, () => false);
    let replay = await attack("none");
    let seen = replay === "connected" && await seenInRoom();
    // "could not establish pc connection" is an ICE/DTLS setup flake of the headless browser, not a token verdict
    // (a rejected token fails at the signal step). Retry it once so the check measures the token.
    if (/pc connection/.test(replay) || (replay === "connected" && !seen)) {
      await a.page.evaluate(() => window.__attacker?.disconnect());
      replay = await attack("none");
      seen = replay === "connected" && await seenInRoom();
    }
    check("a replayed token can still connect inside its validity window (known, bounded)", replay === "connected", replay);
    check("the replayed connection shows up in the SFU room", seen);
    const t0 = Date.now();
    const evicted = seen && await waitFor(async () => (await lkParticipants(room)).length === 0, { timeout: 15000, every: 250, what: "attacker evicted" }).then(() => true).catch(() => false);
    const rm = await metrics();
    check("the reconciler evicts the replayed connection within seconds", evicted, ((Date.now() - t0) / 1000).toFixed(1) + " s");
    const removals = [before.tilework_media_reconcile_removals_total ?? 0, rm.tilework_media_reconcile_removals_total];
    check("the eviction is counted (tilework_media_reconcile_removals_total)", removals[1] > removals[0], removals.join(" -> "));
    await a.page.evaluate(() => window.__attacker?.disconnect());

    // Attack 2: change the room inside the token (private room) without the signing secret.
    const tamper = await attack("room");
    check("a token whose room claim was edited is rejected by the SFU (signature)", tamper.startsWith("rejected"), tamper);
    check("the private room stayed empty", (await lkParticipants(prefixOf(room) + ".r.boardroom")).length === 0);

    // Attack 3: token past its validity. LiveKit's JWT library tolerates 60 s of clock skew (measured: a token
    // 12 s past its exp was still accepted), so the effective lifetime is TTL + 60 s. Rather than sleep through
    // that here, the runner asks the SFU about the same token after the other scenarios.
    const LEEWAY = 60;
    const stale = await a.page.evaluate(() => window.__stale.token);
    const fresh = await validate(stale);
    check("the SFU accepts the token while it is valid (control for the deferred expiry check)", fresh === 200, String(fresh));
    ctx.defer("security: expired token", issued + (TTL + LEEWAY + 8) * 1000, async () => {
      const s = await validate(stale);
      check("an expired token is rejected once LiveKit's 60 s clock-skew leeway has passed", s === 401, s + " (" + TTL + " s validity + " + LEEWAY + " s leeway)");
    });
    check("no unauthorised participant remains in the SFU room", (await lkParticipants(room)).length === 0);

    const errs = [a, b].flatMap((u) => u.logs).filter((l) => !/WebSocket|ERR_|net::|closed|401|Unauthorized|validation|token|Failed to load/i.test(l));
    check("no unexpected console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
  }
  return summary();
}
