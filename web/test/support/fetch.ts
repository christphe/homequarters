// fetch for components that call the API (through request(), web/src/net/http.ts). request() never throws: a
// network failure becomes { ok: false, status: 0 }, so a request the test forgot to answer would pass unseen. Here
// an unanswered request fails the test after it ends.
import { vi } from "vitest";
import { onCleanup } from "./cleanup";

export interface StubRequest {
  method: string;
  /** The path, without the query. */
  path: string;
  /** The query string, with its "?" ("" when none). */
  query: string;
  /** The JSON body, parsed (undefined when there is none). */
  body: unknown;
}
/** An answer: a status (200 by default) and a JSON body ({} by default), or a whole Response. */
export type StubReply = { status?: number; json?: unknown } | Response;
/** A route's answer, fixed or computed from the request. */
export type Route = StubReply | ((req: StubRequest) => StubReply | Promise<StubReply>);

export interface FetchStub {
  /** Every request made, in order, answered or not. */
  requests: StubRequest[];
  /** "METHOD /path" of each request no route answered; the test fails after it ends unless this is empty then. */
  unmatched: string[];
}

async function parse(input: RequestInfo | URL, init?: RequestInit): Promise<StubRequest> {
  const req = new Request(new URL(typeof input === "string" || input instanceof URL ? input : input.url, "http://hq.test/"), init);
  const url = new URL(req.url);
  const text = init?.body === undefined || init.body === null ? "" : await req.text();
  let body: unknown = undefined;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { method: req.method, path: url.pathname, query: url.search, body };
}

const toResponse = (r: StubReply) => {
  if (r instanceof Response) return r;
  const status = r.status ?? 200;
  const empty = status === 204 || status === 205 || status === 304; // a body there makes Response throw
  return new Response(empty ? null : JSON.stringify(r.json ?? {}), { status, headers: { "Content-Type": "application/json" } });
};

/**
 * Answers `fetch` from `routes`, keyed "METHOD /path" ("GET /api/admin/members"); a key ending in "*" matches every
 * path starting with what precedes it ("GET /api/admin/*"). The first matching key wins. A request no route answers
 * gets a 404 and fails the test when it ends, naming the request.
 */
export function stubFetch(routes: Record<string, Route>): FetchStub {
  const stub: FetchStub = { requests: [], unmatched: [] };
  const entries = Object.entries(routes).map(([key, route]) => {
    const [method, path] = key.split(" ", 2);
    if (!method || !path) throw new Error(`stubFetch: the route "${key}" is not "METHOD /path"`);
    return { method: method.toUpperCase(), path, route };
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = await parse(input, init);
    stub.requests.push(req);
    const hit = entries.find((e) => e.method === req.method && (e.path.endsWith("*") ? req.path.startsWith(e.path.slice(0, -1)) : req.path === e.path));
    if (!hit) {
      stub.unmatched.push(`${req.method} ${req.path}`);
      return new Response("{}", { status: 404 });
    }
    return toResponse(typeof hit.route === "function" ? await hit.route(req) : hit.route);
  }));
  onCleanup(() => {
    if (stub.unmatched.length) throw new Error(`stubFetch: no route answered ${stub.unmatched.join(", ")}`);
  });
  return stub;
}

/** `fetch` failing as it does with no network: every call rejects with a TypeError ("Failed to fetch"). */
export function offlineFetch(): FetchStub {
  const stub: FetchStub = { requests: [], unmatched: [] };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    stub.requests.push(await parse(input, init));
    throw new TypeError("Failed to fetch");
  }));
  return stub;
}

/**
 * Collects the promise rejections nobody handled during the test (a click handler whose request threw), so a test
 * can assert there were none. While it listens, Vitest no longer reports them itself, so it fails closed: a
 * rejection still in the list when the test ends fails the test (empty the list to accept one on purpose).
 */
export function unhandledRejections(): unknown[] {
  const seen: unknown[] = [];
  const on = (reason: unknown) => { seen.push(reason); };
  process.on("unhandledRejection", on);
  onCleanup(() => {
    process.off("unhandledRejection", on);
    if (seen.length) throw new Error(`unhandled rejection during the test: ${seen.map(String).join("; ")}`);
  });
  return seen;
}
