// Last Card's rules as hq-cards needs them: the 108 cards (a card's number is its frame in
// public/shared/cards.png), the game's definition, and the count hook's text. Nothing else is automated:
// players say the colour after a Wild and "last card" out loud, and apply Skip, Reverse and Draw Two
// themselves. A game cannot import hq-cards's files (imports stay inside a plugin's folder), so the few
// types it needs are declared here. Types and pure functions only.

export type Action = "place" | "offer" | "dealAll" | "deal" | "shuffle" | "gather" | "count" | "createPile" | "viewPile" | "draw";

export interface GameDefinition {
  title: string;
  seats: [number, number];
  allow: Action[];
  deck: { sheet: string; cell: [number, number]; back: number; total: number; cards: { name: string }[] };
  piles: { name: string; face: "up" | "down"; at: [number, number] }[];
  count: boolean;
}

/** What hq-cards's count hook gets: seat names (null: empty seat), hands indexed like seats, card numbers. */
export interface CountArgs {
  seats: (string | null)[];
  hands: number[][];
  piles: { name: string; cards: number[] }[];
  loose: number[];
}

export const COLOURS = ["Red", "Yellow", "Green", "Blue"] as const;
export const ACTIONS = ["Skip", "Reverse", "Draw Two"] as const;

/** The deck, frame = index: per colour one 0, two each of 1 to 9 and of each action; then the wilds. */
export const CARDS: { name: string; value: number }[] = [
  ...COLOURS.flatMap((c) => [
    { name: `${c} 0`, value: 0 },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((d) => [0, 1].map(() => ({ name: `${c} ${d}`, value: d }))),
    ...ACTIONS.flatMap((a) => [0, 1].map(() => ({ name: `${c} ${a}`, value: 20 }))),
  ]),
  ...[0, 1, 2, 3].map(() => ({ name: "Wild", value: 50 })),
  ...[0, 1, 2, 3].map(() => ({ name: "Wild Draw Four", value: 50 })),
];

export const BACK = 108;
export const CELL: [number, number] = [20, 28];
export const SHEET = "shared/cards.png";

export const DEFINITION: GameDefinition = {
  title: "Last Card",
  seats: [2, 8],
  allow: ["place", "deal", "shuffle", "draw", "gather", "count"],
  deck: { sheet: SHEET, cell: CELL, back: BACK, total: CARDS.length, cards: CARDS.map((c) => ({ name: c.name })) },
  piles: [
    { name: "Draw", face: "down", at: [130, 90] },
    { name: "Discard", face: "up", at: [190, 90] },
  ],
  count: true,
};

/** The points left in each seated hand: "Ann 32, Bo 0, Cy 70". */
export function count(args: CountArgs): string {
  const seats = Array.isArray(args?.seats) ? args.seats : [];
  const hands = Array.isArray(args?.hands) ? args.hands : [];
  const out: string[] = [];
  seats.forEach((name, i) => {
    if (typeof name !== "string") return;
    const hand = Array.isArray(hands[i]) ? hands[i] : [];
    const points = hand.reduce((sum, n) => sum + (CARDS[n]?.value ?? 0), 0);
    out.push(`${name} ${points}`);
  });
  return out.length ? out.join(", ") : "Nobody is seated";
}
