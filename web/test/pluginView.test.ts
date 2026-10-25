// Plugin views: the view element of a modal and the messages between a view and its plugin's client code.
// Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBatch, checkViewMessage, ViewRate, LIMITS, type Cmd } from "../src/plugins/commands.ts";

const view = (o: Record<string, unknown> = {}) => ({ type: "view", view: "echo", label: "Echo view", height: "medium", message: "c1", ...o });
const modal = (content: unknown[]) => [{ op: "modal", title: "Demo", content }];

test("a modal with one view node of a declared shape is accepted", () => {
  const cmds = parseBatch(modal([{ type: "text", text: "Hi" }, view()]));
  assert.ok(Array.isArray(cmds), String(cmds));
  const m = (cmds as Cmd[])[0] as Extract<Cmd, { op: "modal" }>;
  assert.deepEqual(m.content[1], { type: "view", view: "echo", label: "Echo view", height: "medium", message: "c1" });
});

test("a view without a height is medium, and without onMessage has no callback", () => {
  const cmds = parseBatch(modal([view({ height: undefined, message: undefined })])) as Cmd[];
  assert.ok(Array.isArray(cmds), String(cmds));
  assert.deepEqual((cmds[0] as Extract<Cmd, { op: "modal" }>).content[0], { type: "view", view: "echo", label: "Echo view", height: "medium", message: undefined });
});

test("two views in one modal are refused, also when one is inside a row", () => {
  assert.equal(typeof parseBatch(modal([view(), view({ view: "other" })])), "string");
  assert.equal(typeof parseBatch(modal([view(), { type: "row", children: [view({ view: "other" })] }])), "string");
});

test("a view label of 41 characters is refused, 40 accepted", () => {
  assert.equal(typeof parseBatch(modal([view({ label: "x".repeat(41) })])), "string");
  assert.ok(Array.isArray(parseBatch(modal([view({ label: "x".repeat(40) })]))));
});

test("an unknown height is refused", () => {
  assert.equal(typeof parseBatch(modal([view({ height: "huge" })])), "string");
});

test("a view name that is not a manifest name is refused", () => {
  for (const name of ["", "Echo", "../x", "a".repeat(33), 3]) assert.equal(typeof parseBatch(modal([view({ view: name })])), "string", String(name));
});

test("a view goes in a modal, not in a box on the map", () => {
  assert.equal(typeof parseBatch([{ op: "slot", id: "b", anchor: "screen", corner: "top-left", content: [view()] }]), "string");
});

test("post carries any value; the page checks it when it relays it", () => {
  assert.deepEqual(parseBatch([{ op: "post", d: { t: "state" } }]), [{ op: "post", d: { t: "state" } }]);
});

test("checkViewMessage accepts a small JSON message", () => {
  assert.equal(checkViewMessage({ t: "move", from: 52, to: 36 }), null);
});

test("checkViewMessage refuses a 4097-byte message and accepts 4096 bytes", () => {
  assert.equal(checkViewMessage("x".repeat(4094)), null); // with its quotes: 4096 bytes
  assert.equal(typeof checkViewMessage("x".repeat(4095)), "string");
  assert.equal(typeof checkViewMessage("é".repeat(2048)), "string"); // 4098 bytes in UTF-8, 2050 characters
});

test("checkViewMessage refuses what is not JSON: a function, undefined, a cycle", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(typeof checkViewMessage(() => 1), "string");
  assert.equal(typeof checkViewMessage(undefined), "string");
  assert.equal(typeof checkViewMessage(cycle), "string");
});

test("ViewRate lets 30 messages through in a second and drops the rest until the window moves", () => {
  const r = new ViewRate();
  let ok = 0;
  for (let i = 0; i < 100; i++) if (r.allow(1000 + i * 10)) ok++; // 100 in one second
  assert.equal(ok, LIMITS.viewRate);
  assert.equal(r.allow(2005), true); // the first ones are more than a second old
});
