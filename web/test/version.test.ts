// Deploy versions: a page from one deploy talking to a server from another must reload. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOutdated } from "../src/version.ts";

test("a page from another deploy is outdated", () => {
  assert.equal(isOutdated("1abfb91", "9fc44ab"), true);
  assert.equal(isOutdated("9fc44ab", "9fc44ab"), false);
});

test("without a version on either side, nothing is decided (dev server, older server)", () => {
  assert.equal(isOutdated("", "9fc44ab"), false);
  assert.equal(isOutdated("9fc44ab", undefined), false);
  assert.equal(isOutdated("9fc44ab", ""), false);
});
