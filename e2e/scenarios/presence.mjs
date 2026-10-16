// Presence: waving across the office, raised hands, status notes, dancing, the minimap and the touch pad.
import os from "node:os";
import path from "node:path";
import { check, resetChecks, summary, launch, joinAs, waitFor, walkTo, pos, sleep, APP } from "../lib.mjs";

const read = (u, fn, ...args) => u.page.evaluate(fn, ...args);
const click = (u, text, selector = "button") => u.page.evaluate((text, selector) => {
  const b = [...document.querySelectorAll(selector)].find((x) => x.textContent.trim() === text || x.getAttribute("aria-label") === text);
  b?.click(); return !!b;
}, text, selector);
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const toast = (u) => read(u, () => document.querySelector(".toast")?.textContent ?? "");

export async function run(ctx) {
  resetChecks();
  const browser = await launch();
  try {
    const sfx = Date.now() % 10000;
    const a = await joinAs(browser, "Waver" + sfx);
    const b = await joinAs(browser, "Desk" + sfx);
    await walkTo(a, 8 * 16 + 8, 28 * 16 + 8); // social area
    await walkTo(b, 9 * 16 + 8, 6 * 16 + 8); // reception, behind a wall and out of a's area of interest

    // ---- the mouse wheel zooms the map (not the UI) and the server widens the area of interest to match ----
    const sees = (u, id) => read(u, (id) => window.__tilework.view.debugEntities().some((e) => e.id === id), id);
    const layoutBox = () => read(a, () => [".topbar", ".stage canvas"].map((q) => { const r = document.querySelector(q).getBoundingClientRect(); return [r.width, r.height].join("x"); }).join(" "));
    const s0 = await read(a, () => window.__tilework.view.scale);
    const [lo, hi] = await read(a, () => window.__tilework.view.scaleRange());
    await read(a, (hi) => window.__tilework.view.zoomBy(hi), hi);
    await sleep(800);
    check("zoomed in, someone three cells away is outside the area of interest", !(await sees(a, b.id)));
    await read(a, (s) => window.__tilework.view.zoomBy(s - window.__tilework.view.scale), s0);
    const box0 = await layoutBox();
    const canvas = await read(a, () => { const r = document.querySelector(".stage canvas").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await a.page.mouse.move(canvas.x, canvas.y);
    await a.page.mouse.wheel({ deltaY: -100 });
    await sleep(300);
    check("the plain mouse wheel does not zoom the map", (await read(a, () => window.__tilework.view.scale)) === s0);
    await a.page.keyboard.down("Control"); // Ctrl+wheel zooms, as in Gather
    await a.page.mouse.wheel({ deltaY: -33 }); // one small notch (a mouse sending 33 px per notch)
    await waitFor(() => read(a, (s) => window.__tilework.view.scale === s + 1, s0), { what: "zoom in one step" });
    for (let i = 0; i < 12; i++) { await a.page.mouse.wheel({ deltaY: 33 }); await sleep(150); }
    await a.page.keyboard.up("Control");
    await waitFor(() => read(a, (lo) => window.__tilework.view.scale === lo, lo), { what: "zoomed out to the limit" });
    check("Ctrl+wheel: one notch, however small, is one whole zoom step; out it stops at the area-of-interest limit", lo < s0, `auto ${s0}, farthest ${lo}`);
    check("zooming leaves the UI and the canvas size alone", (await layoutBox()) === box0, box0);
    await waitFor(() => sees(a, b.id), { what: "far person visible after zooming out" });
    check("zoomed out, the server sends the people the wider view shows", true);
    // a stands near the map's west wall: the camera must not show farther than the largest radius reaches
    const span = await read(a, () => {
      const v = window.__tilework.view, p = v.position(), S = v.scale, r = v.aoiMax * v.cellPx, m = v.currentMap();
      const { width: W, height: H } = v.app.screen;
      // visible map pixels only: a margin beyond the map's edge holds nobody
      return { l: p.x - Math.max(0, -v.camX / S), r: Math.min(m.w * 16, (W - v.camX) / S) - p.x, t: p.y - Math.max(0, -v.camY / S), b: Math.min(m.h * 16, (H - v.camY) / S) - p.y, reach: r };
    });
    check("zoomed out next to a map edge, no visible part of the map is farther from me than the server's largest radius", Math.max(span.l, span.r, span.t, span.b) <= span.reach + 1, JSON.stringify(span));
    const lineMode = await read(a, () => {
      const v = window.__tilework.view, c = document.querySelector(".stage canvas"), s0 = v.scale;
      c.dispatchEvent(new WheelEvent("wheel", { deltaY: -3, deltaMode: 1, ctrlKey: true, bubbles: true, cancelable: true })); // Firefox: one notch = 3 lines
      return v.scale - s0;
    });
    check("one wheel notch in line mode (Firefox) is one zoom step", lineMode === 1, `${lineMode}`);
    await read(a, (hi) => window.__tilework.view.zoomBy(hi), hi);
    await waitFor(async () => !(await sees(a, b.id)), { what: "far person dropped after zooming back in" });
    check("zooming back in shrinks the area of interest again", true);
    await read(a, (s) => window.__tilework.view.zoomBy(s - window.__tilework.view.scale), s0);
    check("the zoom returns to the automatic scale", (await read(a, () => window.__tilework.view.scale)) === s0);

    // ---- left-drag pans the camera; a drag is not a double-click; moving recentres ----
    const cam = () => read(a, () => ({ x: window.__tilework.view.camX, y: window.__tilework.view.camY, pan: window.__tilework.view.pan, dest: window.__tilework.view.dest }));
    await sleep(300); // let the frame after the zoom change place the camera
    const c0 = await cam();
    const here0 = await read(a, () => { const v = window.__tilework.view; return { x: (v.app.screen.width / 2 - v.camX) / v.scale, me: v.position().x }; });
    check("next to the office's west wall I stay in the middle of the screen", Math.abs(here0.x - here0.me) < 2, JSON.stringify(here0));
    await a.page.mouse.move(canvas.x, canvas.y);
    await a.page.mouse.down();
    await a.page.mouse.move(canvas.x - 150, canvas.y - 80, { steps: 8 });
    await a.page.mouse.up();
    await sleep(200);
    const c1 = await cam();
    check("dragging the map with the left button moves the view the same way", Math.abs(c1.x - c0.x + 150) <= 2 && Math.abs(c1.y - c0.y + 80) <= 2, `camera ${c0.x},${c0.y} -> ${c1.x},${c1.y}`);
    await a.page.mouse.click(canvas.x - 150, canvas.y - 80, { count: 2 });
    await sleep(300);
    check("a double-click right after a drag does not send me running", !(await cam()).dest && !(await read(a, () => window.__tilework.view.guided)));
    await a.page.mouse.move(canvas.x, canvas.y);
    await a.page.mouse.down();
    await a.page.mouse.move(canvas.x + 2, canvas.y + 1);
    await a.page.mouse.up();
    check("a press that barely moves is a click, not a drag", (await cam()).x === c1.x);
    // pressed on the map next to the top bar and released on the bar before it became a drag:
    // hovering afterwards must not pan
    const bar = await read(a, () => document.querySelector(".topbar").getBoundingClientRect().bottom);
    await a.page.mouse.move(canvas.x, bar + 1);
    await a.page.mouse.down();
    await a.page.mouse.move(canvas.x, bar - 2);
    await a.page.mouse.up();
    await a.page.mouse.move(canvas.x - 100, canvas.y, { steps: 5 });
    await sleep(200);
    check("a press released off the map before dragging leaves no drag behind", (await cam()).x === c1.x && (await read(a, () => document.querySelector(".stage canvas").style.cursor)) !== "grabbing");
    // a drag ends with the text selection and cursor back to normal
    await a.page.mouse.move(canvas.x, canvas.y);
    await a.page.mouse.down();
    await a.page.mouse.move(canvas.x + 60, canvas.y, { steps: 4 });
    await a.page.keyboard.down("Control");
    await a.page.mouse.wheel({ deltaY: -100 }); // zoom in mid-drag, then keep dragging
    await a.page.keyboard.up("Control");
    const z = await read(a, () => window.__tilework.view.scale);
    await sleep(200);
    const mid = await cam();
    await a.page.mouse.move(canvas.x + 90, canvas.y, { steps: 3 });
    await sleep(200);
    const c3 = await cam();
    await a.page.mouse.up();
    check("zooming during a drag keeps the drag 1:1 at the new scale", Math.abs(c3.x - mid.x - 30) <= 2, `scale ${z}, camera ${mid.x} -> ${c3.x}`);
    check("the cursor and text selection are back to normal after a drag", (await read(a, () => document.querySelector(".stage canvas").style.cursor + "|" + document.body.style.userSelect)) === "|");
    await read(a, (s) => window.__tilework.view.zoomBy(s - window.__tilework.view.scale), s0);
    // the camera keeps me mid-screen even next to the office's west wall, and a pan stops at the edge
    await sleep(300);
    const centre = () => read(a, () => { const v = window.__tilework.view; return { x: (v.app.screen.width / 2 - v.camX) / v.scale, me: v.position().x }; });
    const atWall = await centre();
    await a.page.mouse.move(canvas.x - 200, canvas.y);
    await a.page.mouse.down();
    await a.page.mouse.move(canvas.x + 300, canvas.y, { steps: 8 });
    await a.page.mouse.up();
    await sleep(200);
    const panned = await centre();
    check("the camera can show the office's west edge in the middle of the screen, never beyond it", panned.x >= -1 && panned.x < 4, JSON.stringify({ atWall, panned }));
    await a.page.keyboard.down("ArrowDown");
    await sleep(150);
    await a.page.keyboard.up("ArrowDown");
    await sleep(200);
    const c2 = await cam();
    check("moving brings the view back to me", c2.pan.x === 0 && c2.pan.y === 0 && Math.abs(c2.x - c0.x) <= 2, `camera ${c2.x},${c2.y}, pan ${JSON.stringify(c2.pan)}`);

    // ---- wave, answered by walking over ----
    await click(a, "Wave at " + b.name, ".people button");
    await waitFor(() => read(b, () => !!document.querySelector(".wave-card")), { what: "wave card" });
    check("a wave reaches somebody anywhere in the office", (await read(b, () => document.querySelector(".wave-card").textContent)).includes(a.name));
    await waitFor(async () => (await toast(a)).includes("You waved at"), { what: "wave confirmation" });
    check("the sender is told the wave arrived", true);
    await click(b, "Walk to them", ".wave-card button");
    await waitFor(async () => dist(await pos(a), await pos(b)) < 40 && !(await read(b, () => window.__tilework.view.guided)), { timeout: 30000, what: "walk back to the waver" });
    check("Walk to them runs to the person who waved", true);
    await read(b, () => window.__tilework.session.setStatus("busy"));
    await sleep(2200); // wave cooldown
    await click(a, "Wave at " + b.name, ".people button");
    await waitFor(() => read(b, () => !!document.querySelector(".wave-card")), { what: "wave at a busy person" });
    check("a busy person can still be waved at (everybody sees the status)", true);
    await read(b, () => document.querySelector('.wave-card button[aria-label="Dismiss"]')?.click());
    await sleep(2200);
    await click(a, "Wave at " + b.name, ".people button");
    await waitFor(async () => (await toast(a)).includes("30 seconds"), { what: "second wave refused" });
    check("one wave every 30 s at a busy or away person", !(await read(b, () => !!document.querySelector(".wave-card"))));
    await read(b, () => window.__tilework.session.setStatus("available"));

    // ---- raised hand (H) and a status note, seen by the other person ----
    await a.page.keyboard.press("h");
    await waitFor(() => read(b, (id) => window.__tilework.state.roster.get(id)?.h === 1 && !!window.__tilework.view.ents.get(id)?.hand, a.id), { what: "hand raised" });
    check("H raises a hand that others see over the avatar and in the roster", true);
    await a.page.keyboard.press("h");
    await waitFor(() => read(b, (id) => !window.__tilework.state.roster.get(id)?.h && !window.__tilework.view.ents.get(id)?.hand, a.id), { what: "hand lowered" });
    check("pressing H again lowers it", true);
    // two quick presses (before the server's echo) are a raise and a lower, not two raises
    await a.page.keyboard.press("h");
    await a.page.keyboard.press("h");
    await sleep(1500);
    check("H pressed twice quickly leaves the hand down", await read(b, (id) => !window.__tilework.state.roster.get(id)?.h, a.id) && await read(a, () => !window.__tilework.state.roster.get(window.__tilework.state.meId)?.h));
    // the on-screen hand button does the same as H
    await a.page.click('.reaction-row button[aria-label^="Raise hand"]');
    await waitFor(() => read(b, (id) => window.__tilework.state.roster.get(id)?.h === 1, a.id), { what: "hand raised by the button" });
    await waitFor(() => a.page.$('.reaction-row button[aria-label^="Lower hand"][aria-pressed="true"]'), { what: "button shows the raised hand" });
    await a.page.click('.reaction-row button[aria-label^="Lower hand"]');
    await waitFor(() => read(b, (id) => !window.__tilework.state.roster.get(id)?.h, a.id), { what: "hand lowered by the button" });
    check("the hand button raises and lowers the hand for others", true);
    await a.page.click(".status-menu > .btn");
    await a.page.type(".note-form input", "Deep work until 4");
    await a.page.click(".note-form button[type=submit]");
    await waitFor(() => read(b, (n) => [...document.querySelectorAll(".people .note")].some((el) => el.textContent === n), "Deep work until 4"), { what: "note in people panel" });
    check("a status note set in the status menu shows in everyone's people panel", true);

    // ---- shortcuts follow key positions: an AZERTY keyboard types "z" on KeyW and "&" on Digit1 ----
    const key = (type, key, code) => read(a, (type, key, code) => window.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true })), type, key, code);
    await sleep(800); // emote cooldown
    await key("keydown", "&", "Digit1");
    await key("keyup", "&", "Digit1");
    await waitFor(() => read(b, (id) => window.__tilework.view.emotes.has(id), a.id), { what: "emote from the digit row without Shift" });
    check("the digit row sends reactions whatever character the layout types there", true);
    await sleep(800);
    await key("keydown", "z", "KeyW");
    const up = await read(a, () => window.__tilework.view.dy);
    await key("keyup", "z", "KeyW");
    const after = await read(a, () => window.__tilework.view.dy);
    await key("keydown", "ArrowUp", "Numpad8"); // keypad with Num Lock off
    const keypad = await read(a, () => window.__tilework.view.dy);
    await key("keyup", "ArrowUp", "Numpad8");
    check("the keypad without Num Lock still walks", keypad === -1, `dy ${keypad}`);
    await sleep(800);
    check("the key at the W position (Z on AZERTY) walks up and does not dance", up === -1 && after === 0 && !(await read(b, (id) => window.__tilework.view.ents.get(id)?.danceUntil > performance.now(), a.id)), `dy ${up} then ${after}`);

    // ---- dance (Z) ----
    await a.page.keyboard.press("z");
    await waitFor(() => read(b, (id) => window.__tilework.view.ents.get(id)?.danceUntil > performance.now(), a.id), { what: "dance seen" });
    check("Z makes the avatar dance for the people nearby", true);

    // ---- minimap ----
    await waitFor(() => read(a, () => !!document.querySelector(".minimap canvas") && window.__tilework.state.areaCounts.some((n) => n > 0)), { what: "minimap with counts" });
    const counts = await read(a, () => window.__tilework.state.areaCounts);
    check("the minimap shows head counts per area from the server", counts.reduce((x, y) => x + y, 0) >= 2, JSON.stringify(counts));
    const start = await pos(a);
    const box = await read(a, () => { const r = document.querySelector(".minimap canvas").getBoundingClientRect(); const m = window.__tilework.view.currentMap(); return { x: r.left + (4.5 * 16) * (r.width / (m.w * 16)), y: r.top + (30.5 * 16) * (r.width / (m.w * 16)) }; });
    await a.page.mouse.click(box.x, box.y);
    await waitFor(async () => { const p = await pos(a); return Math.floor(p.x / 16) === 4 && Math.floor(p.y / 16) === 30; }, { timeout: 20000, what: "minimap walk" });
    check("clicking the minimap runs there", dist(start, await pos(a)) > 16);
    await a.page.keyboard.press("m");

    // ---- keyboard help and an administrator announcement ----
    // Chrome reports the layout through navigator.keyboard; pretend it is French AZERTY.
    await read(a, () => window.__tilework.keys.setKeyLayout(new Map([["KeyW", "z"], ["KeyA", "q"], ["KeyS", "s"], ["KeyD", "d"], ["KeyZ", "w"], ["KeyM", ","], ["Digit1", "&"]])));
    await a.page.keyboard.press("?");
    await waitFor(() => a.page.$("table.keys"), { what: "shortcuts dialog" });
    const help = await read(a, () => [...document.querySelectorAll("table.keys tr")].map((r) => r.textContent));
    check("the shortcuts list names the keys as printed on the keyboard (ZQSD on AZERTY) but keeps 1-7", help.some((r) => r.startsWith("Z Q S D")) && help.some((r) => r.startsWith("1-7")) && help.some((r) => r.startsWith("W") && r.includes("Dance")) && help.some((r) => r.includes("Ctrl + mouse wheel")), help.join(" | "));
    await read(a, () => window.__tilework.keys.setKeyLayout(null));
    await a.page.keyboard.press("Escape");
    check("? opens the keyboard shortcuts and Escape closes them", await read(a, () => !document.querySelector("table.keys")));
    // AZERTY types "?" with Shift on the M position: the help opens, the minimap does not toggle
    const mini0 = await read(a, () => window.__tilework.state.settings.minimap);
    await read(a, () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", code: "KeyM", shiftKey: true, bubbles: true })));
    await waitFor(() => a.page.$("table.keys"), { what: "shortcuts dialog from Shift+M position" });
    check("? typed on the M position (AZERTY) opens the help without toggling the minimap", (await read(a, () => window.__tilework.state.settings.minimap)) === mini0);
    await a.page.keyboard.press("Escape");
    const admin = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    await waitFor(() => click(admin, "Admin"), { what: "admin button" });
    await waitFor(() => click(admin, "Announce", '[role="tab"]'), { what: "announce tab" });
    await admin.page.type("#announce-text", "Standup in the Horizon room in 5 minutes");
    await click(admin, "Announce", "form button");
    await waitFor(() => read(a, () => document.querySelector(".announce")?.textContent.includes("Standup in the Horizon room")), { what: "banner for a" });
    await waitFor(() => read(b, () => document.querySelector(".announce")?.textContent.includes("Standup in the Horizon room")), { what: "banner for b" });
    check("an administrator's announcement shows as a banner to everybody online", true);
    await click(a, "Dismiss announcement");
    check("the banner can be dismissed", await read(a, () => !document.querySelector(".announce")));
    const log = await read(admin, () => fetch("/api/admin/audit").then((r) => r.text()));
    check("the activity log records the announcement without its text", log.includes('"announce"') && !log.includes("Standup"));
    await admin.page.keyboard.press("Escape");
    check("M hides the minimap", await read(a, () => !document.querySelector(".minimap")));
    await a.page.keyboard.press("m");

    // ---- Ctrl+D: back to my desk ----
    await a.page.keyboard.down("Control");
    await a.page.keyboard.press("d");
    await a.page.keyboard.up("Control");
    await waitFor(async () => (await toast(a)).includes("no desk"), { what: "no desk message" });
    check("Ctrl+D with nothing assigned says so", !(await read(a, () => window.__tilework.view.guided)));
    const api = (await read(a, () => location.origin));
    const full = await (await fetch(api + "/api/admin/map", { headers: { Cookie: "tilework_session=" + ctx.adminCookie } })).json();
    const putMap = (m) => fetch(api + "/api/map", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: "tilework_session=" + ctx.adminCookie }, body: JSON.stringify(m) });
    const withDesk = JSON.parse(JSON.stringify(full));
    // a free desk of the open-plan area whose right-hand neighbour is free too (other scenarios may have assigned some)
    const free = (x, y) => withDesk.props.find((p) => p.t === "desk" && p.x === x && p.y === y && !p.assign);
    const desk = withDesk.props.find((p) => p.t === "desk" && !p.assign && p.y < 14 && free(p.x + 4, p.y));
    Object.assign(desk, { assign: a.id, label: "Desk of " + a.name.slice(0, 30) });
    check("an administrator assigns a desk (API)", (await putMap(withDesk)).ok, `desk at ${desk.x},${desk.y}`);
    await waitFor(() => read(a, (id) => window.__tilework.view.map.props.some((p) => p.t === "desk" && p.assign === id), a.id), { what: "desk assignment reaches the client" });
    await a.page.keyboard.down("Control");
    await a.page.keyboard.press("d");
    await a.page.keyboard.up("Control");
    await waitFor(async () => { const p = await pos(a); return Math.floor(p.x / 16) === desk.x && Math.floor(p.y / 16) === desk.y + 1; }, { timeout: 30000, what: "back at the desk" });
    check("Ctrl+D runs to the chair of my assigned desk", true);
    // ---- an assigned desk is a room: alone there is no call; the neighbour's desk is not in it; a visitor is
    const conv = (u) => read(u, () => window.__tilework.state.conv);
    await Promise.all([a, b].map((u) => read(u, () => window.__tilework.session.setConsent(true))));
    await sleep(2000);
    check("alone at my desk with audio allowed, there is no call", !(await conv(a)));
    const deskRoom = await read(a, (id) => { const v = window.__tilework.view, i = v.map.areas.findIndex((r) => r.id === id); return { i, auto: v.map.areas[i]?.auto === true, floor: v.map.areas[i]?.floor, labelled: v.areaLabels.some((l) => l.ai === i) }; }, `desk-${desk.x}-${desk.y}`);
    check("my desk has its own room, drawn with the desk floor and no label of its own", deskRoom.i >= 0 && deskRoom.auto && deskRoom.floor === "desk_mat" && !deskRoom.labelled, JSON.stringify(deskRoom));
    check("the place shown at my desk is still the desks area", (await read(a, () => window.__tilework.state.currentArea)) === "Individual desks");
    await walkTo(b, (desk.x + 4) * 16 + 8, (desk.y + 1) * 16 + 8); // the neighbouring desk's chair, 4 tiles away
    await sleep(2500);
    check("sitting at the neighbouring desk does not join my desk's call", !(await conv(a)) && !(await conv(b)));
    await a.page.screenshot({ path: path.join(os.tmpdir(), "tilework-desk-room.png") });
    await walkTo(b, (desk.x + 1) * 16 + 8, (desk.y + 2) * 16 + 8); // just behind my chair, inside my desk's room
    await waitFor(async () => (await conv(a))?.kind === "r" && (await conv(b))?.kind === "r", { timeout: 20000, what: "desk call" });
    check("coming over to my desk starts its call for both of us", (await conv(a)).name.startsWith("Desk of"), (await conv(a)).name);
    await walkTo(b, (desk.x + 2) * 16 + 8, (desk.y + 4) * 16 + 8); // back out into the aisle
    await waitFor(async () => !(await conv(a)) && !(await conv(b)), { timeout: 20000, what: "desk call ends" });
    check("when the visitor leaves, the call ends and I stay at my desk alone", true);
    // ---- the owner locks the desk with its real button: the visitor knocks and is let in
    const btn = (u, text) => read(u, (text) => { const x = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(text)); x?.click(); return !!x; }, text);
    const has = (u, text) => read(u, (text) => [...document.querySelectorAll("button")].some((b) => b.textContent.trim().startsWith(text)), text);
    await waitFor(() => btn(a, "Lock desk"), { what: "lock desk button" });
    await waitFor(() => read(b, () => window.__tilework.state.locked.length > 0), { what: "lock reaches the visitor" });
    check("the desk shows a lock to others", await read(b, () => window.__tilework.view.deskLabels.some((l) => l.text.text.endsWith("🔒"))));
    await walkTo(b, (desk.x + 1) * 16 + 8, (desk.y + 4) * 16 + 8); // right behind the desk room, then try to walk in
    await b.page.evaluate(() => window.__tilework.view.setDirection(0, -1));
    await sleep(1200);
    await b.page.evaluate(() => window.__tilework.view.setDirection(0, 0));
    const bTile = await pos(b);
    check("a locked desk keeps the visitor out", Math.floor(bTile.y / 16) > desk.y + 2, `y tile ${Math.floor(bTile.y / 16)}`);
    await waitFor(() => btn(b, "Knock · Desk of"), { what: "knock on the desk" });
    await waitFor(() => btn(a, "Let in"), { what: "owner asked" });
    await walkTo(b, (desk.x + 1) * 16 + 8, (desk.y + 2) * 16 + 8);
    check("the owner lets the visitor in", Math.floor((await pos(b)).y / 16) === desk.y + 2);
    check("a visitor at somebody's desk cannot lock it", !(await has(b, "Lock desk")) && !(await has(b, "Unlock desk")));
    await btn(a, "Unlock desk");
    await walkTo(b, (desk.x + 2) * 16 + 8, (desk.y + 4) * 16 + 8);
    await Promise.all([a, b].map((u) => read(u, () => window.__tilework.session.setConsent(false))));
    check("restoring the map", (await putMap(full)).ok);

    // ---- touch pad on a phone-sized touch screen ----
    const pctx = await browser.createBrowserContext();
    const phone = await pctx.newPage();
    await phone.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36" });
    await phone.goto(process.env.TILEWORK_APP + "/", { waitUntil: "domcontentloaded" });
    await phone.waitForSelector("input");
    await phone.type("input", "Phone" + sfx);
    await phone.click("button.primary");
    await waitFor(() => phone.evaluate(() => window.__tilework?.state?.conn === "open"), { timeout: 30000, what: "phone connected" });
    const pad = await waitFor(() => phone.$(".touchpad .tp-right"), { what: "touch pad" });
    const p0 = await phone.evaluate(() => window.__tilework.view.position());
    const r = await pad.boundingBox();
    await phone.touchscreen.touchStart(r.x + r.width / 2, r.y + r.height / 2);
    await sleep(700);
    await phone.touchscreen.touchEnd();
    await sleep(200);
    const p1 = await phone.evaluate(() => window.__tilework.view.position());
    check("on a touch screen the on-screen pad walks the avatar", p1.x - p0.x > 10, (p1.x - p0.x).toFixed(1) + " px");
    await pctx.close();

    // ---- away from the computer's own idle state (Idle Detection), opted in from the real setting
    {
      const c = await joinAs(browser, "Idler" + sfx);
      const cdp = await c.page.createCDPSession();
      await cdp.send("Emulation.setIdleOverride", { isUserActive: true, isScreenUnlocked: true });
      await c.page.evaluate(() => document.querySelector(".bar-row .round.ghost")?.click());
      await waitFor(() => c.page.$(".modal"), { what: "settings dialog" });
      const idleBox = () => c.page.evaluateHandle(() => [...document.querySelectorAll(".modal label.check")].find((l) => l.textContent.includes("computer is idle"))?.querySelector("input"));
      // blocked by the browser: the click must say so (asking would never answer), and the setting stays off
      await cdp.send("Browser.setPermission", { permission: { name: "idle-detection" }, setting: "denied" });
      await (await idleBox()).click();
      await waitFor(() => c.page.evaluate(() => !!document.querySelector(".modal .setting-note")), { timeout: 5000, what: "blocked note" }).catch(() => {});
      const blocked = await c.page.evaluate(() => ({ note: document.querySelector(".modal .setting-note")?.textContent ?? "", on: window.__tilework.state.settings.osIdle }));
      check("a browser that blocks idle detection gets an explanation next to the setting, which stays off", blocked.note.includes("blocks idle detection") && !blocked.on, JSON.stringify(blocked));
      await c.ctx.overridePermissions(APP, ["idle-detection"]);
      const box = await idleBox();
      await box.click();
      await waitFor(() => c.page.evaluate(() => window.__tilework.state.settings.osIdle), { what: "idle setting on" });
      await c.page.keyboard.press("Escape");
      const status = () => c.page.evaluate(() => window.__tilework.state.status);
      const seenBy = () => a.page.evaluate((id) => window.__tilework.state.roster.get(id)?.s, c.id);
      await cdp.send("Emulation.setIdleOverride", { isUserActive: false, isScreenUnlocked: true });
      await waitFor(async () => (await status()) === "away" && (await seenBy()) === "away", { timeout: 10000, what: "away when the computer is idle" });
      check("with the setting on, an idle computer sets me away (others see it)", true);
      await cdp.send("Emulation.setIdleOverride", { isUserActive: true, isScreenUnlocked: true });
      await waitFor(async () => (await status()) === "available", { timeout: 10000, what: "back when the computer is used" });
      check("...and using the computer again brings me back", true);
      await cdp.send("Emulation.setIdleOverride", { isUserActive: true, isScreenUnlocked: false });
      await waitFor(async () => (await status()) === "away", { timeout: 10000, what: "away when the screen is locked" });
      check("a locked screen sets me away too", true);
      await cdp.send("Emulation.setIdleOverride", { isUserActive: true, isScreenUnlocked: true });
      await waitFor(async () => (await status()) === "available", { timeout: 10000, what: "back after unlocking" });
      check("no console errors for the idle-detecting player", c.logs.length === 0, c.logs.join(" | ").slice(0, 300));
      await c.ctx.close();
    }

    check("no console errors", a.logs.length + b.logs.length === 0, [...a.logs, ...b.logs].join(" | ").slice(0, 300));
  } catch (e) {
    check("scenario completed", false, e.message);
  } finally {
    await browser.close();
  }
  return summary();
}
