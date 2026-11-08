// Getting around: running under network jitter, seen from another page, and double-click "walk to".
//
// Browser checks kept, per feature:
// - running: the HUD's run button turns always-run on (pressed); with 0-120 ms of input jitter a runner is never
//   drawn stepping back, the delayed inputs leave in order, and the runner stops where the server and the other
//   page see it (prediction against the real tick: it caught a heartbeat-ordering bug)
// - double-click "walk to": double-clicking the map runs there along a server path and stops
// - no console errors
//
// Moved down (decision 0037), where each former check lives now:
// - walking ~72 px/s, running twice as fast: world TestSpeedIsServerEnforced,
//   TestRunningDoublesSpeedAndIsCarriedInTheStateRecord, web/test/localPlayer.test.ts (my page predicts both)
// - others extrapolate a runner at run speed and agree on where it stops: web/test/remoteMotion.test.ts, world
//   TestShadowMatchesTheServerWhileRunning, TestDeadReckoningSendsStateChangesNotEveryTick
// - the HUD shows the run toggle state: web/test/SocialControls.movement.test.tsx
// - Shift held while walking runs: web/test/runKey.test.ts, web/test/layers.test.ts (Shift inverts always-run)
// - the double-click target is on the map: now a precondition of the double-click check, not a check
// - Walk to (people panel) runs onto the person's tile around walls: web/test/SidePanel.test.tsx (the button asks the
//   session), world TestWalkToAPersonEndsOnTheirTile; a locked room keeps the walker at its door and the server
//   refuses forbidden places: world TestWalkToAPersonInALockedRoomStopsAtTheDoor and
//   TestWalkToIsCancelledByInputAndRefusesForbiddenPlaces, their toasts web/test/replies.test.ts
import { check, resetChecks, summary, launch, joinAs, waitFor, walkTo, pos, sleep, type User } from "../lib.ts";
import type { EvaluateFunc } from "puppeteer-core";

// what this scenario records on the pages' windows
type Taps = {
  __origSend: WebSocket["send"];
  __tapB: (number | string)[][];
  __tapA: number[][];
  __sentA: [number, string][];
};

const read = <Params extends unknown[], Func extends EvaluateFunc<Params>>(u: User, fn: Func, ...args: Params) => u.page.evaluate(fn, ...args);
const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);

/** Every frame the page sends leaves 0-120 ms late, in order, like a bad Wi-Fi; window.__origSend undoes it.
 * Each frame gets its own timer, but a timer sends the oldest frame still queued, not its own: two frames
 * due within the same millisecond could otherwise fire swapped (Chrome truncates fractional delays), and
 * a heartbeat "right" landing after the stop once sent the avatar running on alone on the server (CI,
 * 215 px). A WebSocket never reorders, so neither may this stand-in for one. */
const delaySends = (u: User) => read(u, () => {
  // oxlint-disable-next-line typescript/unbound-method -- called with the socket as this (orig.call(this, ...))
  const orig = WebSocket.prototype.send;
  const queue: Parameters<WebSocket["send"]>[0][] = [];
  let last = 0;
  (window as unknown as Taps).__origSend = orig;
  WebSocket.prototype.send = function (d) {
    const at = Math.max(last, performance.now() + Math.random() * 120);
    last = at;
    queue.push(d);
    setTimeout(() => orig.call(this, queue.shift()!), at - performance.now());
  };
});

export async function run(): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  try {
    const a = await joinAs(browser, "Runner" + (Date.now() % 10000), { avatar: { sk: 1, hs: 0, hc: 1, sh: 4, pa: 1 } });
    const b = await joinAs(browser, "Watcher" + (Date.now() % 10000));

    // social area, open floor: x 6..18, y 26..30 is clear
    await Promise.all([walkTo(a, 4 * 16 + 8, 28 * 16 + 8), walkTo(b, 8 * 16 + 8, 31 * 16 + 8)]); // each page walks its own avatar

    // ---- running, through the HUD button, under network jitter ----
    // Every input leaves the page 0-120 ms late (in order), like a bad Wi-Fi. While "right" is held
    // at run speed, the own avatar must never be drawn stepping back, and it must end where the server says.
    await a.page.click(".run-toggle"); // a real mouse click at its centre: a covered button would not get it
    check("the HUD's run button turns always-run on", await read(a, () => window.__hq.view.running && document.querySelector(".run-toggle")?.getAttribute("aria-pressed") === "true"));
    // Recorded for the convergence check below, which failed on CI when this jitter shim sent the stop
    // before the heartbeat queued just ahead of it (the server ran on 215 px): what B receives about A,
    // what the server acknowledges to A, and what A sends. Reported on failure.
    await read(b, (id) => {
      const v = window.__hq.view, f = v.applyWorld.bind(v);
      (window as unknown as Taps).__tapB = [];
      v.applyWorld = (m) => { for (const r of m.m ?? []) if (r[0] === id) (window as unknown as Taps).__tapB.push([Math.round(performance.now()), r[1], r[2], r[3]]); if (m.l?.includes(id)) (window as unknown as Taps).__tapB.push([Math.round(performance.now()), "leave"]); return f(m); };
    }, a.id);
    await read(a, () => {
      const v = window.__hq.view, f = v.applyAck.bind(v);
      (window as unknown as Taps).__tapA = [];
      v.applyAck = (k) => { (window as unknown as Taps).__tapA.push([Math.round(performance.now()), k.s, k.x, k.y]); return f(k); };
      // oxlint-disable-next-line typescript/unbound-method -- called with the socket as this (send.call(this, d))
      const send = WebSocket.prototype.send;
      (window as unknown as Taps).__sentA = [];
      WebSocket.prototype.send = function (d) { if (typeof d === "string" && d.includes('"t":"in"')) (window as unknown as Taps).__sentA.push([Math.round(performance.now()), d]); return send.call(this, d); }; // the client sends JSON text
    });
    await delaySends(a);
    const jitter = await read(a, () => new Promise<number[]>((resolve) => {
      const v = window.__hq.view;
      v.setDirection(1, 0); // always-run is on (the HUD button above)
      const xs: number[] = [];
      const t0 = performance.now();
      const tick = (now: number) => {
        xs.push(v.ents.get(v.meId)!.x);
        if (now - t0 < 1300) requestAnimationFrame(tick);
        else { v.setDirection(0, 0); v.toggleRun(false); resolve(xs); }
      };
      requestAnimationFrame(tick);
    }));
    let back = 0;
    for (let i = 1; i < jitter.length; i++) back = Math.max(back, jitter[i - 1] - jitter[i]);
    check("with 0-120 ms of input jitter, a runner is never drawn stepping back", back <= 0.1 && jitter.at(-1)! - jitter[0] > 120, "max step back " + back.toFixed(2) + " px over " + jitter.length + " frames, ran " + (jitter.at(-1)! - jitter[0]).toFixed(0) + " px");
    // convergence is polled, not slept: a loaded machine may take longer than 900 ms to deliver the stop
    // convergence is polled with a generous timeout: a loaded software renderer can take seconds
    // to deliver the stop. The trajectory is reported, so a real never-converges bug is told apart
    // from a slow machine.
    const tc0 = Date.now();
    let mine: { x: number; y: number } | null = null, theirs: { x: number; y: number } | null = null, gap = Infinity;
    const gtrail: number[] = [];
    let converged = false;
    try {
      await waitFor(async () => {
        mine = await read(a, () => { const v = window.__hq.view, e = v.ents.get(v.meId)!; return { x: e.x, y: e.y }; });
        theirs = await read(b, (id) => { const e = window.__hq.view.ents.get(id)!; return { x: e.x, y: e.y }; }, a.id);
        gap = dist(mine, theirs);
        gtrail.push(+gap.toFixed(1));
        return gap < 1;
      }, { timeout: 20000, every: 500, what: "observer converges on the stopped runner" });
      converged = true;
    } catch { /* reported below with the trajectory */ }
    if (!converged) {
      // [ms, x, y, state] B got for A; [ms, seq, x, y] acks to A; [ms, frame] inputs A sent
      console.log("  observer got:", JSON.stringify(await read(b, () => (window as unknown as Taps).__tapB.slice(-12))));
      console.log("  runner's acks:", JSON.stringify(await read(a, () => (window as unknown as Taps).__tapA.slice(-8))));
      console.log("  runner sent:", JSON.stringify(await read(a, () => (window as unknown as Taps).__sentA.slice(-8))));
    }
    const seqs = await read(a, () => (window as unknown as Taps).__sentA.map(([, d]) => (JSON.parse(d) as { s: number }).s));
    check("the delayed inputs still left the page in order, as on a WebSocket", seqs.length > 2 && seqs.every((s, i) => i === 0 || s > seqs[i - 1]), seqs.join(","));
    check("...and stops where the server and other people see it", converged && gap < 1, gap.toFixed(2) + " px after " + ((Date.now() - tc0) / 1000).toFixed(1) + " s, trail " + gtrail.join("->") + ", mine " + JSON.stringify(mine) + " theirs " + JSON.stringify(theirs));
    await read(a, () => { WebSocket.prototype.send = (window as unknown as Taps).__origSend; });
    // the same on a diagonal (web/test/motion.test.ts "walking diagonally with corrections arriving 0-120 ms
    // late") and against a wall (motion.test.ts "running into a wall stops touching it where the server
    // stops", world TestRunningIntoAWallStopsTouchingIt)

    await walkTo(a, 4 * 16 + 8, 27 * 16 + 8);
    // a free tile a few steps away that is on the map itself, not under a panel (the camera keeps me mid-screen)
    const target = { tx: 6, ty: 30 };
    const box = await read(a, (t) => {
      const v = window.__hq.view, r = v.app.canvas.getBoundingClientRect();
      const x = r.left + v.camX + (t.tx * 16 + 8) * v.S, y = r.top + v.camY + (t.ty * 16 + 8) * v.S;
      return { x, y, onMap: document.elementFromPoint(x, y) === v.app.canvas };
    }, target);
    if (!box.onMap) throw new Error("setup: the double-click target is under a panel, not on the map");
    await a.page.mouse.click(box.x, box.y, { count: 2 });
    await waitFor(async () => { const p = await pos(a); return Math.floor(p.x / 16) === target.tx && Math.floor(p.y / 16) === target.ty; }, { timeout: 20000, what: "double-click walk arrives" });
    await sleep(400);
    check("double-clicking the map runs there along a server path and stops", await read(a, () => window.__hq.view.dx === 0 && window.__hq.view.dy === 0 && !window.__hq.view.guided));

    check("no console errors", a.logs.length + b.logs.length === 0, [...a.logs, ...b.logs].join(" | ").slice(0, 300));
  } catch (e) {
    check("scenario completed", false, (e as Error).message);
  } finally {
    await browser.close();
  }
  return summary();
}
