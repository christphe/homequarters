// Validation of the command batches a plugin's iframe sends to the page. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBatch, LIMITS, SendBudget, framesFit } from "../src/plugins/commands.ts";

const sprite = { op: "sprite", key: "pet", url: "creatures.png", frameW: 16, frameH: 16, anims: { "walk-down": { row: 0, frames: [1, 0, 2, 0], fps: 8 } } };

test("accepts every command", () => {
  const all = [
    sprite,
    { op: "spawn", id: "a", key: "pet", x: 10, y: 20, anim: "idle" },
    { op: "spawn", id: "b", key: "pet", x: 1.5, y: 2 },
    { op: "moveTo", id: "a", x: 30, y: 40, speed: 60 },
    { op: "follow", id: "a", player: 7, gap: 36 },
    { op: "stop", id: "a" },
    { op: "anim", id: "a", name: "sleep" },
    { op: "flip", id: "a", on: true },
    { op: "visible", id: "a", on: false },
    { op: "remove", id: "b" },
    { op: "slot", id: "cfg", anchor: "sidebar", label: "Sample pet", click: "c1" },
    { op: "slot", id: "call", anchor: "topbar", label: "Call", icon: "icons/call.png", click: "c2", pressed: true },
    { op: "slot", id: "w", anchor: "screen", corner: "bottom-left", dx: 8, dy: 8, content: [{ type: "text", text: "Your seedling: meadow" }] },
    { op: "unslot", id: "w" },
    { op: "modal", title: "Sample pet", size: "small", place: "center", close: "c3", content: [
      { type: "text", text: "Colour", muted: true },
      { type: "row", children: [{ type: "button", label: "Meadow", click: "c4", pressed: true }, { type: "button", label: "Frost", click: "c5" }] },
      { type: "copy", label: "Token", value: "abc" },
      { type: "image", src: "creatures.png", alt: "seedling" },
      { type: "appToken" },
    ] },
    { op: "close" },
    { op: "send", d: { t: "sync" } },
  ];
  const got = parseBatch(all);
  assert.ok(Array.isArray(got), String(got));
  assert.equal(got.length, all.length);
});

test("refuses batches the host must not run", () => {
  const bad: [string, unknown][] = [
    ["not an array", { op: "stop", id: "a" }],
    ["too many", Array.from({ length: LIMITS.batch + 1 }, () => ({ op: "stop", id: "a" }))],
    ["NaN position", [{ op: "spawn", id: "a", key: "k", x: NaN, y: 0 }]],
    ["infinite position", [{ op: "moveTo", id: "a", x: Infinity, y: 0 }]],
    ["long label", [{ op: "slot", id: "b", anchor: "topbar", label: "x".repeat(41) }]],
    ["empty label", [{ op: "slot", id: "b", anchor: "topbar", label: "" }]],
    ["unknown anchor", [{ op: "slot", id: "b", anchor: "header", label: "x" }]],
    ["screen without content", [{ op: "slot", id: "b", anchor: "screen", corner: "top-left" }]],
    ["bad corner", [{ op: "slot", id: "b", anchor: "screen", corner: "middle", content: [] }]],
    ["unknown component", [{ op: "modal", title: "t", content: [{ type: "iframe", src: "x" }] }]],
    ["too deep", [{ op: "modal", title: "t", content: [{ type: "row", children: [{ type: "row", children: [{ type: "row", children: [{ type: "row", children: [{ type: "row", children: [] }] }] }] }] }] }]],
    ["too many nodes", [{ op: "modal", title: "t", content: Array.from({ length: 65 }, () => ({ type: "text", text: "x" })) }]],
    ["long text", [{ op: "modal", title: "t", content: [{ type: "text", text: "x".repeat(501) }] }]],
    ["bad size", [{ op: "modal", title: "t", size: "huge", content: [] }]],
    ["image url outside public", [{ op: "modal", title: "t", content: [{ type: "image", src: "../x.png", alt: "a" }] }]],
    ["button without label", [{ op: "modal", title: "t", content: [{ type: "button", label: " ", click: "c1" }] }]],
    ["parent folder", [{ ...sprite, url: "../x.png" }]],
    ["absolute url", [{ ...sprite, url: "https://example.com/x.png" }]],
    ["rooted url", [{ ...sprite, url: "/plugins/other/assets/x.png" }]],
    ["not a png", [{ ...sprite, url: "x.svg" }]],
    ["huge frame", [{ ...sprite, frameW: 4096 }]],
    ["bad anim frames", [{ ...sprite, anims: { a: { row: 0, frames: [-1], fps: 8 } } }]],
    ["unknown op", [{ op: "eval", code: "x" }]],
    ["long id", [{ op: "stop", id: "i".repeat(65) }]],
    ["missing id", [{ op: "remove" }]],
    ["bad player", [{ op: "follow", id: "a", player: -3 }]],
    ["flip not boolean", [{ op: "flip", id: "a", on: "yes" }]],
  ];
  for (const [why, b] of bad) assert.equal(typeof parseBatch(b), "string", why);
});

test("the page never sends plugin messages faster than the server accepts them", () => {
  const b = new SendBudget();
  let sent = 0;
  for (let i = 0; i < 300; i++) if (b.allow(1000)) sent++;
  assert.equal(sent, LIMITS.sendBurst, "a burst is capped");
  // then the rate: over 10 s at 100 tries a second, at most sendRate a second get through
  let later = 0;
  for (let t = 0; t < 10_000; t += 10) if (b.allow(1000 + t)) later++;
  assert.ok(later <= LIMITS.sendRate * 10 + 1 && later >= LIMITS.sendRate * 10 - 1, String(later));
  assert.ok(LIMITS.sendRate < 10 && LIMITS.sendBurst < 20, "below the server's 10/s, burst 20");
});

test("a blank button label is refused (it would have no accessible name)", () => {
  assert.equal(typeof parseBatch([{ op: "slot", id: "b", anchor: "topbar", label: "   " }]), "string");
  const ok = parseBatch([{ op: "slot", id: "b", anchor: "topbar", label: "  Go  " }]);
  assert.ok(Array.isArray(ok) && ok[0].op === "slot" && ok[0].label === "Go");
});

test("screen offsets are clamped", () => {
  const ok = parseBatch([{ op: "slot", id: "w", anchor: "screen", corner: "top-right", dx: 5000, dy: -3, content: [] }]);
  assert.ok(Array.isArray(ok) && ok[0].op === "slot" && ok[0].dx === 200 && ok[0].dy === 0);
});

test("a sheet cut into too many frames is refused", () => {
  assert.equal(framesFit(48, 256, 16, 16), true);
  assert.equal(framesFit(2048, 2048, 1, 1), false);
  assert.equal(framesFit(2048, 2048, 32, 32), true);
});

test("a slot without a label is named after its plugin (the side panel entry)", () => {
  const ok = parseBatch([{ op: "slot", id: "config", anchor: "sidebar", click: "c1" }]);
  assert.ok(Array.isArray(ok) && ok[0].op === "slot" && ok[0].label === undefined, String(ok));
});

test("spawn without a position keeps an existing sprite where it is", () => {
  const ok = parseBatch([{ op: "spawn", id: "a", key: "k" }]);
  assert.ok(Array.isArray(ok) && ok[0].op === "spawn" && ok[0].x === undefined && ok[0].y === undefined);
  assert.equal(typeof parseBatch([{ op: "spawn", id: "a", key: "k", x: 3 }]), "string", "x without y");
});
