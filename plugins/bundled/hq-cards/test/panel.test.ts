// @vitest-environment jsdom
// hq-cards's table controls (public/panel.ts) in a DOM: when somebody else's move rebuilds them, the buttons
// still there are the same elements, so the focus and a click being pressed stay on them, and a field keeps
// what the player typed. Run: node tools/fdash/cli.ts run test:unit --pkg hq-cards
import { test } from "vitest";
import assert from "node:assert/strict";
import { FREE, clientGame } from "../public/games.ts";
import type { Act, TableState } from "../public/messages.ts";
import { createPanel } from "../public/panel.ts";
import { newTable, type Seat } from "../public/table.ts";

const ANN: Seat = { id: 1, name: "Ann" }, BO: Seat = { id: 2, name: "Bo" };

function state(seats: (Seat | null)[]): TableState {
  const t = { ...newTable(), game: "free", seats, hands: seats.map(() => []) };
  t.piles = [{ id: "p0", name: "Stock", at: [100, 100], face: "down", cards: [1, 2, 3], mine: false }];
  return { t, here: seats.flatMap((s) => (s ? [s.id] : [])), looking: [], unavailable: false };
}

test("a rebuild keeps the focused button, the number typed, and the click lands with it", () => {
  const sent: Act[] = [];
  const panel = createPanel((m) => sent.push(m), () => [0, 0]);
  document.body.append(panel.root);
  const input = (s: TableState) => ({ st: s, game: clientGame(FREE), me: ANN.id, log: [], card: String });
  const buttons = () => [...panel.root.querySelectorAll("button")];
  const named = (label: string) => buttons().find((b) => b.textContent === label)!;

  panel.update(input(state([ANN, null])));
  const deal = named("Deal");
  const each = panel.root.querySelector<HTMLInputElement>("input[type=number]")!;
  assert.equal(each.value, "7");
  each.value = "5";
  each.dispatchEvent(new Event("input"));
  deal.focus();
  assert.equal(document.activeElement, deal);

  // Bo sits down: the seats change, the controls are rebuilt
  panel.update(input(state([ANN, BO])));
  assert.ok(buttons().some((b) => b.textContent === "Seat 2: Bo"), "the new seat holder is shown");
  assert.equal(named("Deal"), deal, "the Deal button is the same element");
  assert.ok(deal.isConnected);
  assert.equal(document.activeElement, deal, "the focus stayed on it");
  assert.equal(panel.root.querySelector<HTMLInputElement>("input[type=number]"), each);
  assert.equal(each.value, "5");

  deal.click();
  assert.deepEqual(sent, [{ t: "deal", pile: "p0", n: 5 }]);
  panel.root.remove();
});
