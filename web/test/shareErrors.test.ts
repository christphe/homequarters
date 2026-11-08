// What a person is told when a screen share cannot start (web/src/media/shareErrors.ts). The errors are the
// DOMExceptions browsers give getDisplayMedia. The browser suite keeps one real click (system blocked, rooms)
// and one real tap on a phone (no capture API).
import { test } from "vitest";
import assert from "node:assert/strict";
import { describeShareError, shareRefusal, SHARE_MESSAGES } from "../src/media/shareErrors.ts";
import { t } from "../src/i18n.ts";

const dom = (name: string, message: string) => new DOMException(message, name);

test("the system blocking screen capture is explained", () => {
  assert.match(describeShareError(dom("NotAllowedError", "Permission denied by system")), /blocked screen sharing/);
});

test("cancelling the picker shows nothing at all", () => {
  assert.equal(describeShareError(dom("NotAllowedError", "Permission denied")), "");
});

test("a capture that cannot start gets a screen-specific message, never one about the camera", () => {
  const busy = describeShareError(dom("NotReadableError", "Could not start video source"));
  assert.match(busy, /screen/i);
  assert.doesNotMatch(busy, /camera/i);
});

test("a policy or a sandbox that forbids capture, and an engine without it, say so", () => {
  assert.equal(describeShareError(dom("NotAllowedError", "Access to the feature \"display-capture\" is disallowed by permissions policy")), t("share.blocked"));
  assert.equal(describeShareError(dom("SecurityError", "")), t("share.blocked"));
  assert.equal(describeShareError(dom("NotSupportedError", "")), t("share.unsupported"));
  assert.equal(describeShareError(null), t("share.couldNotStart"));
});

test("outside a call, Share screen says to walk up to someone", () => {
  const k = shareRefusal({ canShare: true, live: false });
  assert.equal(k, "share.needCall");
  assert.match(t(k), /Walk up to someone/);
});

test("a browser without screen capture says so, in a call or not", () => {
  for (const live of [false, true]) {
    const k = shareRefusal({ canShare: false, live });
    assert.equal(k, "share.unsupported");
    assert.match(t(k), /cannot share a screen/);
  }
});

test("in a call with screen capture, the share starts", () => {
  assert.equal(shareRefusal({ canShare: true, live: true }), null);
});

test("every message a share can show is one a new attempt clears", () => {
  const shown = [t("share.needCall"), t("share.unsupported"), ...["NotAllowedError:system", "NotAllowedError:policy", "SecurityError:", "NotReadableError:"]
    .map((s) => describeShareError(dom(s.split(":")[0], s.split(":")[1])))];
  for (const m of shown) assert.ok(SHARE_MESSAGES.some((k) => t(k) === m), m);
});
