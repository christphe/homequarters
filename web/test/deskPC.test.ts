// A pc on a desk: where the editor puts it (the server's gamemap.PCOn) and what erasing a desk takes.
// Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { eraseAt, pcOn } from "../src/game/props.ts";
import type { Prop } from "../src/net/protocol.ts";

test("pcOn centres a pc on a desk, the half tile left over as dx", () => {
  assert.deepEqual(pcOn({ t: "desk", x: 4, y: 7 }), { t: "pc", x: 4, y: 7, dx: 8 });
  assert.deepEqual(pcOn({ t: "desk", x: 4, y: 7, w: 3, h: 1 }), { t: "pc", x: 5, y: 7 });
  assert.deepEqual(pcOn({ t: "desk", x: 0, y: 1, w: 4, h: 1 }), { t: "pc", x: 1, y: 1, dx: 8 });
  assert.deepEqual(pcOn({ t: "desk", x: 4, y: 7, up: true }), { t: "pc", x: 4, y: 7, dx: 8 });
});

test("eraseAt on a desk takes its pcs first, then the desk", () => {
  const desk: Prop = { t: "desk", x: 2, y: 2 };
  const chair: Prop = { t: "chair", x: 2, y: 3 };
  const props: Prop[] = [desk, chair, { t: "pc", x: 2, y: 2, dx: 8 }];
  assert.equal(eraseAt(props, 3, 2), true); // the desk's pc, though it stands on the other tile
  assert.deepEqual(props, [desk, chair]);
  props.push({ t: "pc", x: 3, y: 2 });
  props.splice(1, 0, { t: "pc", x: 2, y: 2 });
  assert.equal(eraseAt(props, 2, 3), true); // the chair: nothing else goes
  assert.equal(props.length, 3);
  assert.equal(eraseAt(props, 2, 2), true); // the desk's last pc
  assert.equal(eraseAt(props, 2, 2), true); // then its other one
  assert.deepEqual(props, [desk]);
  assert.equal(eraseAt(props, 3, 2), true); // then the desk
  assert.deepEqual(props, []);
  assert.equal(eraseAt(props, 3, 2), false);
});
