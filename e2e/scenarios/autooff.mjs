// Microphone and camera turned off for the next conversation once one ends (after a grace), through the real
// media dialog and media bar. The grace is shortened through window.__hq.autoOff for the test only.
import { check, launch, joinAs, waitFor, walkTo, st, sleep, resetChecks, summary } from "../lib.mjs";

const HERE = [20 * 16 + 8, 28 * 16 + 8];
const NEAR = [20 * 16 + 40, 28 * 16 + 8];
const FAR = [28 * 16 + 8, 28 * 16 + 8]; // 128 px: past the 96 px a conversation needs before it lets go
const CAM_OFF_LABEL = "Turn the camera off when a conversation ends";
const MIC_OFF_LABEL = "Mute the microphone when a conversation ends";

// what the media bar's buttons show (aria-pressed)
const bar = (u) => u.page.evaluate(() => {
  const b = (titles) => [...document.querySelectorAll(".bar-row button")].find((x) => titles.includes(x.title));
  return { mic: b(["Mute", "Unmute"])?.getAttribute("aria-pressed") === "true", cam: b(["Turn camera off", "Turn camera on"])?.getAttribute("aria-pressed") === "true" };
});
const press = (u, titles) => u.page.evaluate((ts) => [...document.querySelectorAll(".bar-row button")].find((x) => ts.includes(x.title))?.click(), titles);
const boxes = (u) => u.page.evaluate(() => [...document.querySelectorAll(".modal label.check")].map((l) => ({ text: l.textContent.trim(), on: !!l.querySelector("input")?.checked })));
const tick = (u, label) => u.page.evaluate((x) => [...document.querySelectorAll(".modal label.check")].find((l) => l.textContent.includes(x))?.querySelector("input")?.click(), label);
const clickModal = (u, text) => u.page.evaluate((x) => [...document.querySelectorAll(".modal button")].find((b) => b.textContent === x)?.click(), text);
const live = (u) => st(u).then((s) => s.conv?.state === "live");
const grace = (u, ms) => u.page.evaluate((v) => { if (window.__hq.autoOff) window.__hq.autoOff.grace = v; }, ms);

// Every capture the page asks the browser for. Chrome's fake camera on Windows sometimes vanishes after it
// was released ("Requested device not found"), so "the call asked for the camera" is what proves the
// client's decision; what LiveKit actually publishes is reported alongside.
const logCaptures = (u) => u.page.evaluate(() => {
  const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
  window.__captures = [];
  md.getUserMedia = (c) => { window.__captures.push({ at: performance.now(), audio: !!c?.audio, video: !!c?.video }); return orig(c); };
});
const now = (u) => u.page.evaluate(() => performance.now());
const asked = (u, since) => u.page.evaluate((t) => {
  const c = window.__captures.filter((x) => x.at >= t);
  return { mic: c.some((x) => x.audio), cam: c.some((x) => x.video) };
}, since);
const publishing = (u) => u.page.evaluate(() => {
  const lp = window.__hq.media.room?.localParticipant;
  return { mic: !!lp?.isMicrophoneEnabled, cam: !!lp?.isCameraEnabled };
});

export async function run() {
  resetChecks();
  const browser = await launch();
  try {
    const tag = String(Date.now() % 10000);
    const host = await joinAs(browser, "Host" + tag);
    const visitor = await joinAs(browser, "Visit" + tag);

    // a browser that saved its settings before these two existed gets the defaults
    await host.page.evaluate(() => localStorage.setItem("hq.settings", JSON.stringify({ eco: false, sounds: true, minimap: true })));
    await host.page.reload({ waitUntil: "domcontentloaded" });
    await waitFor(() => host.page.evaluate(() => window.__hq?.state?.meId > 0 && window.__hq.state.conn === "open"), { timeout: 30000, what: "host back" });
    check("the grace is 15 s outside tests", (await host.page.evaluate(() => window.__hq.autoOff?.grace)) === 15000);
    await logCaptures(host);

    await host.page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /enable audio/i.test(b.textContent))?.click());
    await waitFor(() => host.page.$(".modal"), { what: "consent dialog" });
    const first = await boxes(host);
    check("the consent dialog no longer offers to join with the microphone or camera on", !first.some((b) => /join with/i.test(b.text)), JSON.stringify(first));
    check("by default the camera turns off after a conversation and the microphone does not",
      first.find((b) => b.text.includes(CAM_OFF_LABEL))?.on === true && first.find((b) => b.text.includes(MIC_OFF_LABEL))?.on === false, JSON.stringify(first));
    await clickModal(host, "Enable");
    await waitFor(async () => (await st(host)).consent, { what: "host consented" });
    await visitor.page.evaluate(() => window.__hq.session.setConsent(true)); // setup shortcut; the host goes through the dialog

    await walkTo(host, ...HERE);
    await walkTo(visitor, ...NEAR);
    await waitFor(async () => (await live(host)) && (await live(visitor)), { timeout: 20000, what: "first call" });
    await waitFor(async () => (await publishing(host)).mic, { timeout: 10000, what: "host mic on" });
    let t = await now(host);
    await press(host, ["Turn camera on"]);
    await waitFor(async () => (await publishing(host)).cam, { timeout: 10000, what: "host camera on" }).catch(() => {});
    check("in the call the host turns the camera on from the bar", (await asked(host, t)).cam && (await host.page.evaluate(() => window.__hq.state.prefs.camOn)),
      JSON.stringify(await publishing(host)));

    // A short break (somebody steps away and back) within the grace changes nothing.
    await grace(host, 60000);
    await walkTo(visitor, ...FAR);
    await waitFor(async () => (await st(host)).conv === null, { timeout: 10000, what: "call ends" });
    t = await now(host);
    await walkTo(visitor, ...NEAR);
    await waitFor(async () => (await live(host)) && (await asked(host, t)).cam, { timeout: 20000, what: "camera asked again" }).catch(() => {});
    const back = await asked(host, t);
    check("a new conversation within the grace starts with the camera and microphone as they were", (await live(host)) && back.cam && back.mic && (await bar(host)).mic,
      JSON.stringify({ asked: back, publishing: await publishing(host), err: await host.page.evaluate(() => window.__hq.state.deviceError) }));

    // The visitor leaves for good: after the grace the camera is off, the microphone untouched.
    await grace(host, 2500);
    await walkTo(visitor, ...FAR);
    await waitFor(async () => (await st(host)).conv === null, { timeout: 10000, what: "call ends" });
    const during = await bar(host);
    check("during the grace the bar still shows the camera on", during.cam, JSON.stringify(during));
    await waitFor(async () => !(await bar(host)).cam, { timeout: 8000, what: "camera off after the grace" }).catch(() => {});
    const after = await bar(host);
    check("after the grace the bar shows the camera off and the microphone still on", !after.cam && after.mic, JSON.stringify(after));

    // somebody walks in later: the call starts with the microphone and without the camera
    t = await now(host);
    await walkTo(visitor, ...NEAR);
    await waitFor(async () => (await live(host)) && (await publishing(host)).mic, { timeout: 20000, what: "next call with mic" });
    await sleep(1500);
    const next = await asked(host, t);
    check("the next conversation captures the microphone but never asks for the camera", next.mic && !next.cam && !(await publishing(host)).cam && !(await bar(host)).cam, JSON.stringify(next));

    // The microphone setting, through Settings > Microphone, camera and speaker.
    await host.page.evaluate(() => document.querySelector('.bar-row button[title="Settings"]')?.click());
    await waitFor(() => host.page.$(".modal"), { what: "settings" });
    await clickModal(host, "Microphone, camera and speaker");
    await waitFor(async () => (await boxes(host)).some((b) => b.text.includes(MIC_OFF_LABEL)), { what: "device dialog" });
    await tick(host, MIC_OFF_LABEL);
    await clickModal(host, "Save");
    await waitFor(() => host.page.evaluate(() => window.__hq.state.settings.autoMuteMic === true), { what: "mic setting saved" });
    check("the device dialog saves the microphone setting", true);
    await host.page.keyboard.press("Escape");
    await waitFor(async () => !(await host.page.$(".modal")), { what: "settings closed" });
    await waitFor(async () => (await publishing(host)).mic, { timeout: 15000, what: "mic back after the dialog" });
    await press(host, ["Turn camera on"]);
    await waitFor(() => host.page.evaluate(() => window.__hq.state.prefs.camOn), { what: "camera chosen again" });

    await grace(host, 2500);
    await walkTo(visitor, ...FAR);
    await waitFor(async () => (await st(host)).conv === null, { timeout: 10000, what: "call ends" });
    await waitFor(async () => { const b = await bar(host); return !b.cam && !b.mic; }, { timeout: 8000, what: "both off" }).catch(() => {});
    const both = await bar(host);
    check("with both settings, the bar shows the microphone and camera off after the grace", !both.cam && !both.mic, JSON.stringify(both));
    t = await now(host);
    await walkTo(visitor, ...NEAR);
    await waitFor(() => live(host), { timeout: 20000, what: "third call" });
    await sleep(2000);
    const third = await asked(host, t);
    check("the next conversation captures neither the microphone nor the camera", !third.mic && !third.cam && !(await publishing(host)).mic, JSON.stringify(third));
    // the person turns the microphone back on themselves
    await press(host, ["Unmute"]);
    await waitFor(async () => (await publishing(host)).mic, { timeout: 10000, what: "unmuted" }).catch(() => {});
    check("the microphone comes back from the bar", (await publishing(host)).mic);

    const errs = [...host.logs, ...visitor.logs];
    check("no console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
  }
  return summary();
}
