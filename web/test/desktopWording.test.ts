// In the desktop app (desktop/ sets __HQ_DESKTOP__), texts that speak of a browser tab speak of the app.
// Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { t } from "../src/i18n.ts";

const g = globalThis as { __HQ_DESKTOP__?: unknown };

test("in a browser the texts stay as they are", () => {
  delete g.__HQ_DESKTOP__;
  assert.match(t("settings.notify"), /this tab/);
  assert.match(t("settings.osIdleUnsupported"), /browser/);
});

test("in the desktop app, tab and browser texts speak of the app", () => {
  g.__HQ_DESKTOP__ = { os: "macos" };
  try {
    for (const k of ["settings.notify", "settings.notifyDenied", "settings.osIdleHint", "settings.osIdleUnsupported", "signin.notMe", "share.unsupported", "share.systemDenied"] as const) {
      assert.doesNotMatch(t(k, { name: "Ana" }), /\b(tab|browser)\b/i, k);
    }
    assert.equal(t("media.enable"), "Enable audio and video", "texts without an app variant are unchanged");
  } finally {
    delete g.__HQ_DESKTOP__;
  }
});
