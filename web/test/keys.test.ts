// Shortcuts by physical key position, labelled with the user's layout. Run: node --test web/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOVE_KEYS, codeOf, digitOf, keyLabel, learnKey, letterLabel, letterOf, moveLabels, setKeyLayout } from "../src/keys.ts";

// What Chrome's navigator.keyboard.getLayoutMap() reports on a French AZERTY keyboard.
const AZERTY = new Map([["KeyW", "z"], ["KeyA", "q"], ["KeyS", "s"], ["KeyD", "d"], ["KeyZ", "w"], ["KeyM", ","], ["Semicolon", "m"], ["Digit1", "&"], ["KeyR", "r"]]);

test("movement follows key positions, not the characters they type", () => {
  assert.equal(MOVE_KEYS.KeyW, "u"); // labelled Z on AZERTY
  assert.equal(MOVE_KEYS.KeyA, "l"); // labelled Q on AZERTY
  assert.equal(MOVE_KEYS.KeyZ, undefined); // labelled W on AZERTY: not a movement key
});

test("the digit row and the keypad give 1-9 whatever the layout types there", () => {
  assert.equal(digitOf("Digit1", "&"), 1);
  assert.equal(digitOf("Numpad7", "7"), 7);
  assert.equal(digitOf("Numpad4", "ArrowLeft"), 0); // Num Lock off: an arrow, not a reaction
  assert.equal(digitOf("Digit0"), 0);
  assert.equal(digitOf("KeyQ"), 0);
});

test("help labels show what an AZERTY keyboard prints at each position", () => {
  setKeyLayout(AZERTY);
  assert.deepEqual(moveLabels(), ["Z", "Q", "S", "D"]);
  assert.equal(keyLabel("KeyZ"), "W");
  assert.equal(keyLabel("KeyM"), ",");
});

test("without the Keyboard API the labels are US QWERTY names", () => {
  setKeyLayout(null);
  assert.deepEqual(moveLabels(), ["W", "A", "S", "D"]);
  assert.equal(keyLabel("KeyM"), "M");
});

test("without the Keyboard API, labels are learned from the keys actually typed", () => {
  setKeyLayout(null);
  learnKey({ code: "KeyW", key: "z" });
  learnKey({ code: "KeyA", key: "q" });
  learnKey({ code: "KeyM", key: "?", shiftKey: true }); // shifted symbols say nothing about the key
  assert.deepEqual(moveLabels(), ["Z", "Q", "S", "D"]);
  assert.equal(keyLabel("KeyM"), "M");
  setKeyLayout(null);
});

test("events without a key position fall back to what they typed", () => {
  assert.equal(codeOf({ code: "", key: "w" }), "KeyW");
  assert.equal(codeOf({ code: "", key: "3" }), "Digit3");
  assert.equal(codeOf({ code: "", key: "ArrowUp" }), "ArrowUp");
  assert.equal(codeOf({ code: "KeyW", key: "z" }), "KeyW");
});

test("letter shortcuts keep their letter; a letter on a movement key moves to its QWERTY position", () => {
  setKeyLayout(AZERTY);
  assert.equal(letterOf({ code: "Semicolon", key: "m" }), "m"); // M is printed right of L on AZERTY
  assert.equal(letterOf({ code: "KeyM", key: "," }), "");
  assert.equal(letterOf({ code: "KeyM", key: "?" }), ""); // Shift+, types "?": the help, not the minimap
  assert.equal(letterOf({ code: "KeyW", key: "z" }), ""); // Z walks on AZERTY...
  assert.equal(letterOf({ code: "KeyZ", key: "w" }), "z"); // ...so the key printed W dances
  assert.equal(letterLabel("z"), "W");
  assert.equal(letterLabel("m"), "M");
  setKeyLayout(null);
  assert.equal(letterOf({ code: "KeyZ", key: "z" }), "z");
  assert.equal(letterOf({ code: "KeyZ", key: "w" }), ""); // layout unknown: W is just W
  assert.equal(letterLabel("z"), "Z");
});
