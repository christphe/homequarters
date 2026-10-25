# A card table plugin and Old Maid: design

Date: 2026-10-25. Status: approved by the user. Pull request #38 (changelog entries carry `(#38)`). Builds on [plugin objects, views and chess](2026-10-25-plugin-objects-chess-design.md) (#36, merged; ADR 0030).

## Intent

A member walks up to a card deck lying on a table, presses X, picks a game (or a free table), sits down with colleagues and plays cards while others watch, as around a real table: cards are dealt, held, dropped anywhere on the felt, gathered in piles, drawn from a neighbour's hand. Everything anybody does is written in the table's log, so looking at the discard pile is as visible as it is at a real table.

The table is a bundled plugin, `hq-cards`. Each game with rules of its own (Old Maid and Last Card in this change) is a **separate plugin** that registers with it through the existing hooks between plugins (`hq.expose`, `hq.plugins.call`). A game only *narrows* the table (which actions are offered) and *adds* to it (its deck, its starting piles, its way of counting); it never checks moves. `hq-card-pouilleux` (Old Maid, French rules) proves the registration path with the standard deck; `hq-card-lastcard` (a shedding game with its own 108 cards) proves custom decks.

Why: the office needs small social games beyond chess, and card games are the family where one table can host many games. Doing the table once keeps each game small.

## Goals

- `hq-cards`: a `deck` map object; X opens the Cards window on that object's table. One table, one game per placed deck, like one game per chessboard.
- Choosing the game: a table with no game shows the registered games that are running, plus **Free table**. Choosing one starts it.
- Seats and spectators as in chess: a seat is kept until a reset, present = the table's window is open, same reset rule.
- A felt seen from above (layout A of the brainstorm): other players around it (name and card backs), piles and loose cards on it, my hand in a strip below it, the game's text (whose turn, the count) above it, a log beside or below it.
- Free placement: a card goes anywhere on the felt, face up or face down, not only on a pile.
- Actions: place, offer my hand, deal all, deal N, shuffle, gather all, count, create a pile, look at a pile (and reorder it), draw from a pile.
- Every action is logged with who did it, visibly to everybody at the table.
- Games: a plugin registers its deck (or a subset of the standard one), its allowed actions, its starting piles, its seat range, and optionally its own count.
- Custom cards: a game's cards are drawn from its `public/shared/` PNG; the standard deck is drawn in code.
- `hq-card-pouilleux`: Old Maid with the French deck rule, registered with `hq-cards`.
- `hq-card-lastcard`: Last Card, a shedding game with its own original cards, registered with `hq-cards`.

## Non-goals (this change)

- Checking moves: no turn order, no legal-card check, no refusal of a move. Players police each other. *(User: "on commence par un truc libre".)* A game's only filter is the list of actions it offers.
- Hiding information from a determined player: the whole table state goes to every browser at the table and the client hides what a member should not see (other hands, face-down cards, pile contents). *(User: "c'est le client qui peut filtrer, on n'a pas besoin d'un truc anti-triches".)* The log is the honesty mechanism.
- Belote/coinche, teams, scores kept across games, a game's own view replacing the table view.
- Badges over the heads of players (chess has one; not needed here).
- Cleaning up tables of decks removed from the map.

## Anti-goals (a failure even if it works)

- A look at a pile, a draw, a pile reorder or any other table action that does not appear in the log. Rearranging one's own hand is not logged *(builder's call: at a real table it is a gesture, not a move, and logging it would flood the log)*; it is one message on drop and the server keeps the order, which an offer uses.
- Any per-frame message: a drag sends one message, on drop.
- A game plugin able to change a table it does not own, or a member able to act at a table whose window they do not have open.
- A table losing its game on server restart or when `hq-cards` or the game plugin is turned off and on.
- Third-party card art: the standard deck and the deck object are original pixel art drawn in code (AGENTS.md invariant 10); suit symbols are drawn, not taken from a font with an incompatible licence.
- A window that only works with a mouse: the view needs a keyboard path, as the chessboard has.

## Decisions taken with the user

- **Approach A: `hq-cards` is the table.** It owns the object, the game choice, seats, state, view, modal and log. Games plug in through hooks. (B, "hq-cards only offers functions and each game draws its own window", was rejected.)
- **One game per placed deck**, like the chessboard.
- **Free table first; rules only narrow or add.** A game declares the actions it allows from a fixed list: place freely, offer my hand, deal all, deal N, shuffle, gather all, count, create a pile, look at a pile, draw from a pile. Example given by the user: belote/coinche would start with a pile in the middle, and *count* would apply coinche scoring.
- **Free placement anywhere on the felt**, so any game can be played on the free table.
- **Anybody can create a pile on a free table.** *(Builder's reading, told to the user: anybody seated; spectators only watch, as in chess.)*
- **Everything is logged**, like at a real table: looking at the discard or the stock is visible to all. **Look at a pile** shows its cards to the one who looks, who may reorder them and put them back; **draw from a pile** takes its top card into the hand.
- **The client filters hidden information**; no anti-cheat.
- **Custom cards with their own sprites and metadata**, ids used everywhere else so the state stays small.
- **Old Maid (`hq-card-pouilleux`) validates the whole thing**, and **Last Card (`hq-card-lastcard`), a game in the family of the trademarked one, ships in the same change** with its own art. Its Wild colour and "last card" are said out loud.

## Constraints from the codebase

- Hooks between plugins are server-side only: `hq.expose(name, fn)` in `load()`, `await hq.plugins.call(plugin, name, args)`; arguments and answers are JSON of at most 4 KB; a call fails if the plugin is off, throws or takes over 2 s; 16 hooks per plugin, 64 calls waiting; `caller.plugin` is set by Home Quarters; `onPlugins()` and `hq.plugins.running(name)` follow plugins starting and stopping.
- A plugin imports only files inside its own folder: there is no shared code library between plugins, only hooks and `public/shared/` images.
- `hq.kv`: values at most 4 KB, 1000 keys per plugin. `hq.send` from the server: 4 KB per message, 10 a second per member for all plugins together. Page to server: 1500 bytes per message, 8 a second for all plugins. View messages: 4096 bytes, 30 a second.
- One plugin modal at a time per page: a game plugin opening its own modal would close the Cards window, so everything shown at a table goes through `hq-cards`.
- A view's Content Security Policy (`policy()` in `web/src/plugins/host.ts`) lets it load images from its own plugin folder and declared external hosts only. It cannot load another plugin's `shared/` images today.
- Interface elements of a modal: at most 64, labels 1 to 40 characters, text 500 characters; labels are plain text, not translated.
- Plugin calls take at most 50 ms; the plugin stops past that.

## Approaches

| | A. `hq-cards` is the table *(chosen)* | B. `hq-cards` offers functions, each game draws its window | C. A code library copied into each game |
| --- | --- | --- | --- |
| How | `hq-cards` owns object, choice, seats, state, view, modal, log; games register a definition and optional hooks | `hq-cards` keeps deck, hands and piles behind hooks; each game has its own modal and view, opened from the deck | Each game is a full plugin like chess, with a copy of a cards kit |
| For | One view and one UX for all games; games are small; the deck that picks the game comes naturally | Total freedom per game, including its view | No new API, no calls between plugins |
| Against | `hq-cards` must foresee what games need (choices, counts); custom art needs a CSP change | Two plugins share a game: presence, change notifications, each game redraws cards; many moving parts | No shared deck to pick a game from; imports cannot leave a plugin folder, so each game ships its own copy and they drift |

The user picked A. A later version may let a game supply its own view inside the Cards window if one needs a very different display.

## Design

### 1. The table object and the window

- Manifest: `"objects": [{ "kind": "deck", "label": "Card deck", "size": [1, 1], "sprite": "deck.png" }]`, `"views": { "table": "table.ts" }`. The deck stands on furniture like the chessboard.
- `onUse` opens the Cards window on table `x,y`. Interface elements above the view, as in chess: the seat buttons, a line saying who holds each seat (here or away), Reset, and the buttons of the game-level actions it allows (Shuffle, Deal all, Deal…, Gather all, Count, New pile…). The game's status text goes in a text line. The felt, the hands and the log are in the view.
- **No game chosen** (a new table, or after a reset): the window shows a list of buttons, one per registered running game (its title) plus **Free table**. Anybody with the window open may choose. Choosing applies the game's setup (its deck as the stock, face down; its starting piles) and frees all seats.
- **Seats:** the game's `seats: [min, max]` (free table: 2 to 8). A seat is kept until a reset; a seated player cannot leave it otherwise. Taking a seat is allowed at any time (a late player starts with an empty hand). Presence and the reset rule are chess's: a present seated player may always reset; anybody may when no seated player is present. Reset returns to the game choice.

### 2. State

One table per placed deck, saved in `hq.kv` under `table:<x>,<y>`, loaded on first use, written on every change (as `board:<x>,<y>` in chess). In ids, so it fits 4 KB with room to spare: a card is a number (its index in the game's deck, at most 128 cards), a pile an id.

- `game`: the game's plugin name, `"free"`, or none.
- `seats`: seat number to `{ id, name }`.
- `hands`: seat to an ordered list of card numbers (the order is the holder's own: they may reorder their hand).
- `piles`: id (short, generated), `name` (1-16 characters), position on the felt, `face` (`up` or `down`), ordered cards (last is the top).
- `loose`: cards lying on the felt outside any pile: card, position, face.
- `offer`: at most one open offer, `{ from: seat, to: seat }`.

Positions are in felt units (a fixed logical size, the builder picks it), the same for everybody: the felt is not rotated per viewer. Estimate, not measured: 108 cards with positions and a dozen piles is about 1.5 KB of JSON.

The **log** is kept apart (`log:<x>,<y>`), the last entries that fit in 4 KB, oldest dropped first. An entry is `{ seat, action, what }` with card and pile ids, rendered in the view as a sentence ("Michel looked at Discard", "Vincent drew a card from Michel's hand", "Léa moved the 7 of clubs onto Pairs"). Entries name the cards that became visible to everyone (a card turned face up) and never the cards a member saw alone (a look at a pile logs the look and the reorder, not the cards). The log is reset with the table.

### 3. Actions

All actions are messages from a seated, present member of that table, checked for shape on the server, then applied, saved, logged and sent to the table's viewers (the full state, as chess). A game's `allow` list removes the others from the window and makes the server ignore them. With no list (the free table) all are allowed.

| Action | Effect |
| --- | --- |
| `place` | Moves one card from my hand, a loose spot, or the top of a pile to: a position on the felt (loose), a pile (on top), or a player's name (into their hand). A loose card may also go back into my hand. Carries the face it lands with; a double click or a key turns a loose card or a pile's top card over. One message on drop. Taking a pile's top card into my hand is `draw`, not `place`, so a game that leaves out `draw` really forbids it: the server checks where a `place` comes from and goes *(builder's call)*. |
| `offer` | Opens an offer of my hand to one seated player; that player picks one of my cards by its position in my hand and it moves to theirs; the offer closes. I can withdraw it. |
| `dealAll` | Deals the stock (the game's first pile, or a pile the dealer picks on the free table) face down, one at a time, round the seats in order, starting after the dealer, until it is empty. |
| `deal` | Same, N cards to each seat (1 to 52), stops early if the pile runs out. |
| `shuffle` | Shuffles one pile (server-side randomness). |
| `gather` | Puts every card (hands, loose, piles) back into the stock, face down, and removes the piles a player created. |
| `count` | Shows the count in the window and logs it: by default, the number of cards in each hand and pile; with a game's `count` hook, the text it returns. |
| `createPile` | Creates an empty pile with a name and a face at a position. A player may remove an empty pile they or anyone created *(builder's call)*. At most 16 piles. |
| `viewPile` | Shows me a pile's cards in order; I may reorder them and put them back (one message with the new order, which must be the same cards). Logged on open and on reorder. Others see "Michel is looking at Discard" while it is open. |
| `draw` | Takes the top card of a pile into my hand. |

### 4. Games: registration and hooks

A game is a plugin that calls `hq.plugins.call("hq-cards", "register", definition)` on its first `update()` (calls are refused in `load()`, and `onPlugins()` only fires for *other* plugins starting or stopping) and again in `onPlugins()` whenever `hq-cards` (re)starts. The developer guide says so. `hq-cards` keeps definitions in memory and drops a game's when `onPlugins()` says it stopped; `caller.plugin` names the game, so a game can only register or replace itself.

```ts
interface GameDefinition {
  title: string;                 // 1-40 characters, shown in the game list
  seats: [number, number];       // 2-8
  allow?: Action[];              // absent: everything
  deck: { standard: string[] }   // card codes of the standard deck, e.g. ["AS","2S",...,"KH","JK"]
      | { sheet: string; cell: [number, number]; back: number; cards: { frame: number; name: string }[] };
  piles?: { name: string; face: "up" | "down"; at: [number, number] }[]; // starting piles; the first is the stock
  count?: boolean;               // true: hq-cards calls the game's "count" hook
}
```

- `sheet` is a PNG under the game's `public/shared/`; `cell` its frame size; `frame` an index in it; `back` the frame of the card back. `name` (1-24 characters) is what the log and the screen reader say ("Red 7", "Skip"); a standard card's name comes from its code. A game's own data per card (its value for counting, a colour) stays in the game: `hq-cards` never stores it, and the count hook gets card numbers the game looks up itself *(builder's call: the user's "metadata" lives on the game's side)*.
- A definition over 4 KB (a big custom deck) is sent in parts: `register` with everything but the cards, then `registerCards(from, cards)` until done *(builder's call on the exact split)*.
- **Count hook:** the game exposes `count(caller, { seats, hands, piles, loose })` with card numbers and seat names; `hq-cards` calls it when somebody presses Count and shows the string it returns (at most 200 characters). A game checks `caller.plugin === "hq-cards"`. A call that fails or times out shows "Count unavailable".
- **A game turned off** during a game: its tables show "This game is not available" and allow only Reset; their state stays saved and comes back when the game registers again.

### 5. Plugin API change: views may draw other plugins' shared images

The view's policy gains, in `img-src`, the `shared/` folder of every plugin running when the view iframe is created (`/plugins/<name>/assets/shared/`). `public/shared/` is already the part of a plugin meant for other plugins (`hq.loadSprite(..., { from })`), so this extends that rule to views. A game that starts while a Cards window is open shows its art once the window is reopened. Recorded in a new ADR, in `docs/plugins.md` (Views) and `docs/plugin-api.md`.

### 6. The view

Layout A of the brainstorm: other seated players around the felt (name, "away" when not present, their card backs, "offers" when they offer me their hand), piles and loose cards on the felt, my hand fanned in a strip under the felt, the log as a scrolling list. Drag and drop, or click then click, as the chessboard. A pile being looked at opens as a row of its cards over the felt, reorderable, with Done. Keyboard: arrows move a cursor over hand, felt spots, piles and players; Enter picks up and drops; a live region announces changes and the latest log entries.

Cards are pixel art scaled by a whole number. The standard deck (52 cards and 2 jokers, one back) is drawn in code in `hq-cards`; custom decks come from the game's sheet.

### 7. `hq-card-pouilleux` (Old Maid, French rules)

- Title "Old Maid", seats 2 to 6.
- Deck: the 52 standard cards minus the jacks of clubs, diamonds and hearts; the jack of spades is the old maid.
- Starting piles: Stock (face down), Pairs (face up).
- Allowed: `place`, `offer`, `dealAll`, `shuffle`, `gather`, `count`.
- Count hook: while cards remain in more than one hand, "N cards left: Michel 3, Vincent 2, …"; when only the jack of spades remains in hands, "Vincent keeps the jack of spades".
- Players discard their pairs on Pairs themselves; nothing is checked.
- A short developer guide in the plugin (`docs/README.md`, like hq-pets) that a game author can copy: the definition, the hooks, the shared sheet.

### 8. `hq-card-lastcard` (Last Card, a shedding game in the family of Crazy Eights)

Part of this change *(user's decision)*. It is the first game with its own cards, so it proves custom decks end to end.

- Title "Last Card" *(builder's proposal, accepted unless the user renames it)*. Never "UNO" or anything close to it, in names, art or text: the name and the look of that game are trademarks; the mechanics are not.
- Seats 2 to 8 (the table's maximum).
- Deck: 108 cards in four colours (red, yellow, green, blue). Each colour has one 0, two each of 1 to 9, two Skip, two Reverse and two Draw Two. There are also four Wild and four Wild Draw Four. All are original pixel art in the game's `public/shared/` sheet, drawn in code (a generator like hq-chess's `tools/sprite.mjs`), with its own back. Do not copy the original's white tilted oval, its logo or its card layout.
- Starting piles: Draw (face down, the stock) and Discard (face up).
- Allowed: `place`, `deal` (players deal 7 themselves), `shuffle`, `draw`, `gather`, `count`.
- Count hook: the points left in each hand. Number cards count their face value, Skip, Reverse and Draw Two count 20, and both Wilds count 50 ("Michel 32, Vincent 0, …").
- Nothing else is automated. Players say the Wild's colour and "last card" out loud (proximity audio) and apply Skip, Reverse and Draw Two themselves *(user: "le choix de la couleur ou last card peut se faire à l'oral")*. No announce buttons.

## Round 2: after the user tried it (2026-10-25)

The user played the first version: on a computer screen the table is too small to read the cards; piles cannot be moved or deleted; a solitaire is impossible; cards cannot be taken out of the game. Decisions, the user's unless marked:

### 9. A full-screen plugin window (plugin API)

- `hq.ui.modal({ size: "full" })`: the window takes the screen, less a margin (the user: "on doit pouvoir faire un plein écran"). `hq.ui.view({ height: "full" })` fills the window's height left after the elements above it. Validated like the other sizes; documented in `docs/plugins.md`, `docs/plugin-api.md` and `plugins/sdk/client.d.ts`; recorded in ADR 0032 *(builder's call: one ADR for the whole change)*.
- The Cards window uses it, and holds only its title and the view: the seats, the table actions and the log move into the view, as HTML controls above and beside the canvas *(builder's call: the controls above the view took the height the table needs)*. Target: at 1280 x 720 the table is drawn at 2x or more; on a larger screen, larger (whole and half steps as now). On a phone the narrow layout stays.

### 10. Snapping, overlapping, cascades

- **Snapping is a setting of the table, the same for everybody** *(the user: "l'option de snapping c'est pour tout le monde")*: a switch in the view that any seated player can turn on or off, saved with the table and logged ("Ann turned snapping on"); on for a new game *(builder's call)*. Off, a card lands where it is dropped, as now.
- On, a dropped card lands on a **grid** of the felt *(builder's call: a step of 24 x 32 felt units, a card and a gap)*.
- **Cards may overlap.** Dropped on another loose card's upper half, it lands exactly on it (a stack); dropped on its **lower half**, it lands **13 felt units lower**, so the card under it shows its index (rank and suit) above it: a cascade, as the columns of a solitaire.
- The positions are computed by the dropping player's page from the table's setting; the server stores the setting and does not check positions (as now).

### 11. Moving groups of cards and piles

- A **stack or cascade** of loose cards (cards that overlap, in the order they were put down) has a **handle** above its bottom card: dragging the handle moves the whole group *(the user: "on peut déplacer des tas via un handle")*.
- Picking a card **in the middle of a cascade** takes it **and the cards put on it** (needed for a solitaire) *(builder's proposal, accepted with the playback)*.
- One action, `moveCards { cards, dx, dy }`: the cards must all be loose; they keep their order and go on top; logged as "Ann moved 4 cards" *(builder's call on the name and shape)*.
- **Piles have a handle too** (beside their name): `movePile { pile, at }`. **Any pile can be removed**, except the stock (the first pile); its cards go back to the stock face down *(the user asked to delete piles; where the cards go is the builder's proposal)*.

### 12. Taking cards out of the game

- At the start of a game, players set cards aside ("set the jokers aside"). `remove` takes one card (from my hand, the felt or a pile's top) **out of the game**: it goes to a set-aside list of the table, not shown, counted ("3 out of the game"), logged with its name *(builder's call: the card is named, as it is seen leaving)*.
- **They stay out through everything, Gather all included; only a Reset brings them back** (it starts the game again from a whole deck) *(the user: "ils ne sont pas récupérés quand on ramasse, uniquement au reset")*. There is no separate restore.
- `remove` is a new allowed action; games that list their actions (Old Maid, Last Card) do not offer it.

### Acceptance criteria of round 2

| # | Criterion | Seam |
| --- | --- | --- |
| R1 | A plugin window of size `full` with a `full` view fills the screen less its margin at 1280 x 720 and 800 x 450; a malformed size still stops the plugin as before | `pluginCommands` tests + browser scenario `plugins` |
| R2 | At 1280 x 720 the Cards table is drawn at 2x or more, with the seats, actions and log usable; the `a11y` scenario stays at zero violations | browser scenarios `cards` and `a11y` + frames looked at |
| R3 | Snapping on: a card dropped near a grid point lands on it; dropped on a card's lower half it lands 13 units lower, its index visible; on its upper half, exactly on it; snapping off: where dropped. A seated player turns it off: every page shows it off and the log says so | web unit tests of the snapping function + browser scenario `cards` |
| R4 | Dragging a cascade's handle moves all its cards by the same offset; picking a middle card of a cascade moves it and the cards above it; one message per drop | web unit tests + browser scenario `cards` |
| R5 | A pile moves by its handle; any pile but the stock can be removed and its cards go back to the stock | unit and Go tests + browser scenario `cards` |
| R6 | A card set aside leaves the table for everybody, is counted and logged; it stays out through every action, Gather all included; a Reset and a new game bring it back | unit and Go tests + browser scenario `cards` |
| R7 | A solitaire can be laid out and played on the free table by one player: 7 cascades, 4 foundation stacks, a stock and a waste pile, a run moved between cascades | browser scenario `cards` (scripted through the real controls) + frames looked at |

## Protocol and docs touched

`docs/plugins.md` and `docs/plugin-api.md` (views and shared images; the Cards hooks), `plugins/sdk/*.d.ts` if a type changes, a new ADR, `docs/status.md` and the README status table, `server/CHANGELOG.md` entries (`fchange added` for Cards, Old Maid and Last Card, `changed` for views reading shared images). No change to the game WebSocket protocol: everything rides the plugin channel.

## Acceptance criteria and where each is observed

| # | Criterion | Seam |
| --- | --- | --- |
| 1 | A deck placed on a table with `hq-cards` on shows with the X hint; off: hidden and X does nothing; on again: back with its game | browser scenario `cards` + frames looked at |
| 2 | A new table lists Free table and every running registered game; Old Maid appears when `hq-card-pouilleux` is on and disappears when it is off | browser scenario `cards` |
| 3 | `register` from a plugin replaces only that plugin's definition; a malformed definition (seats out of range, deck over 128 cards, unknown action, sheet outside `shared/`) is refused with a reason in the server log | `hq-cards` unit tests |
| 4 | Seats, presence and reset behave as chess's (seat kept until reset, away on close or reload, reset rule) | browser scenario `cards` + unit tests |
| 5 | On a free table, three players: deal all, then a card dragged from a hand to a felt spot, onto a pile, onto a player's name, shows on every window within 1 s; a spectator cannot move a card | browser scenario `cards`, through the real controls |
| 6 | Create a pile, shuffle it, draw from it, look at it and reorder it: the new order is kept, and each of these is in every viewer's log; the looker's cards are not named in the log | browser scenario `cards` + unit tests |
| 7 | Offer: A offers to B, B picks A's third card, it moves to B's hand and is logged; only B could pick | browser scenario `cards` |
| 8 | A game's `allow` list hides the other actions in the window and the server ignores them if sent anyway | browser scenario `cards` + unit tests |
| 9 | An Old Maid game to the end: deal all, pairs dropped, cards drawn from neighbours by offer, Count names the holder of the jack of spades | browser scenario `cards` (scripted through the real controls) |
| 10 | Table state, seats and log survive a server restart and turning `hq-cards` or the game off and on; with the game off, its table offers only Reset | browser scenario `cards` (restart) |
| 10b | Last Card registers its 108 custom cards (in parts if over 4 KB), a game of it is dealt (7 each) and played a few turns through the real controls: its cards show from its sheet, their names appear in the log, Count gives each hand's points | browser scenario `cards` + unit test of its count |
| 11 | A view draws a running plugin's `shared/` image; it still cannot load anything else of that plugin or other hosts | browser scenario `plugins` extension + `host.ts` tests |
| 12 | One message per drop, none while dragging; the table's state message stays under 4 KB with the 54-card deck all loose on the felt | browser scenario `cards` counts `plg` frames + unit test of the encoded size |
| 13 | `a11y` stays at zero axe violations with the Cards window open; a card moved with the keyboard only reaches another window and is announced | `a11y` and `cards` scenarios |
| 14 | The deck object, the standard cards and the back are original and readable at the office's zoom and in the window | `capture-cards` frames and contact sheet, looked at |

## Left to the builder

- Felt size and units, the exact layout of seats around the felt for 2 to 8 players, the log's place in the view.
- Message names and shapes, file layout inside the two plugins, how the state is encoded under 4 KB.
- Splitting a large definition across calls; how many log entries fit.
- Removing empty piles; the hand reorder gesture.
- The pixel art of the deck object, the cards and the back (within `docs/art-style.md`).
