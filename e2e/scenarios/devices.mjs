// A chosen microphone, camera or speaker that is not there now (unplugged, another machine, a remote desktop
// session) gives way to the default one, in a call and in the device dialog's preview, without failing.
import { APP, check, launch, joinAs, waitFor, walkTo, st, sleep, resetChecks, summary } from "../lib.mjs";

const HERE = [20 * 16 + 8, 28 * 16 + 8];
const NEAR = [20 * 16 + 40, 28 * 16 + 8];
const AWAY = [30 * 16 + 8, 28 * 16 + 8];
const GONE = { micOn: true, camOn: true, micId: "gone-mic", camId: "gone-cam", spkId: "gone-spk" };
const SPEAKER_TOAST = "Your chosen speaker is not available: sound plays on the default one.";
const DEVICE_TOAST = "A chosen microphone, camera or speaker is not available: the default one is used.";

const savedIds = (u) => u.page.evaluate(() => { const p = window.__hq.state.prefs; return { micId: p.micId, camId: p.camId, spkId: p.spkId }; });
// every toast shown since the page loaded (one may be replaced by the next before it is read)
const watchToasts = (u) => u.page.evaluate(() => { window.__toasts = []; setInterval(() => { const x = window.__hq?.state?.toast; if (x && window.__toasts.at(-1) !== x) window.__toasts.push(x); }, 50); });
const toastSoon = (u, text) => waitFor(() => u.page.evaluate((x) => (window.__toasts ?? []).includes(x), text), { timeout: 8000, what: "toast" }).then(() => true, () => false);

/** Reloads with these preferences in storage, as a browser that saved them on another day would start. */
async function reloadWith(u, prefs, consent) {
  await u.page.evaluate((p, c) => { localStorage.setItem("hq.prefs", JSON.stringify(p)); localStorage.setItem("hq.consent", c); }, prefs, consent);
  await u.page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(() => u.page.evaluate(() => window.__hq?.state?.meId > 0 && window.__hq.state.conn === "open"), { timeout: 30000, what: u.name + " back" });
  await watchToasts(u);
}

export async function run() {
  resetChecks();
  const browser = await launch();
  try {
    const tag = String(Date.now() % 10000);
    const host = await joinAs(browser, "Dev" + tag);
    const visitor = await joinAs(browser, "Vis" + tag);
    // capture was allowed before, so the browser shows device ids (what a returning person has)
    await host.ctx.overridePermissions(APP, ["camera", "microphone"]);
    const sinkFailures = [];
    host.page.on("console", (m) => { if (/sink id/i.test(m.text())) sinkFailures.push(m.text()); });

    // 1. In a call
    await reloadWith(host, GONE, "1");
    await visitor.page.evaluate(() => window.__hq.session.setConsent(true)); // setup shortcut
    await walkTo(host, ...HERE);
    await walkTo(visitor, ...NEAR);
    await waitFor(async () => (await st(host)).conv?.state === "live" && (await st(visitor)).conv?.state === "live", { timeout: 20000, what: "call" });
    const outputs = await host.page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput" && d.deviceId).length);
    check("the browser lists speakers with ids (the case where a chosen one can be told missing)", outputs > 0, String(outputs));
    const heard = await waitFor(() => host.page.evaluate(() => [...(window.__hq.media.room?.remoteParticipants.values() ?? [])].some((p) => [...p.audioTrackPublications.values()].some((x) => x.track))), { timeout: 15000, what: "remote audio" }).then(() => true, () => false);
    check("the visitor's audio is subscribed", heard);
    await waitFor(async () => (await st(host)).mic && (await st(host)).cam, { timeout: 10000, what: "host capture" }).catch(() => {});
    const cap = await st(host);
    check("the microphone and camera come on, on the default devices", cap.mic === true && cap.cam === true, JSON.stringify({ mic: cap.mic, cam: cap.cam }));
    check("the person is told the default speaker plays", await toastSoon(host, SPEAKER_TOAST));
    await sleep(1000);
    check("no remote track fails its speaker choice", sinkFailures.length === 0, sinkFailures.slice(0, 2).join(" | "));
    const active = await host.page.evaluate(() => window.__hq.media.room?.getActiveDevice("audiooutput") ?? "");
    check("the call plays on the default output", active !== "gone-spk", active);
    check("no device error is shown", !(await host.page.evaluate(() => window.__hq.state.deviceError)));
    check("the choices are kept for when the devices are back", JSON.stringify(await savedIds(host)) === JSON.stringify({ micId: "gone-mic", camId: "gone-cam", spkId: "gone-spk" }), JSON.stringify(await savedIds(host)));

    // 2. The device dialog previews the default devices instead of saying "No device found"
    await walkTo(host, ...AWAY);
    // the call lets go only after its leave dwell: reloading inside it would rejoin the old call
    await waitFor(async () => !(await st(host)).conv, { timeout: 15000, what: "call over" });
    await reloadWith(host, GONE, "0");
    const opened = await host.page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Enable audio and video"); b?.click(); return !!b; });
    check("the media bar offers to enable audio and video", opened);
    await waitFor(() => host.page.$(".modal"), { what: "device dialog" });
    check("the dialog says, once, that the default devices are previewed", await toastSoon(host, DEVICE_TOAST) && (await host.page.evaluate((x) => window.__toasts.filter((y) => y === x).length, DEVICE_TOAST)) === 1, JSON.stringify(await host.page.evaluate(() => window.__toasts)));
    await waitFor(async () => (await host.page.$(".modal .error")) === null && (await host.page.evaluate(() => !!document.querySelector(".modal video")?.srcObject)), { timeout: 10000, what: "dialog preview" }).catch(() => {});
    const dialogErr = await host.page.evaluate(() => document.querySelector(".modal .error")?.textContent ?? "");
    check("the preview shows no device error", !dialogErr, dialogErr);
    check("the preview runs", await host.page.evaluate(() => !!document.querySelector(".modal video")?.srcObject));
    check("nothing is saved before Enable", JSON.stringify(await savedIds(host)) === JSON.stringify({ micId: "gone-mic", camId: "gone-cam", spkId: "gone-spk" }), JSON.stringify(await savedIds(host)));
    await host.page.evaluate(() => [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Enable")?.click());
    await waitFor(async () => (await st(host)).consent, { what: "consented" }).catch(() => {});
    check("Enable saves the defaults the dialog showed", JSON.stringify(await savedIds(host)) === JSON.stringify({ micId: "", camId: "", spkId: "" }), JSON.stringify(await savedIds(host)));
    check("no console errors", host.logs.length === 0 && visitor.logs.length === 0, [...host.logs, ...visitor.logs].slice(0, 3).join(" | "));
  } finally {
    await browser.close();
  }
  return summary();
}
