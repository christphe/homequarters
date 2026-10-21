// Remote mute: somebody in a call turns off another participant's microphone, camera or screen share through
// the video tile's menu ("⋯" button, right click, keyboard). The SFU mutes the track, the person's own capture
// stops, they are told who did it; nothing can be turned on remotely and nobody outside the call can do it.
import fs from "node:fs";
import { createRequire } from "node:module";
import { check, summary, resetChecks, launch, joinAs, waitFor, walkTo, sleep, lk, rtpPackets } from "../lib.mjs";

const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

/** The SFU's view of one participant's tracks: { source: muted } (absent = not published). */
async function sfuTracks(room, identity) {
  const r = await lk("GetParticipant", { room, identity: String(identity) }, room);
  const out = {};
  for (const t of r.tracks ?? []) out[String(t.source)] = !!t.muted;
  return out;
}
const sfuMicOff = (tr) => tr.MICROPHONE === undefined || tr.MICROPHONE === true;

/** Opens the "⋯" menu of the tile of `who` on `u`'s page with the mouse (hover, then click). */
async function openMenuByMouse(u, who) {
  const sel = `.dock .tile-more[aria-label="More for ${who.name}"]`;
  const tile = await u.page.waitForSelector(`.dock .tile:has(${sel.replace(".dock ", "")})`, { timeout: 15000 });
  await tile.hover();
  const visible = await u.page.$eval(sel, (b) => getComputedStyle(b).opacity === "1");
  await u.page.click(sel);
  await u.page.waitForSelector(".tile-menu[role=menu]", { timeout: 5000 });
  return visible;
}
const menuItems = (u) => u.page.$$eval(".tile-menu [role=menuitem]", (bs) => bs.map((b) => b.textContent.trim()));
const toastText = (u) => u.page.evaluate(() => window.__hq.state.toast);
/** The toast once it says `text` (it shows when the capture has stopped), or what it says after 5 s. */
const toastSoon = (u, text) => waitFor(async () => (await toastText(u)) === text && text, { timeout: 5000, what: "toast" }).catch(() => toastText(u));
const localTrackState = (u, source) => u.page.evaluate((source) => {
  const pub = window.__hq.media.room?.localParticipant.getTrackPublication(source);
  return pub?.track ? pub.track.mediaStreamTrack.readyState + (pub.isMuted ? "/muted" : "/live") : "none";
}, source);

export async function run() {
  resetChecks();
  const browser = await launch(["--auto-select-desktop-capture-source=Entire screen", "--enable-features=GetDisplayMediaSetAutoSelectAllScreens"]);
  try {
    const tag = String(Date.now() % 10000);
    const ana = await joinAs(browser, "Ana" + tag);
    const bruno = await joinAs(browser, "Bruno" + tag);
    const far = await joinAs(browser, "Far" + tag);
    const missing = []; // which resource a "404" console error was about (the console line has no URL)
    for (const u of [ana, bruno, far]) u.page.on("response", (r) => { if (r.status() === 404) missing.push(u.name + " " + r.url()); });
    await walkTo(ana, 20 * 16 + 8, 28 * 16 + 8);
    await walkTo(bruno, 22 * 16 + 8, 28 * 16 + 8);
    await Promise.all([ana, bruno, far].map((u) => u.page.evaluate(() => window.__hq.session.setConsent(true))));
    await waitFor(async () => (await Promise.all([ana, bruno].map((u) => u.page.evaluate(() => window.__hq.state.conv?.state === "live")))).every(Boolean), { timeout: 20000, what: "both live in a call" });
    const room = await ana.page.evaluate(() => window.__hq.media.currentRoom);

    // Ana talks with her camera on; Bruno hears and sees her.
    await ana.page.evaluate(() => window.__hq.media.setMic(true));
    await ana.page.evaluate(() => window.__hq.media.setCam(true));
    await waitFor(() => bruno.page.evaluate((id) => window.__hq.media.tiles.some((t) => t.identity === String(id) && t.mic && t.cam), ana.id), { timeout: 20000, what: "Bruno sees Ana's mic and camera on" }).catch(async (e) => {
      const tiles = await bruno.page.evaluate(() => window.__hq.media.tiles.map((t) => ({ id: t.identity, mic: t.mic, cam: t.cam })));
      throw new Error(e.message + " " + JSON.stringify({ tiles, sfu: await sfuTracks(room, ana.id), ana: await ana.page.evaluate(() => ({ mic: window.__hq.state.mic, cam: window.__hq.state.cam, err: window.__hq.state.deviceError, pubs: [...window.__hq.media.room.localParticipant.trackPublications.values()].map((p) => p.source + ":" + p.isMuted + ":" + p.track?.mediaStreamTrack.muted + ":" + p.track?.mediaStreamTrack.readyState + ":" + p.track?.mediaStreamTrack.enabled + ":" + JSON.stringify(p.track?.mediaStreamTrack.getSettings())), vis: document.visibilityState })), logs: ana.logs }));
    });
    await waitFor(async () => (await rtpPackets(bruno, "audio")) > 20, { timeout: 15000, what: "Ana's audio reaches Bruno" });

    // 1. Microphone, with the mouse: hover the tile, click "⋯", pick the item.
    const shown = await openMenuByMouse(bruno, ana);
    check("the ⋯ button shows when the tile is hovered", shown);
    check("the menu shows whose devices it turns off", (await bruno.page.$eval(".tile-menu", (m) => m.innerText)).includes(ana.name));
    check("the menu lists only what is on (microphone and camera, no screen share)", JSON.stringify(await menuItems(bruno)) === JSON.stringify(["Turn off microphone", "Turn off camera"]), JSON.stringify(await menuItems(bruno)));
    await bruno.page.evaluate(AXE);
    const axe = await bruno.page.evaluate(async () => (await window.axe.run([".dock", ".tile-menu"].map((s) => document.querySelector(s)).filter(Boolean), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } })).violations.map((v) => v.id + ":" + v.nodes.map((n) => n.target.join(" ")).join("|")));
    check("axe: the video dock with the tile menu open has no violations", axe.length === 0, axe.join(", "));
    await ana.page.evaluate(() => { window.__micTrack = window.__hq.media.room.localParticipant.getTrackPublication("microphone").track.mediaStreamTrack; });
    await bruno.page.evaluate(() => [...document.querySelectorAll(".tile-menu [role=menuitem]")].find((b) => b.textContent.trim() === "Turn off microphone").click());
    await waitFor(async () => sfuMicOff(await sfuTracks(room, ana.id)), { timeout: 10000, what: "the SFU no longer carries Ana's microphone" });
    check("the SFU mutes (or no longer carries) Ana's microphone", true, JSON.stringify(await sfuTracks(room, ana.id)));
    await waitFor(() => bruno.page.evaluate((id) => window.__hq.media.tiles.some((t) => t.identity === String(id) && !t.mic), ana.id), { timeout: 10000, what: "Bruno's tile shows Ana muted" });
    check("Bruno's tile of Ana shows the microphone off", true);
    await sleep(800);
    const p0 = await rtpPackets(bruno, "audio");
    await sleep(2000);
    const p1 = await rtpPackets(bruno, "audio");
    const diag = p1 - p0 <= 2 ? "" : JSON.stringify({ sfu: await sfuTracks(room, ana.id), ana: await ana.page.evaluate(() => [...window.__hq.media.room.localParticipant.trackPublications.values()].map((p) => p.source + ":" + p.trackSid + ":" + p.isMuted)), bruno: await bruno.page.evaluate(async () => { const pm = window.__hq.media.room.engine.pcManager; const pc = pm.subscriber?.pc ?? pm.publisher.pc; const out = []; (await pc.getStats()).forEach((s) => { if (s.type === "inbound-rtp") out.push(s.kind + ":" + s.trackIdentifier + ":" + s.packetsReceived); }); return out; }) });
    check("no more of Ana's audio reaches Bruno", p1 - p0 <= 2, `${p1 - p0} packets in 2 s ${diag}`);
    await waitFor(() => ana.page.evaluate(() => window.__micTrack.readyState === "ended" && !window.__hq.state.mic), { timeout: 10000, what: "Ana's microphone released" });
    check("Ana's microphone capture is released (track ended) and her mic shows off", true, await localTrackState(ana, "microphone"));
    check("Ana is told who turned it off", (await toastSoon(ana, `Bruno${tag} turned off your microphone`)) === `Bruno${tag} turned off your microphone`, await toastText(ana));
    check("with the wave chime", await ana.page.evaluate(() => window.__hq.chimes.includes("wave")));
    check("Bruno is not told anything", !/turned off/.test(await toastText(bruno)), await toastText(bruno));
    // her media connection drops and rejoins the same call: what was turned off stays off
    await ana.page.evaluate(() => window.__hq.media.room.disconnect());
    await waitFor(() => ana.page.evaluate(() => window.__hq.state.conv?.state === "live" && window.__hq.media.room?.state === "connected"), { timeout: 20000, what: "Ana's media rejoined" });
    await sleep(1500);
    check("a rejoin of the same call does not turn her microphone back on", !(await ana.page.evaluate(() => window.__hq.state.mic)) && sfuMicOff(await sfuTracks(room, ana.id)), JSON.stringify(await sfuTracks(room, ana.id)));
    // asking again about something already off makes no noise for her
    await ana.page.evaluate(() => { window.__hq.state.toast = ""; window.__hq.chimes.push("marker"); });
    for (let i = 0; i < 5; i++) await bruno.page.evaluate((id) => window.__hq.session.mute(id, "mic"), ana.id);
    await sleep(1000);
    check("repeated requests about an already-off microphone show nothing and play nothing", await ana.page.evaluate(() => window.__hq.state.toast === "" && window.__hq.chimes.at(-1) === "marker"));
    // (a rejoin starts the camera from the "join with the camera on" preference, off here: turn it on again)
    await ana.page.evaluate(() => window.__hq.media.setCam(true));
    await waitFor(() => bruno.page.evaluate((id) => window.__hq.media.tiles.some((t) => t.identity === String(id) && t.cam), ana.id), { timeout: 20000, what: "Bruno sees Ana's camera again" });

    // 2. Camera, by right click and the keyboard; Ana's tab is hidden and has notifications on.
    await ana.page.evaluate(() => {
      window.__notes = [];
      class N { constructor(title, o) { window.__notes.push({ title, body: o?.body }); } close() {} }
      N.permission = "granted";
      window.Notification = N;
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      window.__hq.state.settings.notify = true;
    });
    await ana.page.evaluate(() => { window.__camTrack = window.__hq.media.room.localParticipant.getTrackPublication("camera").track.mediaStreamTrack; });
    const anaTile = await bruno.page.waitForSelector(`.dock .tile:has(.tile-more[aria-label="More for ${ana.name}"])`);
    await anaTile.click({ button: "right" });
    await bruno.page.waitForSelector(".tile-menu[role=menu]", { timeout: 5000 });
    check("a right click opens the same menu, with only the camera left", JSON.stringify(await menuItems(bruno)) === JSON.stringify(["Turn off camera"]), JSON.stringify(await menuItems(bruno)));
    check("the first item has the keyboard focus", await bruno.page.evaluate(() => document.activeElement?.getAttribute("role") === "menuitem"));
    await bruno.page.keyboard.press("Enter");
    await waitFor(async () => (await sfuTracks(room, ana.id)).CAMERA !== false, { timeout: 10000, what: "the SFU no longer carries Ana's camera" });
    check("the SFU mutes (or no longer carries) Ana's camera", true, JSON.stringify(await sfuTracks(room, ana.id)));
    await waitFor(() => ana.page.evaluate(() => window.__camTrack.readyState === "ended" && !window.__hq.state.cam), { timeout: 10000, what: "Ana's camera released" });
    check("Ana's camera capture is released (track ended) and her camera shows off", true);
    await waitFor(() => bruno.page.evaluate((id) => window.__hq.media.tiles.some((t) => t.identity === String(id) && !t.cam), ana.id), { timeout: 10000, what: "Bruno's tile shows Ana's camera off" });
    check("Ana is told, by toast", (await toastSoon(ana, `Bruno${tag} turned off your camera`)) === `Bruno${tag} turned off your camera`, await toastText(ana));
    const notes = await ana.page.evaluate(() => window.__notes);
    check("and by a system notification while her window is hidden", notes.length === 1 && notes[0].title === `Bruno${tag} turned off your camera`, JSON.stringify(notes));
    await ana.page.evaluate(() => { delete document.hidden; window.__hq.state.settings.notify = false; });
    check("nothing left to turn off: no ⋯ button on Ana's tile", await bruno.page.$(`.dock .tile-more[aria-label="More for ${ana.name}"]`) === null);

    // 3. Screen share, keyboard only: focus the ⋯ button, Enter, arrows, Enter.
    await ana.page.evaluate(() => window.__hq.media.setShare(true));
    await ana.page.evaluate(() => window.__hq.media.setCam(true));
    await waitFor(() => bruno.page.evaluate((id) => window.__hq.media.tiles.some((t) => t.identity === String(id) && !!t.screen && t.cam), ana.id), { timeout: 20000, what: "Bruno sees Ana's screen and camera" });
    await bruno.page.focus(`.grid .tile-more[aria-label="More for ${ana.name}"]`);
    check("the ⋯ button shows on keyboard focus", await bruno.page.$eval(`.grid .tile-more[aria-label="More for ${ana.name}"]`, (b) => getComputedStyle(b).opacity === "1"));
    await bruno.page.keyboard.press("Enter");
    await bruno.page.waitForSelector(".tile-menu[role=menu]", { timeout: 5000 });
    check("the menu now offers the camera and the screen share", JSON.stringify(await menuItems(bruno)) === JSON.stringify(["Turn off camera", "Stop screen share"]), JSON.stringify(await menuItems(bruno)));
    await bruno.page.keyboard.press("Escape");
    check("Escape closes the menu and gives the focus back to ⋯", await bruno.page.evaluate(() => !document.querySelector(".tile-menu") && document.activeElement?.classList.contains("tile-more")));
    await bruno.page.keyboard.press("Enter");
    await bruno.page.waitForSelector(".tile-menu[role=menu]", { timeout: 5000 });
    await bruno.page.keyboard.press("ArrowDown");
    check("arrows move between the items", await bruno.page.evaluate(() => document.activeElement?.textContent.trim() === "Stop screen share"));
    await bruno.page.keyboard.press("Enter");
    await waitFor(() => ana.page.evaluate(() => !window.__hq.state.sharing && !window.__hq.media.room.localParticipant.isScreenShareEnabled), { timeout: 10000, what: "Ana's share stopped" });
    check("Ana's screen share stops", true);
    check("her camera stays on (only what was chosen goes off)", await ana.page.evaluate(() => window.__hq.state.cam));
    await waitFor(async () => (await sfuTracks(room, ana.id)).SCREEN_SHARE !== false, { timeout: 10000, what: "the SFU no longer carries Ana's screen" });
    check("the SFU no longer carries Ana's screen", true);
    check("Ana is told", (await toastSoon(ana, `Bruno${tag} stopped your screen share`)) === `Bruno${tag} stopped your screen share`, await toastText(ana));

    // 4. The SFU holds the mute even for a client that ignores the message.
    await ana.page.evaluate(() => window.__hq.media.setMic(true));
    await waitFor(async () => (await sfuTracks(room, ana.id)).MICROPHONE === false, { timeout: 10000, what: "Ana's mic back on, by herself" });
    check("Ana turns her microphone back on herself", true);
    await ana.page.evaluate(() => { for (const m of [window.__hq.media, window.__hq.spotlightMedia]) { m.__release = m.release; m.release = async () => {}; } });
    await openMenuByMouse(bruno, ana);
    await bruno.page.evaluate(() => [...document.querySelectorAll(".tile-menu [role=menuitem]")].find((b) => b.textContent.trim() === "Turn off microphone").click());
    await waitFor(async () => (await sfuTracks(room, ana.id)).MICROPHONE === true, { timeout: 10000, what: "the SFU marks Ana's mic muted" });
    check("the SFU itself mutes the microphone of a client that ignores the request", true);
    await ana.page.evaluate(() => { for (const m of [window.__hq.media, window.__hq.spotlightMedia]) m.release = m.__release; });

    // 5. Somebody outside the call cannot (the server checks); nothing turns a track on.
    await ana.page.evaluate(() => window.__hq.media.setMic(true));
    await waitFor(async () => (await sfuTracks(room, ana.id)).MICROPHONE === false, { timeout: 10000, what: "Ana's mic on again" });
    await ana.page.evaluate(() => window.__hq.state.toast = "");
    await far.page.evaluate((id) => { window.__hq.session.mute(id, "mic"); window.__hq.session.mute(id, "cam"); }, ana.id);
    await sleep(1500);
    const tr = await sfuTracks(room, ana.id);
    check("somebody outside the call cannot turn anything off", tr.MICROPHONE === false && tr.CAMERA === false && (await ana.page.evaluate(() => window.__hq.state.mic && window.__hq.state.cam)), JSON.stringify(tr));
    await ana.page.evaluate(() => window.__hq.media.setMic(false));
    await bruno.page.evaluate((id) => window.__hq.session.socket.send({ t: "mute", id, k: "unmute" }), ana.id);
    await sleep(800);
    check("there is no remote unmute", !(await ana.page.evaluate(() => window.__hq.state.mic)));

    // 6. Spotlight: the audience may turn off the speaker's microphone (from the broadcast tile).
    await ana.page.evaluate(() => { window.__hq.state.toast = ""; window.__hq.state.prefs.micOn = true; });
    await walkTo(ana, 34 * 16 + 8, 19 * 16 + 8); // the pad
    await waitFor(() => bruno.page.evaluate((id) => window.__hq.state.spotlight?.state === "live" && window.__hq.spotlightMedia.tiles.some((t) => t.identity === String(id) && t.mic), ana.id), { timeout: 30000, what: "Bruno hears Ana's broadcast" });
    const spotRoom = await ana.page.evaluate(() => window.__hq.spotlightMedia.currentRoom);
    const spotSel = `.spotlight-dock .tile-more[aria-label="More for ${ana.name}"]`;
    await (await bruno.page.waitForSelector(`.spotlight-dock .tile:has(.tile-more[aria-label="More for ${ana.name}"])`)).hover();
    await bruno.page.click(spotSel);
    await bruno.page.waitForSelector(".tile-menu[role=menu]", { timeout: 5000 });
    await bruno.page.evaluate(() => [...document.querySelectorAll(".tile-menu [role=menuitem]")].find((b) => b.textContent.trim() === "Turn off microphone").click());
    await waitFor(async () => sfuMicOff(await sfuTracks(spotRoom, ana.id)) && !(await ana.page.evaluate(() => window.__hq.state.mic || !!window.__hq.spotlightMedia.room?.localParticipant.getTrackPublication("microphone"))), { timeout: 10000, what: "the speaker's microphone off" });
    check("an audience member turns off the speaker's microphone: off on the SFU and released by the speaker", true);
    check("the speaker is told", (await toastSoon(ana, `Bruno${tag} turned off your microphone`)) === `Bruno${tag} turned off your microphone`, await toastText(ana));
    await ana.page.evaluate(() => window.__hq.view.setDirection(-1, 0));
    await waitFor(() => ana.page.evaluate(() => window.__hq.state.spotlight === null), { timeout: 10000, what: "spotlight ends" });
    await ana.page.evaluate(() => window.__hq.view.setDirection(0, 0));

    const errors = [ana, bruno, far].flatMap((u) => u.logs).filter((x) => !/getDisplayMedia|display-capture/.test(x));
    check("no browser errors", errors.length === 0, errors.join(" | ") + (missing.length ? " 404: " + missing.join(", ") : ""));
    return summary();
  } finally { await browser.close(); }
}
