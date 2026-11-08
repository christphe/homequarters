// The pinned binaries of scripts/tools.ts: every tool has every platform, with a SHA-256, at one version.
// Run: pnpm exec vitest run tools.test.ts  (scripts' test:unit)
import { test } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";
import { TOOLS, location } from "./tools.ts";

test("each tool pins one version, with a SHA-256 for each of the five platforms", () => {
  for (const [name, tool] of Object.entries(TOOLS)) {
    assert.deepEqual(Object.keys(tool.assets).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"], name);
    for (const a of Object.values(tool.assets)) {
      assert.match(a.sha256, /^[0-9a-f]{64}$/, name);
      assert.ok(a.url.startsWith("https://github.com/") && a.url.includes(tool.version), `${name}: ${a.url}`);
    }
  }
});

test("a tool unpacks into a folder named after its version and platform, with .exe on Windows", () => {
  const t = TOOLS["hadolint"]!;
  assert.deepEqual(location("hadolint", t, "win32-x64", "/r/.tools"), {
    dir: path.join("/r/.tools", "hadolint-2.15.1-win32-x64"),
    exe: path.join("/r/.tools", "hadolint-2.15.1-win32-x64", "hadolint.exe"),
  });
  assert.equal(path.basename(location("hadolint", t, "linux-x64", "/r/.tools").exe), "hadolint");
});
