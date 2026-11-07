// Cues (a wave here) are heard after a reload that nobody touched yet: the browser refuses sound until
// the first key or pointer press, and that press, any press, lets the next cues play, on the speaker
// chosen for calls.
//
// Chrome driven by Puppeteer plays sound before any gesture whatever --autoplay-policy says (measured
// 2026-11-06, headless and headed), so the refusal is WebKit's rule (Safari, the macOS app) stubbed in
// the page: a cue's element plays only once it has been played while a key or pointer press is handled.
// This checks our side against that model; it is not WebKit itself. (navigator.userActivation cannot
// tell: Puppeteer evaluates as a user gesture, so every read of the page's state would count as one.)
import { APP, check, launch, joinAs, waitFor, sleep, resetChecks, summary } from "../lib.ts";

function webkitRule() {
  if (window !== window.top) return;
  let pressing = false; // true while a real key or pointer press is being handled
  const press = (e) => { if (!e.isTrusted) return; pressing = true; setTimeout(() => { pressing = false; }, 0); };
  window.addEventListener("keydown", press, true); // added before the page's own scripts: runs first
  window.addEventListener("pointerdown", press, true);
  const play = HTMLMediaElement.prototype.play;
  const allowed = new WeakSet();
  window.__cuePlays = 0; // play() calls on the cues' players
  HTMLMediaElement.prototype.play = function () {
    if (!this.src.startsWith("blob:")) return play.call(this); // the call's own players: not under test
    window.__cuePlays++;
    if (window.__unplayable) return Promise.reject(new DOMException("no decoder (stub)", "NotSupportedError"));
    if (pressing) allowed.add(this);
    if (!allowed.has(this)) return Promise.reject(new DOMException("refused before a gesture (stub of WebKit's rule)", "NotAllowedError"));
    return play.call(this);
  };
}

const cuePlays = (u) => u.page.evaluate(() => window.__cuePlays);
/** Real key presses, a little apart (a person walking). */
async function presses(u, n) { for (let i = 0; i < n; i++) { await u.page.keyboard.press("ArrowDown"); await sleep(100); } }
const sounds = (u) => u.page.evaluate(() => [...(window.__hq.sounds ?? [])]);
const last = async (u) => (await sounds(u)).at(-1) ?? null;

/** Reloads with these saved values, as the update banner's reload starts again: no touch on the page. */
async function reloadWith(u, items) {
  await u.page.evaluate((items) => { for (const [k, v] of Object.entries(items)) localStorage.setItem(k, JSON.stringify(v)); }, items);
  await u.page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(() => u.page.evaluate(() => window.__hq?.state?.meId > 0 && window.__hq.state.conn === "open"), { timeout: 30000, what: u.name + " back" });
  u.id = await u.page.evaluate(() => window.__hq.state.meId);
}

/** `from` waves at `to` (past the server's 2 s cooldown), and `to` shows the wave. */
async function wave(from, to) {
  await sleep(2200);
  await to.page.evaluate(() => { window.__hq.state.wave = null; });
  await from.page.evaluate((id) => window.__hq.session.wave(id), to.id);
  await waitFor(() => to.page.evaluate(() => window.__hq.state.wave !== null), { timeout: 10000, what: "wave shown" });
}

export async function run() {
  resetChecks();
  const browser = await launch();
  try {
    const tag = String(Date.now() % 10000);
    const ana = await joinAs(browser, "Snd" + tag);
    const bob = await joinAs(browser, "Wav" + tag);
    await ana.page.evaluateOnNewDocument(webkitRule); // from the next load on
    const media = [];
    ana.page.on("request", (r) => { if (r.resourceType() === "media" && !r.url().startsWith("blob:")) media.push(r.url()); });
    // capture was allowed before, so the browser lists speakers with their ids
    await ana.ctx.overridePermissions(APP, ["camera", "microphone"]);
    const speaker = await ana.page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "audiooutput" && d.deviceId && d.deviceId !== "default")?.deviceId ?? "");
    check("the browser lists a speaker with an id", speaker !== "", speaker);

    // 1. A reload nobody touched: the first cue is refused, the first key press lets the next one play
    await reloadWith(ana, { "hq.prefs": { micOn: false, camOn: false, micId: "", camId: "", spkId: speaker } });
    await wave(bob, ana);
    await waitFor(() => last(ana), { timeout: 5000, what: "first cue" }).catch(() => {});
    const refused = await last(ana);
    check("before any touch, the wave's cue is refused by the browser and dropped", refused?.cue === "wave" && refused.result === "blocked", JSON.stringify(refused));
    await ana.page.keyboard.press("ArrowDown"); // a step: the person moves
    await wave(bob, ana);
    await waitFor(async () => (await sounds(ana)).length >= 2, { timeout: 5000, what: "second cue" }).catch(() => {});
    const heard = await last(ana);
    check("after one key press, the next wave is heard", heard?.cue === "wave" && heard.result === "played", JSON.stringify(await sounds(ana)));
    check("...on the speaker chosen for calls", heard?.result === "played" && heard.sink === speaker, JSON.stringify(heard));
    const inPage = await ana.page.evaluate(() => [...document.querySelectorAll("audio")].filter((a) => a.src.startsWith("blob:")).length);
    check("the cue's player is not put in the page", inPage === 0, String(inPage));
    check("no audio file is downloaded: the cue is made in the page", media.length === 0, media.slice(0, 2).join(" "));
    const before = await cuePlays(ana);
    await presses(ana, 3);
    check("once every cue can play, key presses play nothing more", (await cuePlays(ana)) === before, `${before} -> ${await cuePlays(ana)}`);

    // 2. A chosen speaker that is not there: the cue plays on the default output
    await reloadWith(ana, { "hq.prefs": { micOn: false, camOn: false, micId: "", camId: "", spkId: "gone-spk" } });
    const map = await ana.page.$eval("canvas", (c) => { const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await ana.page.mouse.click(map.x, map.y); // a pointer press on the map counts as much as a key
    await wave(bob, ana);
    await waitFor(() => last(ana), { timeout: 5000, what: "cue" }).catch(() => {});
    const fallback = await last(ana);
    check("with a speaker that is gone, after a click, the wave is heard on the default output", fallback?.result === "played" && fallback.sink === "", JSON.stringify(fallback));

    // 3. Sounds turned off in the settings: nothing is played
    const settings = await ana.page.evaluate(() => JSON.parse(localStorage.getItem("hq.settings") ?? "{}"));
    await reloadWith(ana, { "hq.settings": { ...settings, sounds: false } });
    await ana.page.keyboard.press("ArrowDown");
    await wave(bob, ana);
    await sleep(500);
    check("with sounds off, a wave plays nothing, and a key press prepares nothing either", (await sounds(ana)).length === 0 && (await cuePlays(ana)) === 0, JSON.stringify({ sounds: await sounds(ana), plays: await cuePlays(ana) }));

    // 4. An engine that cannot play the cues at all: one press tries each once, the next ones nothing
    await reloadWith(ana, { "hq.settings": { ...settings, sounds: true } });
    await ana.page.evaluate(() => { window.__unplayable = true; });
    await presses(ana, 1);
    await sleep(300);
    const tried = await cuePlays(ana);
    await presses(ana, 5);
    check("cues the engine cannot play are tried once (5 players), not at every press", tried === 5 && (await cuePlays(ana)) === 5, `${tried} then ${await cuePlays(ana)}`);

    const errs = [ana, bob].flatMap((u) => u.logs);
    check("no console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
  }
  return summary();
}
