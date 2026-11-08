// Client for plugin integration tests (`**/*.ispec.ts`, run by `node --test`): starts
// `homequarters testbed` (the real server, no LiveKit; server/internal/testbed) and drives members over
// the real HTTP and WebSocket API. Node 24 only: global fetch and WebSocket, no dependency.
//
//   const bed = await testbed({ plugins: [path.resolve(import.meta.dirname, "..")] });
//   after(() => bed.close());
//   const ann = await bed.join("Ann");            // the first member is the administrator
//   await bed.placeObject("chessboard", { x: 13, y: 22 });
//   const bob = await bed.join("Bob", { at: { x: 13, y: 23 } });
//   bob.use({ x: 13, y: 22 });
//   await bob.waitFor("hq-chess", (d) => d.t === "open");
//
// The binary is HQ_BIN, else <repo>/bin/homequarters[.exe] (where the server's fdash `build` puts it),
// else `homequarters` on PATH. The client never builds it.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export type Tile = { x: number; y: number };

export interface Testbed {
  /** The server's base URL; it changes on `restart` (a new free port). */
  url: string;
  /** Joins a new member and opens their socket; resolves once `hello` arrived. The first member is the administrator. */
  join(name: string, o?: { at?: Tile }): Promise<Member>;
  /** Adds a plugin object (`kind`, or `<plugin>/<kind>`) to the map with its top-left tile at `at`, through the admin map API. */
  placeObject(kind: string, at: Tile): Promise<void>;
  /** Starts or stops a plugin through the admin API. */
  setPlugin(name: string, enabled: boolean): Promise<void>;
  /** Sets one of a plugin's settings (from its plugin.json) as Administration > Plugins does; members are told at once. */
  setSetting(plugin: string, key: string, value: number): Promise<void>;
  /** A plugin's stored data as the database holds it now (writes reach it a few milliseconds after `hq.kv.set`: see `waitKv`). */
  kv(plugin: string): Promise<Record<string, string>>;
  /** Polls `kv` until `pred` holds; rejects after `timeoutMs` (default: the bed's `timeoutMs`) with the last data read. */
  waitKv(plugin: string, pred: (kv: Record<string, string>) => boolean, timeoutMs?: number): Promise<Record<string, string>>;
  /** Replaces a plugin's stored data: disables it, writes, enables it again. */
  seedKv(plugin: string, data: Record<string, string>): Promise<void>;
  /** The number of "plugin error" log lines per plugin since the process started. */
  errors(): Promise<Record<string, number>>;
  /** Stops and starts the server on the same database; sockets close, members come back with `reconnect()`. */
  restart(): Promise<void>;
  /** Stops the server and removes its temporary folder. Safe to call twice. */
  close(): Promise<void>;
}

export interface Member {
  id: number;
  name: string;
  /** Sends `{"t":"plg","pl":plugin,"d":d}`. */
  send(plugin: string, d: unknown): void;
  /** Sends the "use" intent for the object at `at` (`{"t":"use","x":..,"y":..}`). */
  use(at: Tile): void;
  /**
   * Sets the member's status (`{"t":"st","v":status}`). Going invisible is leaving for plugins (onLeave), and
   * coming back from invisible is joining (onJoin), at once: unlike `leave()` and `reconnect()`, which within the
   * server's reconnect grace (about 10 s) are neither. An invisible member gets no plugin frames.
   */
  setStatus(status: "available" | "busy" | "away" | "invisible"): void;
  /** Every `d` this member got from `plugin`, in order. */
  received(plugin: string): unknown[];
  /**
   * The first frame of `plugin` satisfying `pred` among those after the previous match of a `waitFor`
   * of this member and plugin (frames up to a match are consumed, so an old frame never matches twice).
   * Rejects after `timeoutMs` (default: the bed's `timeoutMs`), or when the socket closes, naming the last 5 frames.
   */
  waitFor<T>(plugin: string, pred: (d: any) => boolean, timeoutMs?: number): Promise<T>;
  /** Resolves after `ms` if no frame of `plugin` arrived meanwhile; rejects as soon as one does. */
  quiet(plugin: string, ms: number): Promise<void>;
  /** Closes the socket; resolves once it is closed. */
  leave(): Promise<void>;
  /**
   * Opens a new socket with the same session; resolves once `hello` arrived. With `at`, the member's saved
   * position is set first (waiting out the server's reconnect grace, about 11 s after the last socket closed).
   */
  reconnect(o?: { at?: Tile }): Promise<void>;
}

const NO_BINARY = 'no homequarters binary: run "node tools/fdash/cli.ts run build --pkg server" first (or set HQ_BIN)';
const START_MS = 30_000;
const STOP_MS = 15_000;
const HTTP_MS = 10_000;

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** HQ_BIN, else <dir or a parent>/bin/homequarters[.exe] from this file up, else homequarters on PATH. */
function findBinary(): string {
  const exe = process.platform === "win32" ? "homequarters.exe" : "homequarters";
  const env = process.env.HQ_BIN;
  // under fdash (HQ_BIN_REPO_ONLY, set by the tasks): the cache keys the repository's bin/homequarters, read from
  // the disk; another binary would let a pass be recorded for a server it never ran
  const repoOnly = process.env.HQ_BIN_REPO_ONLY === "1";
  if (env && repoOnly) throw new Error(`HQ_BIN is not taken by this fdash task: its cache keys bin/${exe}, built by "node tools/fdash/cli.ts run build --pkg server"; unset HQ_BIN`);
  if (env) {
    if (isFile(env)) return path.resolve(env);
    throw new Error(`${NO_BINARY}; HQ_BIN=${env} is not a file`);
  }
  for (let dir = import.meta.dirname; ; ) {
    const p = path.join(dir, "bin", exe);
    if (isFile(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (repoOnly) throw new Error(NO_BINARY.replace(" (or set HQ_BIN)", ""));
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && isFile(path.join(dir, exe))) return path.join(dir, exe);
  }
  throw new Error(NO_BINARY);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The JSON of a value, cut to `n` characters, for error messages. */
const brief = (v: unknown, n = 300): string => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
};

type Proc = { child: ChildProcess; url: string; exited: Promise<number | null>; stderr: string[] };

/** Spawns the testbed and waits for its {"url":...} line. stdin stays piped: the server stops when this process ends. */
async function startProcess(bin: string, args: string[]): Promise<Proc> {
  // detached on Windows: libuv puts children in a job object killed with this process, which would give the
  // server no chance to remove its --db-temp database; it stops on its own when stdin ends
  const child = spawn(bin, ["testbed", ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform === "win32" });
  const stderr: string[] = [];
  readline.createInterface({ input: child.stderr! }).on("line", (l) => {
    stderr.push(l);
    if (stderr.length > 40) stderr.shift();
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const lines = readline.createInterface({ input: child.stdout! });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const line = await Promise.race([
      new Promise<string>((resolve) => lines.once("line", resolve)),
      exited.then((code) => Promise.reject(new Error(`homequarters testbed exited (${code}) before it was ready`))),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`homequarters testbed not ready after ${START_MS} ms`)), START_MS);
      }),
      new Promise<never>((_, reject) => child.once("error", reject)),
    ]);
    const url = (JSON.parse(line) as { url?: unknown }).url;
    if (typeof url !== "string") throw new Error(`unexpected first line ${brief(line)}`);
    // a test that forgets close() must not keep its process alive for the server's sake
    child.unref();
    for (const s of [child.stdin, child.stdout, child.stderr]) (s as unknown as { unref?: () => void } | null)?.unref?.();
    return { child, url, exited, stderr };
  } catch (e) {
    child.kill();
    await sleep(50); // the last stderr lines
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`${why}\n${bin} testbed ${args.join(" ")}\n--- stderr (last lines) ---\n${stderr.join("\n")}`, { cause: e });
  } finally {
    clearTimeout(timer);
    lines.close();
  }
}

/**
 * Ends stdin (the server's stop signal) and waits for the exit; kills it after STOP_MS. `keep` first sends
 * the line "keep": the server leaves its --db-temp database for the next start (a restart).
 */
async function stopProcess(p: Proc, keep = false): Promise<void> {
  p.child.ref();
  if (keep) p.child.stdin?.write("keep\n");
  p.child.stdin?.end();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    p.exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), STOP_MS);
    }),
  ]);
  clearTimeout(timer); // a pending timer would keep the test process alive for STOP_MS
  if (!stopped) {
    p.child.kill();
    await p.exited;
  }
}

export async function testbed(o: { plugins: string[]; static?: string; timeoutMs?: number }): Promise<Testbed> {
  if (!o.plugins.length) throw new Error("testbed: give at least one plugin folder");
  const bin = findBinary();
  const waitMs = o.timeoutMs ?? 5000;
  const dir = mkdtempSync(path.join(os.tmpdir(), "hq-testbed-client-"));
  // --db-temp: the server removes the database and this folder when it stops, even when this process died
  // without close(); restart() tells it to keep them
  const args = ["--db", path.join(dir, "testbed.db"), "--db-temp"];
  for (const p of o.plugins) args.push("--plugin", path.resolve(p));
  if (o.static) args.push("--static", path.resolve(o.static));

  let proc: Proc;
  try {
    proc = await startProcess(bin, args);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    throw e;
  }
  const members: MemberImpl[] = [];
  let adminCookie = "";
  let closed: Promise<void> | undefined;

  /** One HTTP request; retried while the server answers 429 (map edits are limited to 1/s, burst 5). */
  const call = async (method: string, p: string, body?: unknown, cookie?: string): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (cookie) headers.cookie = cookie;
      const r = await fetch(proc.url + p, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_MS),
      });
      if (r.status !== 429 || attempt >= 20) return r;
      await r.body?.cancel();
      await sleep(250);
    }
  };
  /** A request that must answer `want`, with its JSON body (null when empty). */
  const must = async (want: number, method: string, p: string, body?: unknown, cookie?: string): Promise<unknown> => {
    const r = await call(method, p, body, cookie);
    const text = await r.text();
    if (r.status !== want) throw new Error(`${method} ${p}: ${r.status} ${text.slice(0, 300)} (want ${want})`);
    return text ? (JSON.parse(text) as unknown) : null;
  };
  const admin = (): string => {
    if (!adminCookie) throw new Error("join a member first: the first member is the administrator");
    return adminCookie;
  };

  /** Writes a member's saved position; waits out the reconnect grace (409 with Retry-After). */
  const place = async (id: number, at: Tile): Promise<void> => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const r = await call("POST", "/api/testbed/position", { id, x: at.x, y: at.y });
      const text = await r.text();
      if (r.status === 204) return;
      const retry = r.headers.get("retry-after");
      if (r.status === 409 && retry && Date.now() < deadline) {
        await sleep(Math.max(1, Number(retry) || 1) * 1000);
        continue;
      }
      const why = r.status === 409 && !retry ? " (the member is online: leave() first)" : "";
      throw new Error(`place member ${id} at (${at.x},${at.y}): ${r.status} ${text.slice(0, 200)}${why}`);
    }
  };

  const ctx: BedCtx = {
    wsUrl: () => proc.url.replace(/^http/, "ws") + "/ws",
    place,
    waitMs,
  };

  const kv = async (plugin: string): Promise<Record<string, string>> =>
    (await must(200, "GET", `/api/testbed/kv/${encodeURIComponent(plugin)}`)) as Record<string, string>;
  const setPlugin = async (name: string, enabled: boolean): Promise<void> => {
    await must(200, "PUT", `/api/admin/plugins/${encodeURIComponent(name)}`, { enabled }, admin());
  };

  const bed: Testbed = {
    get url() {
      return proc.url;
    },
    async join(name, jo) {
      const r = await call("POST", "/api/join", { name });
      const text = await r.text();
      if (r.status !== 200) throw new Error(`join ${name}: ${r.status} ${text.slice(0, 200)}`);
      const out = JSON.parse(text) as { id: number; name: string; role?: string };
      const cookie = r.headers
        .getSetCookie()
        .map((c) => c.split(";")[0]!)
        .join("; ");
      if (!cookie) throw new Error(`join ${name}: no session cookie`);
      // the administrator is the member the server made one (the first created), not the first join to answer:
      // members joined at once may answer in any order
      if (!adminCookie && out.role === "admin") adminCookie = cookie;
      const m = new MemberImpl(ctx, out.id, out.name, cookie);
      members.push(m);
      if (jo?.at) await place(m.id, jo.at);
      await m.connect();
      return m;
    },
    async placeObject(kind, at) {
      const cookie = admin();
      let plugin = "";
      let k = kind;
      const slash = kind.indexOf("/");
      if (slash > 0) [plugin, k] = [kind.slice(0, slash), kind.slice(slash + 1)];
      type Obj = { kind: string; size: [number, number] };
      const running = (await must(200, "GET", "/api/plugins", undefined, cookie)) as { name: string; objects?: Obj[] }[];
      const owners = running.filter((p) => (!plugin || p.name === plugin) && p.objects?.some((x) => x.kind === k));
      if (owners.length !== 1) {
        const known = running.flatMap((p) => (p.objects ?? []).map((x) => `${p.name}/${x.kind}`)).join(", ") || "none";
        throw new Error(`placeObject ${kind}: ${owners.length ? "several running plugins have it, write <plugin>/<kind>" : "no running plugin has it"} (objects: ${known})`);
      }
      const owner = owners[0]!;
      const size = owner.objects!.find((x) => x.kind === k)!.size;
      const map = (await must(200, "GET", "/api/admin/map", undefined, cookie)) as { props?: unknown[] };
      map.props = [...(map.props ?? []), { t: `${owner.name}/${k}`, x: at.x, y: at.y, w: size[0], h: size[1] }];
      await must(200, "PUT", "/api/map", map, cookie);
    },
    setPlugin,
    async setSetting(plugin, key, value) {
      await must(200, "PUT", `/api/admin/plugins/${encodeURIComponent(plugin)}/settings`, { key, value }, admin());
    },
    kv,
    async waitKv(plugin, pred, timeoutMs) {
      const deadline = Date.now() + (timeoutMs ?? waitMs);
      for (;;) {
        const data = await kv(plugin);
        if (pred(data)) return data;
        if (Date.now() >= deadline) throw new Error(`waitKv ${plugin}: not satisfied within ${timeoutMs ?? waitMs} ms; last read ${brief(data, 600)}`);
        await sleep(20);
      }
    },
    async seedKv(plugin, data) {
      await setPlugin(plugin, false);
      await must(204, "PUT", `/api/testbed/kv/${encodeURIComponent(plugin)}`, data);
      await setPlugin(plugin, true);
    },
    async errors() {
      return (await must(200, "GET", "/api/testbed/errors")) as Record<string, number>;
    },
    async restart() {
      if (closed) throw new Error("restart after close");
      await stopProcess(proc, true);
      proc = await startProcess(bin, args);
    },
    close() {
      closed ??= (async () => {
        for (const m of members) m.drop();
        await stopProcess(proc);
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      })();
      return closed;
    },
  };
  return bed;
}

type BedCtx = { wsUrl: () => string; place: (id: number, at: Tile) => Promise<void>; waitMs: number };

/** A pending waitFor (`consume`: a match moves the cursor) or quiet. */
type Waiter = { plugin: string; consume: boolean; pred: (d: unknown) => boolean; resolve: (d: unknown) => void; reject: (e: Error) => void };

class MemberImpl implements Member {
  id: number;
  name: string;
  #ctx: BedCtx;
  #cookie: string;
  #ws: WebSocket | undefined;
  #frames = new Map<string, unknown[]>();
  /** Per plugin, the index of the first frame a `waitFor` may still match. */
  #cursor = new Map<string, number>();
  #waiters = new Set<Waiter>();

  constructor(ctx: BedCtx, id: number, name: string, cookie: string) {
    this.#ctx = ctx;
    this.id = id;
    this.name = name;
    this.#cookie = cookie;
  }

  /** Opens the socket and resolves on `hello`. */
  connect(): Promise<void> {
    if (this.#ws && this.#ws.readyState !== WebSocket.CLOSED) return Promise.reject(new Error(`${this.name} is already connected`));
    // undici's WebSocket takes headers: the session cookie, as a browser would send it
    const ws = new WebSocket(this.#ctx.wsUrl(), { headers: { cookie: this.#cookie } } as unknown as string[]);
    this.#ws = ws;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`${this.name}: no hello within ${START_MS} ms`));
      }, START_MS);
      ws.addEventListener("message", (e: MessageEvent) => {
        let m: { t?: string; pl?: string; d?: unknown };
        try {
          m = JSON.parse(String(e.data)) as typeof m;
        } catch {
          return;
        }
        if (m.t === "hello") {
          clearTimeout(timer);
          resolve();
        } else if (m.t === "plg" && typeof m.pl === "string") this.#frame(m.pl, m.d);
      });
      ws.addEventListener("close", (e: CloseEvent) => {
        clearTimeout(timer);
        const err = new Error(`${this.name}: socket closed (${e.code}${e.reason ? " " + e.reason : ""})`);
        reject(err); // no-op once hello came
        for (const w of this.#waiters) w.reject(new Error(`${err.message} while waiting for ${w.plugin}: ${this.#last(w.plugin)}`));
        this.#waiters.clear();
      });
    });
  }

  /** Closes the socket without waiting (the bed is closing). */
  drop(): void {
    this.#ws?.close();
  }

  #frame(plugin: string, d: unknown): void {
    let list = this.#frames.get(plugin);
    if (!list) this.#frames.set(plugin, (list = []));
    list.push(d);
    for (const w of this.#waiters) {
      if (w.plugin !== plugin) continue;
      let ok = false;
      try {
        ok = w.pred(d);
      } catch (e) {
        this.#waiters.delete(w);
        w.reject(e instanceof Error ? e : new Error(String(e)));
        continue;
      }
      if (ok) {
        this.#waiters.delete(w);
        if (w.consume) this.#cursor.set(plugin, list.length);
        w.resolve(d);
      }
    }
  }

  #last(plugin: string): string {
    const list = this.#frames.get(plugin) ?? [];
    if (!list.length) return "no frame received";
    const last = list.slice(-5);
    return `last ${last.length} of ${list.length} frame(s):\n${last.map((d) => "  " + brief(d)).join("\n")}`;
  }

  send(plugin: string, d: unknown): void {
    this.#sendRaw({ t: "plg", pl: plugin, d });
  }

  use(at: Tile): void {
    this.#sendRaw({ t: "use", x: at.x, y: at.y });
  }

  setStatus(status: "available" | "busy" | "away" | "invisible"): void {
    this.#sendRaw({ t: "st", v: status });
  }

  #sendRaw(m: unknown): void {
    if (this.#ws?.readyState !== WebSocket.OPEN) throw new Error(`${this.name} is not connected`);
    this.#ws.send(JSON.stringify(m));
  }

  received(plugin: string): unknown[] {
    return [...(this.#frames.get(plugin) ?? [])];
  }

  waitFor<T>(plugin: string, pred: (d: any) => boolean, timeoutMs?: number): Promise<T> {
    const list = this.#frames.get(plugin) ?? [];
    for (let i = this.#cursor.get(plugin) ?? 0; i < list.length; i++) {
      if (pred(list[i])) {
        this.#cursor.set(plugin, i + 1);
        return Promise.resolve(list[i] as T);
      }
    }
    if (this.#ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${this.name} is not connected (waitFor ${plugin}): ${this.#last(plugin)}`));
    const ms = timeoutMs ?? this.#ctx.waitMs;
    return new Promise<T>((resolve, reject) => {
      const w: Waiter = {
        plugin,
        consume: true,
        pred,
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(w);
        reject(new Error(`${this.name}: no matching ${plugin} frame within ${ms} ms; ${this.#last(plugin)}`));
      }, ms);
      this.#waiters.add(w);
    });
  }

  quiet(plugin: string, ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        plugin,
        consume: false,
        pred: () => true,
        resolve: (d) => {
          clearTimeout(timer);
          reject(new Error(`${this.name}: a ${plugin} frame arrived within ${ms} ms: ${brief(d)}`));
        },
        reject: () => {
          // the socket closed: no frame came
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(w);
        resolve();
      }, ms);
      this.#waiters.add(w);
    });
  }

  leave(): Promise<void> {
    const ws = this.#ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve());
      ws.close(1000);
    });
  }

  async reconnect(o?: { at?: Tile }): Promise<void> {
    await this.leave();
    if (o?.at) await this.#ctx.place(this.id, o.at);
    await this.connect();
  }
}
