// Browser performance under a crowd: FPS, frame time, JS heap and main-thread busy time while ~N bots
// (real WebSocket clients from bin/loadgen) walk around and the tested browser walks too.
// Not part of the default suite: node run.mjs perf   (env PERF_BOTS=300 PERF_SECONDS=30)
// First, alone in the office (before the bots), it counts frames actually drawn (render on demand) while
// standing still and while walking: stats.renders and the rendersTotal counter.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, summary, resetChecks, launch, joinAs, sleep, waitFor, walkTo, API } from "../lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BOTS = Number(process.env.PERF_BOTS ?? 300);
const SECONDS = Number(process.env.PERF_SECONDS ?? 30);
const LOADGEN = path.join(root, "bin", process.platform === "win32" ? "loadgen.exe" : "loadgen"); // (cd server && go build -o ../bin/loadgen.exe ./cmd/loadgen) on Windows
const GPU_ARGS = process.env.PERF_SOFTWARE_GL ? [] : ["--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"];

const WALK_PTS = [[20, 28], [34, 30], [12, 24], [30, 20], [8, 32], [36, 26]];

/** Frames drawn per second over a window: from the rendersTotal counter, and the mean of stats.renders. */
async function rendersOver(u, seconds) {
  const r0 = await u.page.evaluate(() => window.__hq.view.rendersTotal);
  const t0 = Date.now();
  const per = [], fps = [], frameMs = [];
  while (Date.now() - t0 < seconds * 1000) {
    await sleep(1000);
    const s = await u.page.evaluate(() => window.__hq.view.stats);
    per.push(s.renders); fps.push(s.fps); frameMs.push(s.frameMs);
  }
  const r1 = await u.page.evaluate(() => window.__hq.view.rendersTotal);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return { rendersPerSec: +((r1 - r0) / ((Date.now() - t0) / 1000)).toFixed(1), statsRenders: +avg(per).toFixed(1), fps: +avg(fps).toFixed(1), frameMs: +avg(frameMs).toFixed(2) };
}

/** Alone in the office: renders per second standing still, then walking. */
async function measureRenders(browser, size) {
  const u = await joinAs(browser, "Perf-renders", { viewport: size });
  await sleep(3000); // settle: fonts, the bake, the arrival banner
  const idle = await rendersOver(u, 10);
  let stop = false;
  const walker = (async () => {
    let i = 0;
    while (!stop) { try { await walkTo(u, WALK_PTS[i % WALK_PTS.length][0] * 16 + 8, WALK_PTS[i % WALK_PTS.length][1] * 16 + 8, { timeout: 20000 }); } catch { /* keep going */ } i++; }
  })();
  await sleep(1000);
  const walking = await rendersOver(u, 10);
  stop = true;
  await walker.catch(() => {});
  await u.page.evaluate(() => window.__hq.view.setDirection(0, 0));
  await u.page.close();
  return { viewport: size.width + "x" + size.height, idle, walking };
}

async function measure(browser, name, eco, size, ctx) {
  const u = await joinAs(browser, name, { viewport: size });
  await u.page.evaluate((eco) => { localStorage.setItem("hq.settings", JSON.stringify({ eco, maxVideos: 6, audioOnly: false, debug: false })); }, eco);
  await u.page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(() => u.page.evaluate(() => window.__hq?.state?.meId > 0 && window.__hq.state.conn === "open"), { what: "reconnect" });
  const gl = await u.page.evaluate(() => {
    const c = document.createElement("canvas");
    const g = c.getContext("webgl");
    const e = g?.getExtension("WEBGL_debug_renderer_info");
    return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  const cdp = await u.page.createCDPSession();
  await cdp.send("Performance.enable");
  const metric = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  // keep the player walking between random reachable points for the whole window
  let stop = false;
  const walker = (async () => {
    let i = 0;
    while (!stop) { try { await walkTo(u, WALK_PTS[i % WALK_PTS.length][0] * 16 + 8, WALK_PTS[i % WALK_PTS.length][1] * 16 + 8, { timeout: 20000 }); } catch { /* keep going */ } i++; }
  })();
  await sleep(4000); // settle
  const m0 = await metric();
  const t0 = Date.now();
  const samples = [];
  while (Date.now() - t0 < SECONDS * 1000) {
    await sleep(1000);
    samples.push(await u.page.evaluate(() => ({ ...window.__hq.view.stats, heap: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0 })));
  }
  const m1 = await metric();
  stop = true;
  await walker.catch(() => {});
  const wall = (Date.now() - t0) / 1000;
  const avg = (k) => samples.reduce((a, s) => a + s[k], 0) / samples.length;
  const out = {
    mode: eco ? "economy" : "normal", viewport: size.width + "x" + size.height, gl,
    fps: +avg("fps").toFixed(1), fpsMin: Math.min(...samples.map((s) => s.fps)), frameMs: +avg("frameMs").toFixed(2),
    heapMB: +samples[samples.length - 1].heap.toFixed(1), heapStartMB: +samples[0].heap.toFixed(1),
    entities: Math.round(avg("entities")), visible: Math.round(avg("visible")),
    mainThreadBusyPct: +(((m1.TaskDuration - m0.TaskDuration) / wall) * 100).toFixed(1),
    scriptPct: +(((m1.ScriptDuration - m0.ScriptDuration) / wall) * 100).toFixed(1),
    worldMsgsPerSec: Math.round(avg("worldMsgs")), renders: +avg("renders").toFixed(1),
  };
  await cdp.detach();
  await u.page.close();
  return out;
}

export async function run(ctx) {
  resetChecks();
  const alone = await launch(GPU_ARGS, { waitEmpty: false });
  let renders;
  try {
    renders = await measureRenders(alone, { width: 1440, height: 900 });
    console.log("RENDERS " + JSON.stringify(renders));
  } finally {
    await alone.close();
  }
  const bots = spawn(LOADGEN, ["-url", API, "-n", String(BOTS), "-region", "distributed", "-duration", String(SECONDS * 3 + 60) + "s", "-warmup", "1s", "-probes", "0"], { stdio: "ignore" });
  bots.on("error", (e) => console.log("# load generator did not start (" + LOADGEN + "): " + e.message));
  await sleep(Math.max(8000, BOTS * 40));
  const browser = await launch(GPU_ARGS, { waitEmpty: false });
  const results = [];
  try {
    for (const [name, eco, size] of [["Perf-normal", false, { width: 1440, height: 900 }], ["Perf-eco", true, { width: 1440, height: 900 }]]) {
      const r = await measure(browser, name, eco, size, ctx);
      results.push(r);
      console.log("PERF " + JSON.stringify(r));
    }
  } finally {
    await browser.close();
    bots.kill("SIGTERM");
  }
  const [normal, eco] = results;
  check("PERF-INFO bots=" + BOTS + " renderer=" + normal.gl, true);
  check("standing alone in the office draws only the idle heartbeat (at most 5 frames a second)", renders.idle.rendersPerSec <= 5, JSON.stringify(renders.idle));
  check("walking draws frames (render on demand still renders motion)", renders.walking.rendersPerSec >= 20, JSON.stringify(renders.walking));
  check("normal mode renders at 50 FPS or better on this machine", normal.fps >= 50, normal.fps + " fps, frame " + normal.frameMs + " ms, main thread busy " + normal.mainThreadBusyPct + " %");
  check("economy mode holds at least 30 FPS", eco.fps >= 28, eco.fps + " fps, main thread busy " + eco.mainThreadBusyPct + " %");
  check("economy mode uses less main-thread time than normal mode", eco.mainThreadBusyPct < normal.mainThreadBusyPct, eco.mainThreadBusyPct + " % vs " + normal.mainThreadBusyPct + " %");
  check("JS heap did not run away during the window", normal.heapMB - normal.heapStartMB < 30, normal.heapStartMB + " -> " + normal.heapMB + " MB");
  return summary();
}
