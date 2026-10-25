# Writing a card game for the Cards table

`hq-cards` is the table: a card deck an administrator places on the map, the window X opens, the seats, the felt, the hands, the piles and the log. A card game is a small plugin of its own that tells the table what it plays with. It never checks moves: players play by the rules themselves, as at a real table, and the log shows everything they do. A game can only:

- **narrow** the table: offer some of its actions and not the others;
- **add** to it: its own deck (part of the standard 54 cards, or cards of its own), its starting piles, and its own way of counting.

The two bundled games are the examples to read: [`hq-card-pouilleux`](../../hq-card-pouilleux) (Old Maid, the standard deck) and [`hq-card-lastcard`](../../hq-card-lastcard) (Last Card, 108 cards of its own). Neither has browser code: a game needs only server code, and a `public/shared/` folder for its card pictures if it has its own cards.

## The definition

```ts
{
  title: "Old Maid",                 // 1-40 characters, shown in the list of games of a new table
  seats: [2, 6],                     // the fewest and most players, within 2-8
  allow: ["place", "offer", "dealAll", "shuffle", "gather", "count"], // leave it out to allow everything
  deck: { standard: ["AS", "2S", /* ... */] },                     // or a deck of your own (below)
  piles: [{ name: "Stock", face: "down", at: [130, 90] }, { name: "Pairs", face: "up", at: [190, 90] }],
  count: true,                       // hq-cards calls your "count" hook when somebody presses Count
}
```

| Field | Rules |
| --- | --- |
| `allow` | Among `place` (drop a card anywhere: felt, a pile, a player's hand; turn a card over), `offer` (offer your hand for a player to draw a card from), `dealAll`, `deal` (N cards each), `shuffle`, `gather` (every card back into the first pile), `count`, `createPile` (players make piles, and remove empty ones they made), `viewPile` (look through a pile and reorder it), `draw` (take a pile's top card into your hand), `remove` (set a card aside, out of the game until a reset). Moving stacks, cascades and piles by their handles comes with `place`. An action not allowed is not offered in the window, and the server ignores it. |
| `deck.standard` | 1-54 distinct codes: rank `A23456789TJQK` and suit `SHDC` (`"TH"` is the 10 of hearts), `"XR"` and `"XB"` the jokers. A card is then known by its index in your list. |
| Your own deck | `{ sheet: "shared/cards.png", cell: [20, 28], back: 108, total: 108, cards: [{ name: "Red 0" }, ...] }`: a PNG under your `public/shared/`, cut into `cell` frames (4-64 px) read left to right then top to bottom; card i is frame i unless it gives `frame`; `back` is the frame of the back; at most 128 cards, each with a name of 1-24 characters (the log and screen readers say it). The names must fit a page's message: about 3.8 KB for the game, names and frames together. |
| `piles` | At most 16, the first one is the stock: the shuffled deck starts there, face down, and `dealAll`, `deal` and Shuffle in the window use it. Names are 1-16 characters, `at` is the centre of the pile on the felt, which is 320 x 220. Without piles, the table makes one "Stock" in the middle. |

## Registering

`hq-cards` keeps the games in memory, so a game registers whenever the two of them run. Calls between plugins are refused in `load()`, and `onPlugins()` runs only when *another* plugin starts or stops, so:

```ts
let started = false;
export function update(): void {
  if (started) return;
  started = true;
  if (hq.plugins.running("hq-cards")) register();
}
export function onPlugins(): void {
  if (hq.plugins.running("hq-cards")) register(); // hq-cards (re)started: it forgot the games
}
function register(): void {
  hq.plugins.call("hq-cards", "register", DEFINITION).then((r) => { /* { ok: true } or { ok: false, err } */ }, () => {});
}
```

Registering the same definition again is harmless: the table sends nothing when nothing changed. Log a refusal once with `hq.log` (it says which rule the definition broke).

A definition is at most 4 KB, like every hook's arguments. A deck whose names do not fit is sent in parts: `register` with the first cards (and `total` the whole count), then `registerCards({ from, cards })` with the rest, `from` being the number of cards sent so far. The game is offered once its last card arrived; while a new definition arrives, the tables of the game keep the previous one.

When your plugin stops, `hq-cards` forgets your game: its tables say "This game is not available" and offer only Reset, and come back as they were when your plugin registers again.

## Counting

With `count: true`, expose a `count` hook in `load()`:

```ts
hq.expose("count", (caller, args) => {
  if (caller.plugin !== "hq-cards") throw new Error("count is for hq-cards");
  // args: { seats: (string | null)[], hands: number[][], piles: { name, cards: number[] }[], loose: number[] }
  return "Ann 32, Bo 0, Cy 70";      // at most 200 characters, shown to everybody at the table and logged
});
```

Seats and hands are in seat order, `null` for a free seat. Cards are indices in your deck. Keep the hook fast (a call has 50 ms); an answer that is not text, an error or no answer within 2 s shows "Count unavailable". Without `count: true`, Count shows the number of cards in each hand and pile.

## What players see, and honesty

Every browser at a table gets the whole table and hides what its member should not see: other hands, face-down cards, the inside of a pile. A determined player could read them in the browser's tools; the table does not try to stop that among colleagues. Instead, everything a player does is in the log, and a card one player saw alone (looking through a pile, drawing) is never named in it.

## Card pictures

Draw your cards in code (a tool like [`hq-card-lastcard/tools/sprite.mjs`](../../hq-card-lastcard/tools/sprite.mjs) writes the PNG) and keep them original: no artwork, layout or name of a commercial card game (Home Quarters' AGENTS.md, invariant 10). The table draws every card in a 20 x 28 px box (times the view's scale): a `cell` of another shape is stretched to it, so draw at 20 x 28.
