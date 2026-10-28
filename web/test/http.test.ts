// request(): the UI's only way to the API, which never throws. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "../src/net/http.ts";

const withFetch = async (fake: typeof fetch, run: () => Promise<void>) => {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
};

test("a network failure is status 0, not a rejection", async () => {
  await withFetch(() => Promise.reject(new TypeError("Failed to fetch")), async () => {
    assert.deepEqual(await request("PUT", "/api/profile", { name: "Ana" }), { ok: false, status: 0, json: {} });
  });
});

test("an answer keeps its status and JSON; a body that is not JSON is {}", async () => {
  await withFetch(async () => new Response(JSON.stringify({ error: "too long" }), { status: 400 }), async () => {
    assert.deepEqual(await request("PATCH", "/api/admin/office", { name: "x" }), { ok: false, status: 400, json: { error: "too long" } });
  });
  await withFetch(async () => new Response("not json", { status: 200 }), async () => {
    assert.deepEqual(await request("GET", "/api/admin/map"), { ok: true, status: 200, json: {} });
  });
});

test("a body is sent as JSON; no body sends no Content-Type", async () => {
  const seen: RequestInit[] = [];
  await withFetch(async (_url, init) => { seen.push(init ?? {}); return new Response("{}"); }, async () => {
    await request("POST", "/api/join", { name: "Ana" });
    await request("POST", "/api/signout");
  });
  assert.deepEqual(seen[0], { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"name":"Ana"}' });
  assert.deepEqual(seen[1], { method: "POST" });
});
