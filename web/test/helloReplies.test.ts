// What the client says after every hello. Run: pnpm exec vitest run (in web/)
import { test } from "vitest";
import assert from "node:assert/strict";
import { helloReplies } from "../src/helloReplies.ts";

test("a client that never consented says so: another client of the same account may have left the server's consent on", () => {
  assert.deepEqual(helloReplies({ consent: false, status: "available" }, null), [{ t: "consent", b: false }]);
});

test("a consenting client says so, then its status when it is not available, then its note", () => {
  assert.deepEqual(helloReplies({ consent: true, status: "busy" }, "back at 3"), [
    { t: "consent", b: true },
    { t: "st", v: "busy" },
    { t: "note", text: "back at 3" },
  ]);
});
