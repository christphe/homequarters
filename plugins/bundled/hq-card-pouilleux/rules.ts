// Old Maid (French rules, "le pouilleux") for the Cards table: its definition and its count. Pure, no hq.
// The deck is the standard one without the jacks of clubs, diamonds and hearts and without the jokers: 49
// cards, the jack of spades left alone is the old maid. Players deal everything, discard their pairs on
// Pairs themselves and draw from each other's hands by offer; nothing is checked. Whoever keeps the jack of
// spades loses, which the count says.
//
// A game cannot import hq-cards's files (a plugin's imports stay in its folder), so the few types it needs
// are declared here, in hq-cards's shape (plugins/bundled/hq-cards/public/games.ts).

type Action = "place" | "offer" | "dealAll" | "deal" | "shuffle" | "gather" | "count" | "createPile" | "viewPile" | "draw";
interface StartPile { name: string; face: "up" | "down"; at: [number, number] }
export interface Definition {
  title: string;
  seats: [number, number];
  allow: Action[];
  deck: { standard: string[] };
  piles: StartPile[];
  count: boolean;
}
/** What hq-cards's count hook gets: seat names (null: empty seat), hands indexed like seats, card numbers. */
export interface CountArgs {
  seats: (string | null)[];
  hands: number[][];
  piles: { name: string; cards: number[] }[];
  loose: number[];
}

const OUT = ["JC", "JD", "JH"];
/** hq-cards's code format (rank A23456789TJQK, suit SHDC) and its order, without three jacks: 49 codes. */
export const CODES: string[] = [..."SHDC"].flatMap((s) => [..."A23456789TJQK"].map((r) => r + s)).filter((c) => !OUT.includes(c));
const OLD_MAID = CODES.indexOf("JS");

export const DEFINITION: Definition = {
  title: "Old Maid",
  seats: [2, 6],
  allow: ["place", "offer", "dealAll", "shuffle", "gather", "count"],
  deck: { standard: CODES },
  piles: [
    { name: "Stock", face: "down", at: [130, 90] },
    { name: "Pairs", face: "up", at: [190, 90] },
  ],
  count: true,
};

/** The cards left in the seated players' hands, or who keeps the jack of spades once it is the last one. */
export function count(a: CountArgs): string {
  const held: { name: string; hand: number[] }[] = [];
  a.seats.forEach((name, i) => {
    if (name !== null) held.push({ name, hand: a.hands[i] ?? [] });
  });
  const total = held.reduce((n, h) => n + h.hand.length, 0);
  if (total === 0) return "No cards in hand";
  const last = held.find((h) => h.hand.length);
  if (total === 1 && last && last.hand[0] === OLD_MAID) return `${last.name} keeps the jack of spades`;
  return `${total} ${total === 1 ? "card" : "cards"} left: ${held.map((h) => `${h.name} ${h.hand.length}`).join(", ")}`;
}
