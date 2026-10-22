// A saved microphone, camera or speaker that is not there now gives way to the default. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { isListed, isMissingDevice } from "../src/media/devices.ts";

const dev = (kind: MediaDeviceKind, deviceId: string) => ({ kind, deviceId });
const list = [dev("audioinput", "default"), dev("audioinput", "mic-a"), dev("videoinput", "cam-a"), dev("audiooutput", "default"), dev("audiooutput", "spk-a")];

test("a device the browser lists", () => {
  assert.equal(isListed(list, "audiooutput", "spk-a"), true);
  assert.equal(isListed(list, "audioinput", "mic-a"), true);
});

test("a device the browser does not list", () => {
  assert.equal(isListed(list, "audiooutput", "spk-gone"), false);
  assert.equal(isListed(list, "videoinput", "cam-gone"), false);
});

test("an id of another kind does not count", () => {
  assert.equal(isListed(list, "audioinput", "cam-a"), false);
});

test("ids hidden before any permission: cannot tell", () => {
  const hidden = [dev("audioinput", ""), dev("videoinput", ""), dev("audiooutput", "")];
  assert.equal(isListed(hidden, "audioinput", "mic-a"), null);
  assert.equal(isListed(hidden, "audiooutput", "spk-a"), null);
});

test("no device of that kind listed (a browser that lists no speaker): cannot tell", () => {
  assert.equal(isListed([dev("audioinput", "mic-a")], "audiooutput", "spk-a"), null);
  assert.equal(isListed([], "videoinput", "cam-a"), null);
});

test("the errors of a device that is not there", () => {
  assert.equal(isMissingDevice({ name: "NotFoundError" }), true);
  assert.equal(isMissingDevice({ name: "OverconstrainedError" }), true);
  assert.equal(isMissingDevice({ name: "NotAllowedError" }), false);
  assert.equal(isMissingDevice(undefined), false);
});
