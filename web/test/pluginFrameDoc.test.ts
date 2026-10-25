// The documents of a plugin's iframes (its hidden frame and the view of its modal): a language and a title.
// Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { frameHead, framePolicy } from "../src/plugins/frameDoc.ts";

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

test("framePolicy: a plugin frame loads its own folder and its declared hosts only", () => {
  assert.equal(
    framePolicy("http://h", "hq-cards", ["cdn.example.org", "bad host"], []),
    "default-src 'none'; script-src 'unsafe-inline' http://h/plugins/hq-cards/; connect-src http://h/plugins/hq-cards/ https://cdn.example.org; img-src blob: data: http://h/plugins/hq-cards/ https://cdn.example.org; style-src 'unsafe-inline'",
  );
});

test("framePolicy: a view also draws the shared images of the running plugins, nothing else of theirs", () => {
  const p = framePolicy("http://h", "hq-cards", [], ["hq-card-lastcard", "Bad Name", "hq-cards", "a/../b"]);
  const img = p.split("; ").find((d) => d.startsWith("img-src"));
  assert.equal(img, "img-src blob: data: http://h/plugins/hq-cards/ http://h/plugins/hq-card-lastcard/assets/shared/");
  assert.ok(p.includes("script-src 'unsafe-inline' http://h/plugins/hq-cards/;"), p);
  assert.ok(p.includes("connect-src http://h/plugins/hq-cards/;"), p);
});
