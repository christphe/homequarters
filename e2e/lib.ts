// Shared helpers for real-browser end-to-end tests (Chrome + fake camera/mic).
import { chrome } from "./env.ts";
import puppeteer, { type Browser, type BrowserContext, type Page, type Viewport } from "puppeteer-core";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
// for scenarios outside e2e/ (plugins/e2e/*), which cannot resolve puppeteer-core from their own folder
export type { BoundingBox, Browser, BrowserContext, CDPSession, ElementHandle, Frame, HTTPRequest, Page } from "puppeteer-core";

/** A player of a scenario: an isolated browser context with its page, joined as name (joinAs). */
export type User = { ctx: BrowserContext; page: Page; name: string; logs: string[]; id: number };

/** What run.ts gives every scenario's run(). */
export interface RunContext {
  /** the run's temporary folder (database, server log, plugins) */
  dir: string;
  /** the server binary the run built */
  bin: string;
  server: ChildProcess | null;
  /** the session cookie and id of the office's first member, its administrator */
  adminCookie: string;
  adminId: number;
  /** runs fn after the other scenarios, once `due` (a Date.now() time) has passed */
  defer(name: string, due: number, fn: () => Promise<unknown>): void;
  startServer(): Promise<void>;
  stopServer(): Promise<void>;
}

/** What every file of scenarios/ exports. */
export type Scenario = { run(ctx: RunContext): Promise<boolean> };

export const APP = process.env.HQ_APP ?? "http://127.0.0.1:5173";
export const API = process.env.HQ_API ?? "http://127.0.0.1:8080";
export const LK = process.env.HQ_LK_HTTP ?? "http://127.0.0.1:7880";
const KEY = process.env.LIVEKIT_API_KEY ?? "devkey";
const SECRET = process.env.LIVEKIT_API_SECRET ?? "secret";


export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let results: { name: string; ok: boolean }[] = [];
export const resetChecks = () => { results = []; };
export function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
}
export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  return failed.length === 0;
}

/** Tests share one office: wait until players from a previous run have left (reconnect grace). */
export async function waitForEmptyOffice() {
  await waitFor(async () => (await metrics()).hq_players === 0, { timeout: 30000, every: 500, what: "empty office" });
}

export async function launch(extra: string[] = [], { waitEmpty = true } = {}): Promise<Browser> {
  // HQ_SHARED_OFFICE=1: a public instance (the demo) may have real visitors and no /metrics; do not wait.
  if (waitEmpty && !process.env.HQ_SHARED_OFFICE) await waitForEmptyOffice();
  return puppeteer.launch({
    executablePath: chrome(),
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--enable-unsafe-swiftshader",
      // GitHub's Ubuntu runners forbid the Chrome sandbox (AppArmor); the browser only ever loads our own test pages.
      ...(process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] : []),
      // On Windows, headless Chrome's fake camera track ends at once while the GPU process runs; without it, it streams.
      ...(process.platform === "win32" ? ["--disable-gpu"] : []),
      ...extra,
    ],
  });
}

/** Polls fn until it gives a truthy value, and returns that value. */
export async function waitFor<T>(fn: () => T | Promise<T>, { timeout = 15000, every = 100, what = "condition" } = {}): Promise<Exclude<T, false | 0 | "" | null | undefined>> {
  const t0 = Date.now();
  for (;;) {
    let v: T | false;
    try { v = await fn(); } catch { v = false; }
    if (v) return v as Exclude<T, false | 0 | "" | null | undefined>;
    if (Date.now() - t0 > timeout) throw new Error("timeout waiting for " + what);
    await sleep(every);
  }
}

/** Opens an isolated browser context (own cookies) and joins as name. */
type JoinOptions = { path?: string; avatar?: object | null; viewport?: Viewport; cookie?: string | null };
export async function joinAs(browser: Browser, name: string, { path = "/", avatar = null, viewport = process.env.E2E_VIEWPORT === "small" ? { width: 800, height: 450 } : { width: 1280, height: 720 }, cookie = null }: JoinOptions = {}): Promise<User> {
  // CI runners render in software (SwiftShader) on 2 cores; a smaller canvas keeps the browsers near 30 fps.
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  if (cookie) await ctx.setCookie({ name: "hq_session", value: cookie, domain: new URL(APP).hostname, path: "/", httpOnly: true, sameSite: "Lax" });
  await page.setViewport(viewport);
  // the top page only: it would also run in a plugin's sandboxed iframe, where storage throws
  if (avatar) await page.evaluateOnNewDocument((a) => { if (window === window.top) localStorage.setItem("hq.avatar", JSON.stringify(a)); }, avatar);
  const logs: string[] = [];
  // livekit-client logs these two as errors when WE close a call on purpose (user-initiated abort of its data channels)
  const benign = /DataChannel error on (lossy|reliable): User-Initiated Abort|publisher data channel '(DATA_TRACK_)?(LOSSY|RELIABLE)' closed unexpectedly|error reading from signal stream/i; // the last one: LiveKit's signal socket dropped on a loaded runner; the client reconnects on its own
  // a failed load says only its status: add the URL it was for (the console message carries it)
  page.on("console", (m) => { if (m.type() === "error" && !benign.test(m.text())) logs.push(m.text() + (m.text().startsWith("Failed to load resource") && m.location()?.url ? " " + m.location().url : "")); });
  page.on("pageerror", (e) => logs.push("pageerror: " + (e as Error).message));
  await page.goto(APP + path, { waitUntil: "domcontentloaded" });
  if (!cookie) {
    await page.waitForSelector("input", { timeout: 10000 });
    await page.type("input", name);
    await page.click("button.primary");
  }
  await waitFor(() => page.evaluate(() => window.__hq?.state?.meId > 0 && window.__hq.state.conn === "open"), { timeout: 30000, what: name + " connected" });
  return { ctx, page, name, logs, id: await page.evaluate(() => window.__hq.state.meId) };
}

export const pos = (u: User) => u.page.evaluate(() => window.__hq.view.position());
export const others = (u: User) => u.page.evaluate(() => window.__hq.view.debugEntities());
export const st = (u: User) => u.page.evaluate(() => ({ conv: window.__hq.state.conv, mic: window.__hq.state.mic, cam: window.__hq.state.cam, status: window.__hq.state.status, consent: window.__hq.state.consent }));

/** BFS over the map's solid grid, then walk waypoint by waypoint using the real input path. */
export async function walkTo(u: User, tx: number, ty: number, { timeout = 60000 } = {}) {
  const grid = await u.page.evaluate(() => ({ w: window.__hq.view.map!.w, h: window.__hq.view.map!.h, solid: window.__hq.view.map!.solid, deny: [...window.__hq.view.deny] }));
  const T = 16;
  const p0 = await pos(u);
  const start = [Math.floor(p0.x / T), Math.floor(p0.y / T)];
  const goal = [Math.floor(tx / T), Math.floor(ty / T)];
  const key = (x: number, y: number) => y * grid.w + x;
  const prev = new Map<number, [number, number] | null>([[key(start[0], start[1]), null]]);
  const q: [number, number][] = [[start[0], start[1]]];
  while (q.length) {
    const [x, y] = q.shift()!;
    if (x === goal[0] && y === goal[1]) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= grid.w || ny >= grid.h || grid.solid[ny][nx] === "1" || prev.has(key(nx, ny))) continue;
      prev.set(key(nx, ny), [x, y]);
      q.push([nx, ny]);
    }
  }
  const path: [number, number][] = [];
  for (let c: [number, number] | null | undefined = [goal[0], goal[1]]; c; c = prev.get(key(c[0], c[1]))) path.unshift(c);
  if (!prev.has(key(goal[0], goal[1]))) throw new Error("no path");
  const t0 = Date.now();
  for (const [cx, cy] of path.slice(1)) {
    await steer(u, cx * T + 8, cy * T + 8, Math.max(1000, timeout - (Date.now() - t0)), "walk timeout to " + cx + "," + cy + " (" + u.name + ")");
  }
  // land exactly at the requested pixel inside the goal tile
  await steer(u, tx, ty, 5000, "landing timeout (" + u.name + ")").catch(() => {});
  await u.page.evaluate(() => window.__hq.view.setDirection(0, 0));
}

/**
 * Holds a direction until the avatar is at (wx, wy). The control loop runs inside the page on requestAnimationFrame,
 * so it reacts on the very frame that moves the avatar. Driving it from Node (one CDP round trip per decision)
 * overshoots on slow software-rendered CI browsers (~10-16 fps, i.e. 4-7 px per frame at 72 px/s).
 * Each axis stops once within max(1.5 px, half a frame of travel), so accuracy follows the frame rate.
 */
async function steer(u: User, wx: number, wy: number, timeoutMs: number, what: string) {
  const r = await u.page.evaluate((wx, wy, timeoutMs) => new Promise<{ ok: boolean; [more: string]: unknown }>((resolve) => {
    const v = window.__hq.view;
    const speed = 72; // world.Config.Speed, px/s
    const t0 = performance.now();
    let last = t0;
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const tol = Math.max(1.5, speed * dt * 0.5);
      const p = v.position();
      const dx = Math.abs(wx - p.x) > tol ? Math.sign(wx - p.x) : 0;
      const dy = Math.abs(wy - p.y) > tol ? Math.sign(wy - p.y) : 0;
      if (!dx && !dy) { v.setDirection(0, 0); resolve({ ok: true }); return; }
      if (now - t0 > timeoutMs) {
        resolve({ ok: false, hidden: document.hidden, conn: window.__hq.state.conn, pos: p, fps: v.stats.fps });
        return;
      }
      v.setDirection(dx, dy);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }), wx, wy, timeoutMs);
  if (!r.ok) throw new Error(what + " " + JSON.stringify(r));
}

// ---- server-side checks ----
export async function metrics() {
  const txt = await (await fetch(API + "/metrics")).text();
  const m: Record<string, number> = {};
  for (const line of txt.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [k, v] = line.split(" ");
    m[k] = Number(v);
  }
  return m;
}

function jwt(video: object) {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = b({ alg: "HS256", typ: "JWT" }) + "." + b({ iss: KEY, nbf: now - 10, exp: now + 60, video });
  return body + "." + crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
}
/** The fields of LiveKit's RoomService answers the suite reads; an error answer carries `error` and `text` instead. */
export type LkTrack = { type?: string; source?: string; muted?: boolean; layers?: unknown[]; mimeType?: string; width?: number; height?: number };
export type LkParticipant = { identity: string; tracks?: LkTrack[] };
export type LkReply = { rooms?: { name: string }[]; participants?: LkParticipant[]; tracks?: LkTrack[]; error?: number; text?: string };
export async function lk(method: string, body: object, room?: string): Promise<LkReply> {
  const r = await fetch(LK + "/twirp/livekit.RoomService/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt({ roomAdmin: true, roomList: true, room }) },
    body: JSON.stringify(body),
  });
  return r.ok ? ((await r.json()) as LkReply) : { error: r.status, text: await r.text() };
}
export const lkParticipants = async (room: string): Promise<string[]> => ((await lk("ListParticipants", { room }, room)).participants ?? []).map((p) => p.identity);

/** The fields of an RTCStatsReport entry the RTP counters read (inbound-rtp and outbound-rtp entries). */
export type RtpStats = { type: string; kind?: string; trackIdentifier?: string; packetsReceived?: number; bytesReceived?: number; bytesSent?: number };

/** Sum of RTP bytes on the LiveKit peer connection (single-PC mode: publisher.pc carries both directions). */
/** Audio or video packets received so far: a stream that still flows, even silent (Opus sends a packet
 * every 400 ms when there is nothing to say, so bytes depend on the sound, packets much less). */
export const rtpPackets = (u: User, kind: "audio" | "video") =>
  u.page.evaluate(async (kind) => {
    const pm = (window.__hq.media as unknown as { room: { engine: { pcManager: { subscriber?: { pc: RTCPeerConnection }; publisher: { pc: RTCPeerConnection } } } } }).room.engine.pcManager;
    const pc = pm.subscriber?.pc ?? pm.publisher.pc;
    let total = 0;
    (await pc.getStats()).forEach((s: RtpStats) => {
      if (s.kind === kind && s.type === "inbound-rtp") total += s.packetsReceived ?? 0;
    });
    return total;
  }, kind);

export const rtpBytes = (u: User, dir: "inbound" | "outbound", kind: "audio" | "video") =>
  u.page.evaluate(async (dir, kind) => {
    const pm = (window.__hq.media as unknown as { room: { engine: { pcManager: { subscriber?: { pc: RTCPeerConnection }; publisher: { pc: RTCPeerConnection } } } } }).room.engine.pcManager;
    const pc = pm.subscriber?.pc ?? pm.publisher.pc;
    let total = 0;
    (await pc.getStats()).forEach((s: RtpStats) => {
      if (s.kind === kind && s.type === (dir === "inbound" ? "inbound-rtp" : "outbound-rtp")) total += (dir === "inbound" ? s.bytesReceived : s.bytesSent) ?? 0;
    });
    return total;
  }, dir, kind);
