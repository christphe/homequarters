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
    { op: "follow", id: "a", player: 7, gap: 52, beside: 38 },
    { op: "follow", id: "a", sprite: "b", gap: 20 },
    { op: "tint", id: "a", colour: "#3fa7d6" },
    { op: "tint", id: "a", colour: null },
    { ...sprite, key: "g0", url: "shared/critter.png", from: "critters" },
    { op: "sprite", key: "drawn", image: new Blob([new Uint8Array(8)], { type: "image/png" }), frameW: 16, frameH: 16, anims: {} },
    { op: "label", id: "a", text: "Biscuit" },
    { op: "label", id: "a", text: null },
    { op: "label", id: "a", text: "Foxy", owner: 7 },
    { op: "walkTo", id: "a", x: 300, y: 200 },
    { op: "walkTo", id: "a", x: 300, y: 200, speed: 30 },
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
      { type: "color", label: "Colour", value: "#ff8800", change: "c6" },
      { type: "number", label: "Pets per member", value: 3, min: 0, max: 8, change: "c7" },
      { type: "field", label: "Name", value: "", maxLength: 24, placeholder: "No name", change: "c8" },
      { type: "sprite", sprite: { src: "pets.png", frame: [0, 80, 16, 20], scale: 3, tint: "#3fa7d6" }, alt: "Cat" },
      { type: "button", label: "Cat", click: "c9", sprite: { src: "pets.png", frame: [0, 0, 16, 20] } },
      { type: "sprite", sprite: { sheet: "drawn", frame: [0, 0, 16, 16], scale: 3 }, alt: "drawn" },
    ] },
    { op: "close" },
    { op: "send", d: { t: "sync" } },
  ];
  const got = parseBatch(all);
  assert.ok(Array.isArray(got), JSON.stringify(got));
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
    ["tint not a colour", [{ op: "tint", id: "a", colour: "red" }]],
    ["sprite outside public", [{ op: "modal", title: "t", content: [{ type: "sprite", sprite: { src: "../x.png", frame: [0, 0, 16, 16] }, alt: "a" }] }]],
    ["sprite cell too big", [{ op: "modal", title: "t", content: [{ type: "sprite", sprite: { src: "a.png", frame: [0, 0, 200, 16] }, alt: "a" }] }]],
    ["sprite scale too big", [{ op: "modal", title: "t", content: [{ type: "sprite", sprite: { src: "a.png", frame: [0, 0, 16, 16], scale: 9 }, alt: "a" }] }]],
    ["sprite without a frame", [{ op: "modal", title: "t", content: [{ type: "button", label: "b", sprite: { src: "a.png" } }] }]],
    ["another plugin outside shared", [{ ...sprite, url: "critter.png", from: "critters" }]],
    ["another plugin with a bad name", [{ ...sprite, url: "shared/c.png", from: "../x" }]],
    ["a sheet with a path and image data", [{ ...sprite, image: new Blob([]) }]],
    ["a sheet with neither", [{ op: "sprite", key: "k", frameW: 16, frameH: 16, anims: {} }]],
    ["image data that is a string", [{ op: "sprite", key: "k", image: "data:image/png;base64,AAAA", frameW: 16, frameH: 16, anims: {} }]],
    ["image data from another plugin", [{ op: "sprite", key: "k", image: new Blob([]), from: "critters", frameW: 16, frameH: 16, anims: {} }]],
    ["a preview with src and sheet", [{ op: "modal", title: "t", content: [{ type: "sprite", sprite: { src: "a.png", sheet: "k", frame: [0, 0, 16, 16] }, alt: "a" }] }]],
    ["label too long", [{ op: "label", id: "a", text: "x".repeat(25) }]],
    ["label with a line break", [{ op: "label", id: "a", text: "a\nb" }]],
    ["label not text", [{ op: "label", id: "a", text: 5 }]],
    ["label owner not a member id", [{ op: "label", id: "a", text: "x", owner: -1 }]],
    ["follow both a member and a sprite", [{ op: "follow", id: "a", player: 7, sprite: "b" }]],
    ["follow nobody", [{ op: "follow", id: "a" }]],
    ["follow itself", [{ op: "follow", id: "a", sprite: "a" }]],
    ["walkTo far away", [{ op: "walkTo", id: "a", x: 1e9, y: 0 }]],
    ["field value over its length", [{ op: "modal", title: "t", content: [{ type: "field", label: "n", value: "abcdef", maxLength: 3, change: "c1" }] }]],
    ["field length over 200", [{ op: "modal", title: "t", content: [{ type: "field", label: "n", value: "", maxLength: 201, change: "c1" }] }]],
    ["tint short hex", [{ op: "tint", id: "a", colour: "#fff" }]],
    ["follow beside too far", [{ op: "follow", id: "a", player: 7, beside: 500 }]],
    ["colour field with a bad value", [{ op: "modal", title: "t", content: [{ type: "color", label: "c", value: "blue", change: "c1" }] }]],
    ["colour field without a label", [{ op: "modal", title: "t", content: [{ type: "color", label: "", value: "#000000", change: "c1" }] }]],
    ["number outside its range", [{ op: "modal", title: "t", content: [{ type: "number", label: "n", value: 9, min: 0, max: 8, change: "c1" }] }]],
    ["number with min over max", [{ op: "modal", title: "t", content: [{ type: "number", label: "n", value: 1, min: 5, max: 2, change: "c1" }] }]],
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

test("a button may be disabled: shown, named, not pressable (hq-chess's taken seats)", () => {
  const ok = parseBatch([{ op: "modal", title: "t", content: [{ type: "button", label: "White: Ann (away)", click: "c1", disabled: true }] }]);
  assert.ok(Array.isArray(ok) && ok[0].op === "modal", JSON.stringify(ok));
  const b = ok[0].op === "modal" ? ok[0].content[0] : null;
  assert.ok(b?.type === "button" && b.disabled === true);
  assert.equal(typeof parseBatch([{ op: "modal", title: "t", content: [{ type: "button", label: "b", disabled: "yes" }] }]), "string");
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
  assert.ok(Array.isArray(ok) && ok[0].op === "slot" && ok[0].label === undefined, JSON.stringify(ok));
});

test("spawn without a position keeps an existing sprite where it is", () => {
  const ok = parseBatch([{ op: "spawn", id: "a", key: "k" }]);
  assert.ok(Array.isArray(ok) && ok[0].op === "spawn" && ok[0].x === undefined && ok[0].y === undefined);
  assert.equal(typeof parseBatch([{ op: "spawn", id: "a", key: "k", x: 3 }]), "string", "x without y");
});

test("a sheet asked for by metadata: another plugin draws it (hq.provideSheet)", () => {
  const ok = parseBatch([{ op: "provide" }, { op: "sprite", key: "g0", provided: { from: "drawer", metadata: { kind: 25, alt: false } }, anims: {} }]);
  assert.ok(Array.isArray(ok), JSON.stringify(ok));
  const s = (ok as { op: string; provided?: { from: string; metadata: unknown } }[])[1];
  assert.deepEqual(s.provided, { from: "drawer", metadata: { kind: 25, alt: false } });
  const bad = [
    { op: "sprite", key: "g0", provided: { from: "Drawer!", metadata: 1 } },
    { op: "sprite", key: "g0", provided: { from: "drawer" } },
    { op: "sprite", key: "g0", provided: { from: "drawer", metadata: "x".repeat(LIMITS.metadataBytes) } },
    { op: "sprite", key: "g0", url: "a.png", provided: { from: "drawer", metadata: 1 } },
  ];
  for (const c of bad) assert.equal(typeof parseBatch([c]), "string", JSON.stringify(c).slice(0, 80));
});
