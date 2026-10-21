// Getting around faster: running, double-click "walk to", walk to a person.
import { check, resetChecks, summary, launch, joinAs, waitFor, walkTo, pos, sleep } from "../lib.mjs";

const read = (u, fn, ...args) => u.page.evaluate(fn, ...args);
const click = (u, text, selector = "button") => u.page.evaluate((text, selector) => {
  const b = [...document.querySelectorAll(selector)].find((x) => x.textContent.trim() === text || x.getAttribute("aria-label") === text);
  b?.click(); return !!b;
}, text, selector);
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

/** Distance covered in ~1.5 s of holding "right", measured in the page (frame-rate independent). */
const stride = (u) => read(u, () => new Promise((resolve) => {
  const v = window.__hq.view;
  const p0 = v.position();
  v.setDirection(1, 0);
  const t0 = performance.now();
  setTimeout(() => {
    const p1 = v.position();
    v.setDirection(0, 0);
    resolve((p1.x - p0.x) / ((performance.now() - t0) / 1000));
  }, 1500);
}));

export async function run() {
  resetChecks();
  const browser = await launch();
  try {
    const a = await joinAs(browser, "Runner" + (Date.now() % 10000), { avatar: { sk: 1, hs: 0, hc: 1, sh: 4, pa: 1 } });
    const b = await joinAs(browser, "Watcher" + (Date.now() % 10000));

    // social area, open floor: x 6..18, y 26..30 is clear
    await walkTo(a, 8 * 16 + 8, 28 * 16 + 8);
    await walkTo(b, 8 * 16 + 8, 31 * 16 + 8);

    // ---- running ----
    await walkTo(a, 3 * 16 + 8, 28 * 16 + 8);
    const walkV = await stride(a);
    await walkTo(a, 3 * 16 + 8, 28 * 16 + 8);
    await read(a, () => window.__hq.view.toggleRun(true));
    const runV = await stride(a);
    check("walking speed is ~72 px/s", walkV > 55 && walkV < 85, walkV.toFixed(1));
    check("running (R / Shift) is about twice as fast", runV / walkV > 1.7 && runV / walkV < 2.3, runV.toFixed(1) + " px/s");
    await read(a, () => window.__hq.view.setDirection(1, 0));
    await waitFor(() => read(b, (id) => window.__hq.view.ents.get(id)?.run === true, a.id), { what: "remote sees running" });
    await sleep(500);
    await read(a, () => window.__hq.view.setDirection(0, 0));
    const truth = await pos(a);
    await sleep(600);
    const seen = await read(b, (id) => { const e = window.__hq.view.ents.get(id); return { x: e.x, y: e.y }; }, a.id);
    check("others extrapolate a runner at run speed and agree on where it stops", dist(seen, truth) < 6, dist(seen, truth).toFixed(1) + " px");
    check("the HUD shows the run toggle state", await read(a, () => document.querySelector(".run-toggle")?.getAttribute("aria-pressed") === "true"));
    await read(a, () => window.__hq.view.toggleRun(false));
    check("Shift held while walking runs too", await read(a, () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
      const on = window.__hq.view.running;
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
      return on && !window.__hq.view.running;
    }));

    // ---- double-click to walk ----
    // ---- prediction under network jitter, and at walls ----
    // Every input leaves the page 0-120 ms late (in order), like a bad Wi-Fi. While "right" is held
    // at run speed, the own avatar must never be drawn stepping back, and it must end where the server says.
    await walkTo(a, 4 * 16 + 8, 28 * 16 + 8);
    // Recorded for the convergence check below, which failed once on a starved CI runner (the observer's
    // view kept running 213 px past the stop) and never on a workstation, even with the CPU slowed 10x:
    // what B receives about A, what the server acknowledges to A, and what A sends. Reported on failure.
    await read(b, (id) => {
      const v = window.__hq.view, f = v.applyWorld.bind(v);
      window.__tapB = [];
      v.applyWorld = (m) => { for (const r of m.m ?? []) if (r[0] === id) window.__tapB.push([Math.round(performance.now()), r[1], r[2], r[3]]); if (m.l?.includes(id)) window.__tapB.push([Math.round(performance.now()), "leave"]); return f(m); };
    }, a.id);
    await read(a, () => {
      const v = window.__hq.view, f = v.applyAck.bind(v);
      window.__tapA = [];
      v.applyAck = (k) => { window.__tapA.push([Math.round(performance.now()), k.s, k.x, k.y]); return f(k); };
      const send = WebSocket.prototype.send;
      window.__sentA = [];
      WebSocket.prototype.send = function (d) { if (String(d).includes('"t":"in"')) window.__sentA.push([Math.round(performance.now()), String(d)]); return send.call(this, d); };
    });
    await read(a, () => {
      const orig = WebSocket.prototype.send;
      let last = 0;
      window.__origSend = orig;
      WebSocket.prototype.send = function (d) {
        const at = Math.max(last, performance.now() + Math.random() * 120);
        last = at;
        setTimeout(() => orig.call(this, d), at - performance.now());
      };
    });
    const jitter = await read(a, () => new Promise((resolve) => {
      const v = window.__hq.view;
      v.toggleRun(true);
      v.setDirection(1, 0);
      const xs = [];
      const t0 = performance.now();
      const tick = (now) => {
        xs.push(v.ents.get(v.meId).x);
        if (now - t0 < 1300) requestAnimationFrame(tick);
        else { v.setDirection(0, 0); v.toggleRun(false); resolve(xs); }
      };
      requestAnimationFrame(tick);
    }));
    let back = 0;
    for (let i = 1; i < jitter.length; i++) back = Math.max(back, jitter[i - 1] - jitter[i]);
    check("with 0-120 ms of input jitter, a runner is never drawn stepping back", back <= 0.1 && jitter.at(-1) - jitter[0] > 120, "max step back " + back.toFixed(2) + " px over " + jitter.length + " frames, ran " + (jitter.at(-1) - jitter[0]).toFixed(0) + " px");
    // convergence is polled, not slept: a loaded machine may take longer than 900 ms to deliver the stop
    // convergence is polled with a generous timeout: a loaded software renderer can take seconds
    // to deliver the stop. The trajectory is reported, so a real never-converges bug is told apart
    // from a slow machine.
    const tc0 = Date.now();
    let mine = null, theirs = null, gap = Infinity;
    const gtrail = [];
    let converged = false;
    try {
      await waitFor(async () => {
        mine = await read(a, () => { const v = window.__hq.view, e = v.ents.get(v.meId); return { x: e.x, y: e.y }; });
        theirs = await read(b, (id) => { const e = window.__hq.view.ents.get(id); return { x: e.x, y: e.y }; }, a.id);
        gap = dist(mine, theirs);
        gtrail.push(+gap.toFixed(1));
        return gap < 1;
      }, { timeout: 20000, every: 500, what: "observer converges on the stopped runner" });
      converged = true;
    } catch { /* reported below with the trajectory */ }
    if (!converged) {
      // [ms, x, y, state] B got for A; [ms, seq, x, y] acks to A; [ms, frame] inputs A sent
      console.log("  observer got:", JSON.stringify(await read(b, () => window.__tapB.slice(-12))));
      console.log("  runner's acks:", JSON.stringify(await read(a, () => window.__tapA.slice(-8))));
      console.log("  runner sent:", JSON.stringify(await read(a, () => window.__sentA.slice(-8))));
    }
    check("...and stops where the server and other people see it", converged && gap < 1, gap.toFixed(2) + " px after " + ((Date.now() - tc0) / 1000).toFixed(1) + " s, trail " + gtrail.join("->") + ", mine " + JSON.stringify(mine) + " theirs " + JSON.stringify(theirs));
    await read(a, () => { WebSocket.prototype.send = window.__origSend; });
    // the same on a diagonal at walking speed, where each axis moves slowest (51 px/s): both axes monotonic
    await walkTo(a, 6 * 16 + 8, 30 * 16 + 8);
    await read(a, () => {
      const orig = WebSocket.prototype.send;
      let last = 0;
      WebSocket.prototype.send = function (d) {
        const at = Math.max(last, performance.now() + Math.random() * 120);
        last = at;
        setTimeout(() => orig.call(this, d), at - performance.now());
      };
    });
    const diag = await read(a, () => new Promise((resolve) => {
      const v = window.__hq.view;
      v.setDirection(1, -1);
      const pts = [];
      const t0 = performance.now();
      const tick = (now) => {
        const e = v.ents.get(v.meId);
        pts.push([e.x, e.y]);
        if (now - t0 < 1300) requestAnimationFrame(tick); else { v.setDirection(0, 0); resolve(pts); }
      };
      requestAnimationFrame(tick);
    }));
    let backX = 0, backY = 0;
    for (let i = 1; i < diag.length; i++) { backX = Math.max(backX, diag[i - 1][0] - diag[i][0]); backY = Math.max(backY, diag[i][1] - diag[i - 1][1]); }
    check("...and walking diagonally neither axis is drawn stepping back", backX <= 0.1 && backY <= 0.1 && diag.at(-1)[0] - diag[0][0] > 40, "max back x " + backX.toFixed(2) + " y " + backY.toFixed(2) + " px");
    await read(a, () => { WebSocket.prototype.send = window.__origSend; });
    // A 1-tile wall above (5, 15): run into it, then nothing may pull the avatar away from it.
    await walkTo(a, 5 * 16 + 8, 16 * 16 + 8);
    const wall = await read(a, async () => {
      const v = window.__hq.view, wait = (ms) => new Promise((r) => setTimeout(r, ms));
      v.toggleRun(true);
      v.setDirection(0, -1);
      await wait(700);
      v.setDirection(0, 0);
      v.toggleRun(false);
      const e = v.ents.get(v.meId), at = e.y;
      await wait(900);
      return { at, after: e.y, x: e.x };
    });
    const seenAtWall = await read(b, (id) => window.__hq.view.ents.get(id).y, a.id);
    check("running into a wall stops touching it, with no pull-back afterwards", wall.at === 15 * 16 + 3 && wall.after === wall.at, "y " + wall.at + " -> " + wall.after);
    check("...and others see it touching the wall too", Math.abs(seenAtWall - wall.after) < 0.5, "observer y " + seenAtWall.toFixed(2));

    await walkTo(a, 4 * 16 + 8, 27 * 16 + 8);
    // a free tile a few steps away that is on the map itself, not under a panel (the camera keeps me mid-screen)
    const target = { tx: 6, ty: 30 };
    const box = await read(a, (t) => {
      const v = window.__hq.view, r = v.app.canvas.getBoundingClientRect();
      const x = r.left + v.camX + (t.tx * 16 + 8) * v.S, y = r.top + v.camY + (t.ty * 16 + 8) * v.S;
      return { x, y, onMap: document.elementFromPoint(x, y) === v.app.canvas };
    }, target);
    check("the double-click target is on the map, not under a panel", box.onMap);
    await a.page.mouse.click(box.x, box.y, { count: 2 });
    await waitFor(async () => { const p = await pos(a); return Math.floor(p.x / 16) === target.tx && Math.floor(p.y / 16) === target.ty; }, { timeout: 20000, what: "double-click walk arrives" });
    await sleep(400);
    check("double-clicking the map runs there along a server path and stops", await read(a, () => window.__hq.view.dx === 0 && window.__hq.view.dy === 0 && !window.__hq.view.guided));

    // ---- walk to a person, across the wall into the reception ----
    await walkTo(b, 9 * 16 + 8, 6 * 16 + 8);
    const t0 = Date.now();
    await click(a, "Walk to " + b.name, ".people button");
    const sameTile = (p, q) => Math.floor(p.x / 16) === Math.floor(q.x / 16) && Math.floor(p.y / 16) === Math.floor(q.y / 16);
    await waitFor(async () => sameTile(await pos(a), await pos(b)) && !(await read(a, () => window.__hq.view.guided)), { timeout: 30000, what: "walk to person arrives" });
    check("Walk to (people panel) runs onto the person's tile around walls", true, ((Date.now() - t0) / 1000).toFixed(1) + " s");

    // ---- ...but a locked room keeps the walker at its door, and says why
    await walkTo(b, 50 * 16 + 8, 4 * 16 + 8); // Aurora, an open meeting room
    await waitFor(() => click(b, "Lock room"), { what: "lock control" });
    await waitFor(() => read(a, (id) => window.__hq.state.locked.length > 0, b.id), { what: "lock reaches the walker" });
    await click(a, "Walk to " + b.name, ".people button");
    await waitFor(() => read(a, () => document.querySelector(".toast")?.textContent.includes("stop at the door")), { what: "closed-door toast" });
    await waitFor(async () => !(await read(a, () => window.__hq.view.guided)), { timeout: 30000, what: "walk to the door ends" });
    const atDoor = await pos(a);
    check("Walk to a person in a locked room stops outside, at the door", atDoor.x < 45 * 16 && dist(atDoor, await pos(b)) < 8 * 16, JSON.stringify(atDoor));
    await click(b, "Unlock room");

    // ---- refused targets ----
    await read(a, () => window.__hq.view.goTo(50, 10)); // admin-only boardroom
    await waitFor(() => read(a, () => document.querySelector(".toast")?.textContent.includes("no way")), { what: "unreachable toast" });
    check("the server refuses to route a member into an admin-only room", true);

    check("no console errors", a.logs.length + b.logs.length === 0, [...a.logs, ...b.logs].join(" | ").slice(0, 300));
  } catch (e) {
    check("scenario completed", false, e.message);
  } finally {
    await browser.close();
  }
  return summary();
}
