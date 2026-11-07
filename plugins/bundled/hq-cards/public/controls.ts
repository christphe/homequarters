// Which controls the Cards table offers, and in what state: the seat buttons and the table's actions in the
// panel (panel.ts), the buttons under the table for a selected pile or seat (view.ts). Pure, so the rules
// are unit-tested; the two files only attach what each button does.
import { allows, type Action } from "./games.ts";
import { labels } from "./labels.ts";
import type { Table } from "./table.ts";

export interface SeatButton { label: string; seat: number; disabled: boolean; pressed: boolean }

/** One button per seat: a taken one names who holds it (pressed when it is mine, never clickable); a free
 * one can be taken by somebody without a seat. */
export function seatButtons(t: Pick<Table, "seats">, me: number, here: readonly number[]): SeatButton[] {
  const seated = t.seats.some((s) => s?.id === me);
  return t.seats.map((seat, k) => seat
    ? { label: labels.seat(k, seat.name, !here.includes(seat.id)), seat: k, disabled: true, pressed: seat.id === me }
    : { label: labels.freeSeat(k), seat: k, disabled: seated, pressed: false });
}

/** The panel's table actions a seated player gets, in the panel's order. */
export type TableAction = "shuffle" | "dealAll" | "gather" | "count" | "deal" | "createPile" | "remove" | "offer";
export function tableActions(game: { allow?: Action[]; deck?: object }, hasStock: boolean): TableAction[] {
  const out: TableAction[] = [];
  if (hasStock && allows(game, "shuffle")) out.push("shuffle");
  if (hasStock && allows(game, "dealAll")) out.push("dealAll");
  if (allows(game, "gather")) out.push("gather");
  if (allows(game, "count")) out.push("count");
  if (hasStock && allows(game, "deal")) out.push("deal");
  if (allows(game, "createPile")) out.push("createPile");
  if (allows(game, "remove") && game.deck !== undefined && "standard" in game.deck) out.push("remove");
  if (allows(game, "offer")) out.push("offer");
  return out;
}

const short = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s);

export type PileAct = "draw" | "look" | "shuffle" | "flip" | "turn" | "aside" | "remove";
/** The buttons under the table for a selected pile. */
export function pileActions(game: { allow?: Action[] }, pile: { name: string; cards: readonly unknown[] }, isStock: boolean): { label: string; act: PileAct }[] {
  const n = pile.cards.length, name = short(pile.name, 12);
  const out: { label: string; act: PileAct }[] = [];
  if (allows(game, "draw") && n) out.push({ label: `Draw from ${name}`, act: "draw" });
  if (allows(game, "viewPile") && n) out.push({ label: `Look through ${name}`, act: "look" });
  if (allows(game, "shuffle") && n > 1) out.push({ label: `Shuffle ${name}`, act: "shuffle" });
  if (allows(game, "place") && n) out.push({ label: "Turn the top over", act: "flip" }, { label: "Turn the pile over", act: "turn" });
  if (allows(game, "remove") && n) out.push({ label: "Set the top aside", act: "aside" });
  // any pile but the stock: its cards go back to the stock
  if (allows(game, "createPile") && !isStock) out.push({ label: `Remove the pile ${name}`, act: "remove" });
  return out;
}

/** Whether I may draw a card from that seat's hand: only when its player offers it to me. Every way in (the
 * button, a click on the seat, Enter on it, the pick row) asks this. */
export function canPick(offer: Table["offer"], seat: number, mySeat: number | null): boolean {
  return mySeat !== null && offer?.from === seat && offer.to === mySeat;
}

/** The button under the table for a selected seat: drawing from that seat's hand, only when it is offered to me. */
export function seatPick(offer: Table["offer"], seat: number, mySeat: number | null, name: string): string | null {
  return canPick(offer, seat, mySeat) ? `Draw a card from ${short(name, 12)}` : null;
}
