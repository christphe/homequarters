// The documents of a plugin's iframes (its hidden frame and the view of its modal): a language and a title.
// Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { frameHead } from "../src/plugins/frameDoc.ts";

test("a plugin frame's document declares English and has a title", () => {
  const h = frameHead("Chess", "default-src 'none'");
  assert.ok(h.startsWith('<!doctype html><html lang="en"><meta charset="utf-8">'), h);
  assert.ok(h.includes("<title>Chess</title>"), h);
  assert.ok(h.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'">`), h);
});

test("the title is escaped: a label cannot end the title or add markup", () => {
  const h = frameHead(`a</title><script>x()</script> & "q"`, "p");
  assert.ok(h.includes("<title>a&lt;/title&gt;&lt;script&gt;x()&lt;/script&gt; &amp; &quot;q&quot;</title>"), h);
  assert.ok(!h.includes("<script>"), h);
});
