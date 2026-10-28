/** The answer to a request: `status` 0 when there was none (the network failed); `json` is {} when the body is not JSON. */
export interface Reply<T> {
  ok: boolean;
  status: number;
  json: T & { error?: string };
}

/**
 * A request to the server that never throws, so a handler cannot leave an unhandled rejection behind:
 * a network failure is `{ ok: false, status: 0 }` and takes the caller's error path. The UI calls the
 * API only through here (the lint refuses `fetch` in web/src/ui).
 */
export async function request<T = Record<string, never>>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
  let r: Response;
  try {
    r = await fetch(path, body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, status: 0, json: {} as T & { error?: string } };
  }
  return { ok: r.ok, status: r.status, json: (await r.json().catch(() => ({}))) as T & { error?: string } };
}
