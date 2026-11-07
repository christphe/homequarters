// hq-cards: which controls the table offers (public/controls.ts), checked here instead of in the browser.
// Run: node --test plugins/bundled/hq-cards/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { pileActions, seatButtons, seatPick, tableActions } from "../public/controls.ts";
import { FREE, clientGame } from "../public/games.ts";

const ANN = { id: 1, name: "Ann" }, BO = { id: 2, name: "Bo" };

test("seatButtons: a seated player cannot take another seat; taken seats name who, and who is away", () => {
  const t = { seats: [ANN, null, BO, null] };
  assert.deepEqual(seatButtons(t, 1, [1]), [
    { label: "Seat 1: Ann", seat: 0, disabled: true, pressed: true },
    { label: "Seat 2", seat: 1, disabled: true, pressed: false },
    { label: "Seat 3: Bo (away)", seat: 2, disabled: true, pressed: false },
    { label: "Seat 4", seat: 3, disabled: true, pressed: false },
  ]);
  // somebody without a seat may take any free one
  assert.deepEqual(seatButtons(t, 9, [1, 2]).map((b) => [b.label, b.disabled, b.pressed]), [
    ["Seat 1: Ann", true, false], ["Seat 2", false, false], ["Seat 3: Bo", true, false], ["Seat 4", false, false],
  ]);
});

test("tableActions: the free table offers everything; without a stock, nothing that needs one", () => {
  const free = clientGame(FREE);
  assert.deepEqual(tableActions(free, true), ["shuffle", "dealAll", "gather", "count", "deal", "createPile", "remove", "offer"]);
  assert.deepEqual(tableActions(free, false), ["gather", "count", "createPile", "remove", "offer"]);
  // a smaller deck is only offered for the standard deck
  assert.ok(!tableActions({ ...free, deck: { plugin: "x" } }, true).includes("remove"));
});

test("pileActions: what a selected pile offers on the free table, the stock never removable, an empty pile little", () => {
  const free = clientGame(FREE);
  const labels = (p: { name: string; cards: number[] }, stock: boolean) => pileActions(free, p, stock).map((a) => a.label);
  assert.deepEqual(labels({ name: "Stock", cards: [1, 2] }, true), ["Draw from Stock", "Look through Stock", "Shuffle Stock", "Turn the top over", "Turn the pile over", "Set the top aside"]);
  assert.deepEqual(labels({ name: "Discard", cards: [1] }, false), ["Draw from Discard", "Look through Discard", "Turn the top over", "Turn the pile over", "Set the top aside", "Remove the pile Discard"]);
  assert.deepEqual(labels({ name: "Discard", cards: [] }, false), ["Remove the pile Discard"]);
  assert.deepEqual(labels({ name: "A pile with a long name", cards: [1] }, false)[0], "Draw from A pile with…");
});

test("seatPick: only the player a hand is offered to may draw from it", () => {
  const offer = { from: 0, to: 1 };
  assert.equal(seatPick(offer, 0, 1, "Ann"), "Draw a card from Ann");
  assert.equal(seatPick(offer, 0, 2, "Ann"), null, "seated, not offered");
  assert.equal(seatPick(offer, 0, null, "Ann"), null, "a spectator");
  assert.equal(seatPick(offer, 2, 1, "Cy"), null, "another seat");
  assert.equal(seatPick(null, 0, 1, "Ann"), null, "no offer");
});
