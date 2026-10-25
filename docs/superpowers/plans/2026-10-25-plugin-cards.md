# Card table plugin, Old Maid and Last Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bundled `hq-cards` plugin (a card deck on the map that opens a shared card table) and two game plugins that register with it, `hq-card-pouilleux` (Old Maid) and `hq-card-lastcard` (Last Card), shipped as pull request #38.

**Architecture:** `hq-cards` follows `hq-chess`: a map object, `onUse` opens a window, the server keeps one table per object in `hq.kv`, the browser code draws the modal and relays to a view (a canvas). The table rules live in pure TypeScript modules under `hq-cards/public/` shared by server, browser and unit tests. Games are server-only plugins that call `hq-cards`'s hooks (`register`, `registerCards`) and expose `count`. One core change: a view's CSP may load images from the `shared/` folder of running plugins.

**Tech Stack:** TypeScript plugins (QuickJS server side, sandboxed iframes browser side), Go plugin host tests, `node --test` web unit tests, the Puppeteer e2e runner (`e2e/run.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-25-plugin-cards-design.md`. Read it first; this plan argues from it. Read `AGENTS.md` and `.agents/skills/gauntlet/SKILL.md` too: the gauntlet applies to this change.

## Global Constraints

- Everything in English: code, comments, UI labels, docs, commits. Plugin labels are plain text (not the i18n dictionary).
- Original art only, drawn in code (AGENTS.md invariant 10). Never "UNO", its oval, logo or card layout.
- One message per drop, none while dragging (no per-frame network sends).
- Limits from the platform: `hq.kv` value ≤ 4 KB; server→member message ≤ 4 KB, 10/s per member over all plugins; page→server ≤ 1500 bytes, 8/s; view messages ≤ 4096 bytes, 30/s; hook args/answers ≤ 4 KB, 2 s; plugin call ≤ 50 ms; `hq.plugins.call` throws in `load()`.
- Table limits (this plan's values): seats 2-8; cards per deck ≤ 128; card name 1-24 chars; pile name 1-16 chars; ≤ 16 piles; deal N in 1-52; count text ≤ 200 chars; title 1-40 chars.
- Changelog: `fchange added "<sentence> (#38)" --pkg server` (Cards, Old Maid, Last Card) and `fchange changed "<sentence> (#38)" --pkg server` (views draw other plugins' shared images).
- Copy the shape of `plugins/bundled/hq-chess` (comments at file top, queues sent in `update()`, `tile()` checks, `hello`/`close` messages) rather than inventing a new style.

## Review Focus

1. **Stale actions:** two players drop the same card at once, or a card is no longer the top of its pile, or the pile was removed, or the offer was withdrawn. Expected: the first wins, the second is ignored and its sender gets the real state again (as chess's refused move). Tests in Task 3 and Task 5.
2. **Plugin start order:** a game started before `hq-cards`, after it, `hq-cards` restarted, a game stopped mid-game and started again. Expected: the game is listed whenever both run; a table of a stopped game offers only Reset and comes back intact. Tests in Task 8.
3. **Leaving mid-action:** a member closes the window or leaves the office while looking at a pile or with an open offer. Expected: "is looking at" disappears for everybody within 1 s; an offer stays (the seat is kept) and can still be picked or withdrawn. Tests in Task 5.
4. **Dealing edge cases:** deal with fewer cards than seats, deal N larger than the pile, deal or deal-all with no seated player, an empty pile shuffled. Expected: deals what there is, in seat order, never throws; a no-op logs nothing. Tests in Task 3.
5. **Worst-case size:** 16 piles with 16-character names, 108 cards spread over piles and the felt, 8 seats with 24-character names. Expected: the encoded table stays under 4 KB and the game message under its limit, or the action that would exceed it is refused. Tests in Task 3 and Task 1.

---

## File Structure

```
plugins/bundled/hq-cards/
  plugin.json            objects [deck], views {table}, server main.ts, client client.ts
  main.ts                server: onUse, onMessage, onJoin/onLeave, update, load (expose), onPlugins
  tsconfig.json          like hq-chess's, includes main.ts and the shared public modules
  tools/sprite.mjs       writes public/deck.png (the deck on the map)
  docs/README.md         developer guide for game authors
  public/
    deck.png
    games.ts             GameDefinition, validation, standard deck codes and names, client game encoding
    table.ts             Table model and every action (pure)
    log.ts               log entries, bounded append, sentences
    messages.ts          ToServer, ToClient, ViewIn, ViewOut (types, small constants)
    art.ts               paintCard / paintBack for the standard deck, CARD_W/CARD_H
    layout.ts            felt geometry: seat spots, hand strip, hit tests (pure)
    client.ts            hidden iframe: modal, relay
    view.ts              the table view (canvas, pointer, keyboard, live region, log)
    tsconfig.json
plugins/bundled/hq-card-pouilleux/
  plugin.json  main.ts  rules.ts  tsconfig.json
plugins/bundled/hq-card-lastcard/
  plugin.json  main.ts  rules.ts  tsconfig.json  tools/sprite.mjs  public/shared/cards.png
web/src/plugins/frameDoc.ts      + framePolicy()
web/src/plugins/host.ts          policy() uses framePolicy; views get shared folders of running plugins
web/src/plugins/manager.ts       HostDeps.running()
web/test/cards.test.ts           games.ts, table.ts, log.ts, layout.ts
web/test/cardGames.test.ts       pouilleux and lastcard rules.ts
web/test/pluginFrameDoc.test.ts  + framePolicy tests
server/internal/plugin/cards_test.go   hq-cards and the two games through the real host
e2e/scenarios/cards.mjs, e2e/scenarios/capture-cards.mjs, e2e/scenarios/a11y.mjs (extended), e2e/run.mjs (list)
docs/decisions/0031-card-table-and-shared-images.md, docs/plugins.md, docs/plugin-api.md, docs/status.md, README.md, server/CHANGELOG.md
scripts/gauntlet.sh, .github/workflows/ci.yml   (plugin-types lists)
```

---

### Task 1: Game definitions and the standard deck (`games.ts`)

**Files:**
- Create: `plugins/bundled/hq-cards/public/games.ts`
- Test: `web/test/cards.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Action = "place" | "offer" | "dealAll" | "deal" | "shuffle" | "gather" | "count" | "createPile" | "viewPile" | "draw";
  export const ACTIONS: readonly Action[];
  export const STANDARD: readonly string[]; // 54 codes: suits S,H,D,C × ranks A,2..9,T,J,Q,K, then "XR","XB"
  export interface StartPile { name: string; face: "up" | "down"; at: [number, number] }
  export type Deck =
    | { standard: string[] }
    | { sheet: string; cell: [number, number]; back: number; total: number; cards: { frame?: number; name: string }[] };
  export interface GameDefinition { title: string; seats: [number, number]; allow?: Action[]; deck: Deck; piles?: StartPile[]; count?: boolean }
  export interface Game extends GameDefinition { name: string; complete: boolean } // complete: every card of a custom deck arrived
  export function validateDefinition(d: unknown): { ok: true; def: GameDefinition } | { ok: false; err: string };
  export function validateCards(cards: unknown, from: number, total: number): { ok: true; cards: { frame?: number; name: string }[] } | { ok: false; err: string };
  export function deckSize(d: Deck): number;
  export function cardName(g: Pick<Game, "deck">, n: number): string;     // "Ace of spades", "10 of hearts", "Red joker", or the custom name
  export function allows(g: Pick<Game, "allow"> | null, a: Action): boolean; // no list: everything
  export const FREE: Game; // name "free", title "Free table", seats [2, 8], deck STANDARD, piles [{ name: "Stock", face: "down", at: centre }]
  export interface ClientGame { name: string; title: string; seats: [number, number]; allow: Action[]; deck: { standard: string[] } | { plugin: string; sheet: string; cell: [number, number]; back: number; frames: number[]; names: string[] } }
  export function clientGame(g: Game): ClientGame;
  export const CLIENT_GAME_MAX = 3800; // bytes of JSON.stringify(clientGame(g))
  ```

- [ ] **Step 1: Write the failing tests** in `web/test/cards.test.ts` (header comment and imports as `web/test/chess.test.ts`):
  - `STANDARD has 54 distinct codes and cardName names them`: `STANDARD.length === 54`, `new Set(STANDARD).size === 54`, `cardName({ deck: { standard: STANDARD } }, STANDARD.indexOf("TH")) === "10 of hearts"`, `"AS"` → `"Ace of spades"`, `"XR"` → `"Red joker"`.
  - `validateDefinition refuses each broken rule`: table-driven; each case gives `ok:false` and an `err` containing the word in brackets: seats `[1, 4]` (seats), `[2, 9]` (seats), `[5, 3]` (seats), title `""` and 41 chars (title), unknown action `"cheat"` (allow), standard code `"ZZ"` (deck), duplicate standard code (deck), 0 cards (deck), custom `total: 129` (deck), custom sheet `"cards.png"` not starting with `shared/` (sheet), custom sheet `"shared/../x.png"` (sheet), card name 25 chars (name), pile name 17 chars (pile), 17 piles (pile), `count: "yes"` (count).
  - `validateDefinition accepts Old Maid's and a 108-card custom deck sent in parts`: a definition with `total: 108` and 64 cards is `ok` and `deckSize` is 108; `validateCards(next44, 64, 108)` is `ok`; `validateCards(next45, 64, 108)` is not.
  - `allows`: `allows(null, "draw") === true`, `allows({ allow: ["place"] }, "draw") === false`.
  - `clientGame of the worst case fits`: 128 cards named with 24 characters each → `JSON.stringify(clientGame(g)).length > CLIENT_GAME_MAX`, so `validateDefinition` of that definition is refused (err contains "too big"); a 108-card deck with names like "Yellow Draw Two" is accepted.

- [ ] **Step 2: Run** `cd web && node --test test/cards.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `games.ts`** with the interfaces above. `validateDefinition` checks the size by building the `clientGame` of the definition (its cards so far padded with the longest name seen when `total` exceeds the cards sent: refuse early rather than after the last part). Centre of the felt for `FREE`'s Stock comes from `layout.ts`'s `FELT_W/FELT_H` — define `FELT_W = 320`, `FELT_H = 180` here instead and let `layout.ts` import them, so `games.ts` has no dependency.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `git add plugins/bundled/hq-cards/public/games.ts web/test/cards.test.ts && git commit -m "hq-cards: game definitions and the standard deck"`

### Task 2: The log (`log.ts`)

**Files:**
- Create: `plugins/bundled/hq-cards/public/log.ts`
- Test: `web/test/cards.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  export type Verb = "took" | "placed" | "gave" | "flipped" | "offered" | "withdrew" | "picked" | "dealt" | "shuffled" | "gathered" | "counted" | "created" | "removed" | "looked" | "reordered" | "drew" | "chose";
  export interface LogEntry { s: number; v: Verb; c?: number; p?: string; to?: number; n?: number; text?: string } // s: seat; c: a card named only when it ends face up; p: pile name; to: seat; n: a count; text: count result or game title
  export const LOG_MAX = 2000; // bytes of JSON for the whole log
  export function append(log: LogEntry[], e: LogEntry): LogEntry[]; // drops oldest until JSON ≤ LOG_MAX
  export function parseLog(s: string | null): LogEntry[];
  export function sentence(e: LogEntry, seatName: (s: number) => string, card: (c: number) => string): string;
  ```
- [ ] **Step 1: Failing tests:** `sentence` for each verb with Ann/Bo and "Discard": e.g. `{s:0,v:"looked",p:"Discard"}` → `"Ann looked at Discard"`, `{s:1,v:"picked",to:0}` → `"Bo drew a card from Ann's hand"`, `{s:2,v:"placed",c:7,p:"Pairs"}` → `"Cy put the 8 of spades on Pairs"`, `{s:2,v:"placed",p:"Stock"}` (no `c`) → `"Cy put a card on Stock"`, `{s:0,v:"dealt",n:7}` → `"Ann dealt 7 cards each"`, `{s:0,v:"counted",text:"Bo keeps the jack of spades"}` → `"Ann counted: Bo keeps the jack of spades"`. `append` of 500 entries keeps `JSON.stringify(log).length <= LOG_MAX` and keeps the newest.
- [ ] **Step 2: Run** `cd web && node --test test/cards.test.ts` → FAIL.
- [ ] **Step 3: Implement** `log.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "hq-cards: the table log"`.

### Task 3: The table model (`table.ts`)

**Files:**
- Create: `plugins/bundled/hq-cards/public/table.ts`
- Test: `web/test/cards.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 (`Game`, `Action`, `allows`, `deckSize`, `FREE`, `FELT_W`, `FELT_H`) and Task 2 (`LogEntry`).
- Produces:
  ```ts
  export const UP = 128; // a card number + UP: face up (cards are < 128)
  export interface Seat { id: number; name: string }
  export interface Pile { id: string; name: string; at: [number, number]; face: "up" | "down"; cards: number[]; mine: boolean } // last = top; mine: created by a player
  export interface Loose { c: number; at: [number, number] } // c may carry UP
  export interface Table { game: string | null; seats: (Seat | null)[]; hands: number[][]; piles: Pile[]; loose: Loose[]; offer: { from: number; to: number } | null; count: string; next: number }
  export type Dest = { k: "felt"; at: [number, number] } | { k: "pile"; id: string } | { k: "hand"; seat: number };
  export type Src = { k: "hand"; i: number } | { k: "loose"; c: number } | { k: "pile"; id: string };
  export type Done = { ok: false } | { ok: true; log?: LogEntry }; // LogEntry from log.ts (Task 2)
  export function newTable(): Table;                      // game null
  export function parseTable(s: string | null): Table;   // null or broken → newTable()
  export function choose(t: Table, g: Game): void;        // empty seats sized g.seats[1], hands [], starting piles (ids "p0".."pN"; deck shuffled into the first, face down), loose [], offer null, count ""
  export function seatOf(t: Table, id: number): number | null;
  export function take(t: Table, seat: number, who: Seat): Done;
  export function place(t: Table, seat: number, from: Src, to: Dest, up: boolean, g: Game): Done;
  export function flip(t: Table, seat: number, from: Src, g: Game): Done;   // loose or pile top only; allowed with "place"
  export function order(t: Table, seat: number, hand: number[]): Done;      // same multiset, never logged
  export function offer(t: Table, seat: number, to: number | null, g: Game): Done;
  export function pick(t: Table, seat: number, i: number, g: Game): Done;   // only the offer's target; moves hand[from][i] to the end of its hand
  export function dealAll(t: Table, seat: number, pile: string, g: Game): Done;
  export function deal(t: Table, seat: number, pile: string, n: number, g: Game): Done;
  export function shuffle(t: Table, seat: number, pile: string, g: Game, rnd?: () => number): Done;
  export function gather(t: Table, seat: number, g: Game): Done;            // all cards into piles[0] face down, removes mine piles, offer null
  export function createPile(t: Table, seat: number, name: string, face: "up" | "down", at: [number, number], g: Game): Done;
  export function removePile(t: Table, seat: number, id: string, g: Game): Done; // only mine and empty; allowed with "createPile"
  export function reorderPile(t: Table, seat: number, id: string, cards: number[], g: Game): Done; // same multiset; allowed with "viewPile"
  export function draw(t: Table, seat: number, id: string, g: Game): Done;
  export function defaultCount(t: Table, g: Game): string; // "Ann 5, Bo 4 · Stock 0, Pairs 12"
  export function canReset(t: Table, member: number, present: Set<number>): boolean; // chess's rule
  export function reset(t: Table): void;                   // newTable()
  export function encodedSize(t: Table): number;            // JSON.stringify(t).length
  export const TABLE_MAX = 3900;
  ```
  Every action returns `{ ok: false }` and changes nothing when: `seat` is null or not seated, the game does not `allows` it, an index or id is wrong, or the result would make `encodedSize > TABLE_MAX`. `place` refuses `pile → my own hand` (that is `draw`) and a `pile` source whose top is not where the client thinks (the source names the pile; the moved card is its top).

- [ ] **Step 1: Write the failing tests** (append to `web/test/cards.test.ts`). Use a fixed `rnd` (a seeded LCG in the test file) and three seats Ann/Bo/Cy on `FREE`:
  - `choose sets up the free table`: 54 cards in `piles[0]` ("Stock", face down), 8 empty seats, `game === "free"`.
  - `take`: a seat once per member; a taken seat refused; seat out of range refused.
  - `dealAll deals round the seats after the dealer`: Ann (seat 0) deals 54 to 3 seats → hands 18/18/18, first card to seat 1; with 2 cards left in Stock and 3 seats → seats 1 and 2 get one each; with nobody seated → `{ ok: false }`.
  - `deal 7 stops when the pile runs out`: Stock of 10, 3 seats → 4/3/3 order-correct; `deal(…, 0)` and `deal(…, 53)` refused.
  - `place moves`: hand → felt (loose with `UP` when `up`), loose → pile top, pile top → Bo's hand, hand → Cy's hand; pile top → my hand refused; a card not in my hand refused; a spectator refused; two `place` of the same loose card: the second refused (Review Focus 1).
  - `draw and reorderPile`: draw takes the top; reorder with a different multiset refused; with `allow: ["place"]` both refused.
  - `offer and pick`: Ann offers to Bo; Cy cannot pick; Bo picks index 2 → that card moves from Ann's hand to the end of Bo's; offer closed; picking after Ann withdraws (`offer(t, 0, null)`) refused (Review Focus 1).
  - `gather` puts all 54 back in Stock face down and removes `mine` piles, keeps game piles.
  - `createPile/removePile`: 16 piles max; name 17 chars refused; a non-empty pile not removable; a game pile not removable.
  - `shuffle of an empty pile is a no-op without a log entry` (Review Focus 4): `{ ok: true }` without `log`.
  - `worst case stays under TABLE_MAX` (Review Focus 5): 108-card custom game, 16 piles of 16-char names, 8 seats with 24-char names, cards spread over piles, hands and felt with 3-digit coordinates → `encodedSize(t) <= TABLE_MAX`; an action that would push it over is refused.
  - `canReset` mirrors chess: present seated player yes; spectator no while a seated player is present; spectator yes when none is.

- [ ] **Step 2: Run** `cd web && node --test test/cards.test.ts`. Expected: FAIL (no `table.ts`).

- [ ] **Step 3: Implement `table.ts`.** Shuffle is Fisher-Yates with `rnd ?? Math.random`; log entries are built with Task 2's `LogEntry` shape.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "hq-cards: the table model"` with both files.

### Task 4: Card art, the deck sprite and the felt layout

**Files:**
- Create: `plugins/bundled/hq-cards/public/art.ts`, `public/layout.ts`, `tools/sprite.mjs`, `public/deck.png`
- Test: `web/test/cards.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  // art.ts
  export const CARD_W = 20, CARD_H = 28;
  export type Set = (x: number, y: number, hex: string) => void;
  export function paintCard(code: string, set: Set): void; // a STANDARD code; rank glyph top-left and bottom-right, suit pips, court cards with an original figure
  export function paintBack(set: Set): void;
  // layout.ts
  export const FELT_W: number, FELT_H: number;            // re-exported from games.ts
  export function seatSpots(seats: number, me: number | null): { seat: number; x: number; y: number; side: "top" | "left" | "right" }[]; // everyone but me around the felt, in seat order clockwise from my left
  export function hit(t: Table, me: number | null, x: number, y: number): Spot | null; // topmost thing under a point (Table from Task 3)
  export type Spot = { k: "hand"; i: number } | { k: "loose"; c: number } | { k: "pile"; id: string } | { k: "seat"; seat: number } | { k: "felt"; at: [number, number] };
  ```
- [ ] **Step 1: Failing tests:** every `STANDARD` code paints a distinct 20×28 picture (hash of the pixels, 54 distinct), uses only colours from a fixed palette in `art.ts` and the outline `#1a1526`, and draws nothing outside the cell; `paintBack` differs from every face; `seatSpots(8, 0)` returns 7 spots inside the view and never overlapping the felt's piles' area; `seatSpots(4, null)` (spectator) returns 4; `hit` finds a pile's top over a loose card underneath, a hand card in the strip, a seat's name.
- [ ] **Step 2: Run** `cd web && node --test test/cards.test.ts` → FAIL.
- [ ] **Step 3: Implement** `art.ts` (style rules of `docs/art-style.md`: 1 px outline, never pure black, light from the top-left, three tones; red suits `#c8463c`-ish, black suits the outline family), `layout.ts`, and `tools/sprite.mjs` (copy `hq-chess/tools/sprite.mjs`'s PNG writer) writing `public/deck.png` 16×16: a small stack of cards seen at the office's 3/4 angle. Run `node plugins/bundled/hq-cards/tools/sprite.mjs`.
- [ ] **Step 4: Run** tests → PASS. Open `public/deck.png` at 8× (the art preview or any viewer) and look at it.
- [ ] **Step 5: Commit** `git commit -m "hq-cards: standard card art, the deck sprite and the felt layout"`.

### Task 5: `hq-cards` server code, manifest and Go tests

**Files:**
- Create: `plugins/bundled/hq-cards/plugin.json`, `main.ts`, `tsconfig.json`, `public/messages.ts`, `public/tsconfig.json`
- Test: `server/internal/plugin/cards_test.go`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces (`public/messages.ts`):
  ```ts
  type At = { x: number; y: number }; // the deck's tile
  export type ToServer =
    | { t: "hello" }
    | (At & { t: "choose"; game: string })              // a registered game's plugin name or "free"
    | (At & { t: "seat"; seat: number })
    | (At & { t: "place"; from: Src; to: Dest; up: boolean })
    | (At & { t: "flip"; from: Src })
    | (At & { t: "order"; hand: number[] })
    | (At & { t: "offer"; to: number | null })
    | (At & { t: "pick"; i: number })
    | (At & { t: "dealAll"; pile: string })
    | (At & { t: "deal"; pile: string; n: number })
    | (At & { t: "shuffle"; pile: string })
    | (At & { t: "gather" | "count" | "reset" | "close" | "unlook" })
    | (At & { t: "newPile"; name: string; face: "up" | "down"; at: [number, number] })
    | (At & { t: "delPile" | "look" | "draw"; pile: string })
    | (At & { t: "reorder"; pile: string; cards: number[] });
  export interface Looking { seat: number; pile: string }
  export interface TableState { t: Table; here: number[]; looking: Looking[]; unavailable: boolean } // here: present seated members' ids
  export type ToClient =
    | (At & { t: "open" | "state"; s: TableState })
    | (At & { t: "games"; list: { name: string; title: string }[] })   // with game null: the choice
    | (At & { t: "game"; g: ClientGame })
    | (At & { t: "log"; log: LogEntry[] });
  export type ViewIn = { t: "state"; s: TableState; me: number; id: string } | { t: "game"; g: ClientGame } | { t: "log"; log: LogEntry[] };
  export type ViewOut = Omit<ToServer, "x" | "y">; // the view never knows the tile; client.ts adds it
  ```
  Hooks exposed in `load()`: `register(caller, def)` → `{ ok: true } | { ok: false, err }`; `registerCards(caller, { from, cards })` → same. `hq-cards` calls a game's `count(caller, { seats: (string | null)[], hands: number[][], piles: { name: string; cards: number[] }[], loose: number[] })` → string (cards without the `UP` flag).

- [ ] **Step 1: Write the failing Go tests** in `server/internal/plugin/cards_test.go`, copying `chessHost`'s shape (`Scan` of `../../../plugins`, `fakeSink`, `errCounter`) as `cardsHost(t, kv, online...)`:
  - `TestCardsFreeTable`: Alice uses the deck at (4,5) → she gets `games` listing `free`; sends `choose free`, `seat 0`; Bob `seat 1`; Alice `dealAll` of `p0` → both get a `state` whose hands have 27 cards each; the log message has a `dealt` entry; no plugin error counted.
  - `TestCardsOnlyViewersAct`: Carol, who never used the deck, sends `seat` → no state change; Bob closes the window (`close`) → his `place` is ignored; a member who never sent `hello` but used the deck can act.
  - `TestCardsStaleDrop` (Review Focus 1): Alice and Bob both `place` the same loose card to different spots in one batch → exactly one applies; the other sender gets a fresh `state`.
  - `TestCardsSurvivesRestart`: after actions, a new host on the same `memKV` serves the same table and log (`table:4,5`, `log:4,5`).
  - `TestCardsLookingClears` (Review Focus 3): Alice `look p0` → Bob's next state has `looking [{seat:0,pile:"p0"}]` and the log has `looked`; Alice leaves (`Presence(alice,false)`) → Bob's state has no `looking`; an open offer from Alice stays and Bob can still `pick`.
  - `TestCardsMessageSizes`: every message the sink got is ≤ 4096 bytes after a worst-case session (16 piles, 8 seated players, 54 loose cards).

- [ ] **Step 2: Run** `cd server && go test ./internal/plugin -run Cards -race`. Expected: FAIL (`hq-cards` not found).

- [ ] **Step 3: Write `plugin.json`:** name `hq-cards`, title `Cards`, version `1.0.0`, description "A card table members play any card game on while others watch.", a `longDescription` in chess's style (deck placed from the editor, X, choose a game or Free table, seats kept until reset, everything logged), `"server": "main.ts"`, `"client": "client.ts"` (Task 6 adds the file; until then the catalog refuses a missing client, so write a one-line placeholder `client.ts` that Task 6 replaces), `"objects": [{ "kind": "deck", "label": "Card deck", "size": [1, 1], "sprite": "deck.png" }]`, `"views": { "table": "view.ts" }` (same placeholder rule). `deck.png` comes from Task 4.

- [ ] **Step 4: Implement `main.ts`** after `hq-chess/main.ts`: tables loaded on first use (`table:<x>,<y>`, `log:<x>,<y>`), viewers in memory, `toSend`/`toOpen` queues flushed in `update()` with the same budget handling, `hello` and `close` as chess. Games: `games: Map<string, Game>` filled by the hooks (`caller.plugin` is the game's name; `register` replaces, `registerCards` appends until `complete`); `onPlugins()` deletes the games whose `hq.plugins.running(name)` is false. A table whose `game` is neither `free` nor a complete registered game is `unavailable`: only `reset` and `close` are accepted. `count`: free table or `count` absent → `defaultCount`; else `hq.plugins.call(game, "count", args)` with `.then` setting `t.count` (string cut to 200) and `.catch` setting `"Count unavailable"`, both then saving and queueing — no member is needed after the await. Send order on open: `game` (or `games` when none), then `open`, then `log`. Every successful action: save table, append log entry if any, queue `state` (+ `log`) to the table's viewers. A refused action from a seated player queues `state` to them only.

- [ ] **Step 5: Run** `cd server && go test ./internal/plugin -run Cards -race` → PASS. Then `cd web && pnpm exec tsc -p ../plugins/bundled/hq-cards` → no errors.

- [ ] **Step 6: Commit** `git commit -m "hq-cards: server code, one table per deck"`.

### Task 6: The Cards window and the table view

**Files:**
- Create/replace: `plugins/bundled/hq-cards/public/client.ts`, `public/view.ts`
- Test: e2e in Task 10; type-check here.

**Interfaces:**
- Consumes: Tasks 1-5 (`messages.ts`, `art.ts`, `layout.ts`, `log.ts`'s `sentence`, `games.ts`'s `cardName`).
- Produces: the view keeps `window.__drawn` (test hook, read by e2e only): `{ cards: { c: number; up: boolean; x: number; y: number; where: "hand" | "loose" | "pile" | "seat" }[]; log: string[] }` refreshed on every draw, in canvas pixels.

- [ ] **Step 1: `client.ts`** after `hq-chess/public/client.ts`: on `games` with no game → modal "Cards" with one button per game plus "Free table" (send `choose`). With a game: a row of seat buttons (`Seat 1: Ann`, "(away)" when absent, pressed when mine, a free one enabled only if I have no seat), a muted line of holders (as chess's `holders`), the game's buttons for the allowed table-level actions (`Shuffle`, `Deal all`, `Deal…` with an `hq.ui.number` 1-52 default 7, `Gather all`, `Count`, `New pile…` with a name text field and a face toggle), `Reset` (enabled per `canReset`), the count text when set, then `hq.ui.view({ view: "table", label: "Card table", height: "large", onMessage })`. Unavailable game: the text "This game is not available" and Reset only. Actions not allowed are absent, not disabled. Relay view messages after shape checks, adding `x, y`. On `state`, `game`, `log`: post to the view (`ViewIn`), separately.
- [ ] **Step 2: `view.ts`** after `hq-chess/public/board.ts`: a canvas sized `FELT_W × (FELT_H + hand strip)` plus seat spots, scaled by the largest whole number that fits the view's width; draws felt, piles (top card, count badge), loose cards, other seats (name, backs, "offers" tag, "looking at …" tag), my hand fanned; the log as an HTML list beside or under the canvas (builder's call, readable at 1280×720). Hidden information is hidden here: other hands as backs, face-down cards as backs, pile contents only while I look. Pointer: drag (one `ViewOut` on drop, nothing while moving) or click-then-click; double click flips; a click on a seat that offers me its hand opens its backs to pick; "Look" on a pile opens its cards in a row, reorderable by drag, `Done` sends `reorder` (if changed) then `unlook`. Hand reorder by dragging within the strip sends `order`. Keyboard: arrows move a cursor over hand → felt piles and loose cards → seats; Enter picks up and drops; F flips; L looks; D draws; Escape cancels; a polite live region announces the cursor's target and every new log sentence. Custom decks: image `new URL("/plugins/" + plugin + "/assets/" + sheet, document.baseURI)`, frames cut by `cell`.
- [ ] **Step 3: Type-check:** `cd web && pnpm exec tsc -p ../plugins/bundled/hq-cards && pnpm exec tsc -p ../plugins/bundled/hq-cards/public`. Expected: no errors.
- [ ] **Step 4: Smoke run:** `./scripts/dev.sh`, turn Cards on in Administration > Plugins, place a deck on a table with the editor, open it with X in two browsers, choose Free table, deal, drag a card. Look at it. (Formal checks are Task 10.)
- [ ] **Step 5: Commit** `git commit -m "hq-cards: the Cards window and the table view"`.

### Task 7: Views draw the shared images of running plugins

**Files:**
- Modify: `web/src/plugins/frameDoc.ts`, `web/src/plugins/host.ts:86-103,281`, `web/src/plugins/manager.ts:112`
- Create: `docs/decisions/0031-card-table-and-shared-images.md`
- Test: `web/test/pluginFrameDoc.test.ts` (append)

**Interfaces:**
- Produces: `export function framePolicy(origin: string, plugin: string, hosts: string[], shared: string[]): string` in `frameDoc.ts`; `HostDeps.running(): string[]` (names of the running plugins on this page).

- [ ] **Step 1: Failing tests:** `framePolicy("http://h", "hq-cards", [], [])` equals today's policy for `hq-cards` (copy the string from `host.ts`); with `shared: ["hq-card-lastcard", "Bad Name", "hq-cards"]` the `img-src` gains exactly `http://h/plugins/hq-card-lastcard/assets/shared/` (bad names dropped, own plugin not repeated), `connect-src` and `script-src` unchanged.
- [ ] **Step 2: Run** `cd web && node --test test/pluginFrameDoc.test.ts` → FAIL.
- [ ] **Step 3: Implement** `framePolicy`; `PluginHost.policy(shared)` calls it; the hidden frame passes `[]`, the view frame passes `this.deps.running()` read when the view iframe is created (`host.ts:281`); `manager.ts` supplies `running` from its list of running plugins (`manager.ts:210` already has `running()`).
- [ ] **Step 4: Run** `node --test test/pluginFrameDoc.test.ts test/pluginView.test.ts` and `pnpm exec tsc --noEmit` → PASS.
- [ ] **Step 5: Write ADR 0031** (format of 0030): context (games bring their own cards, views could only read their own folder), decision (views' `img-src` adds the `shared/` folders of plugins running when the view starts; `hq-cards` owns the table and games register through hooks; free table; client-side hiding with a log as the honesty mechanism), alternatives (approach B and C of the spec; a blob relay through `hq.ui.post`), impact (performance: one state message per change to the table's viewers, ≤ 4 KB, not measured; maintenance; install: none).
- [ ] **Step 6: Commit** `git commit -m "Plugin views draw the shared images of running plugins"`.

### Task 8: `hq-card-pouilleux` (Old Maid)

**Files:**
- Create: `plugins/bundled/hq-card-pouilleux/plugin.json`, `main.ts`, `rules.ts`, `tsconfig.json`
- Test: `web/test/cardGames.test.ts`, `server/internal/plugin/cards_test.go` (append)

**Interfaces:**
- Consumes: the `GameDefinition` shape and the `count` hook arguments (Task 5). The game does not import `hq-cards` files (imports cannot leave its folder): `rules.ts` declares the few types it needs.
- Produces (`rules.ts`): `export const DEFINITION: { title: "Old Maid"; seats: [2, 6]; allow: ["place","offer","dealAll","shuffle","gather","count"]; deck: { standard: string[] /* STANDARD minus JC, JD, JH, same code format */ }; piles: [{ name: "Stock", face: "down", at }, { name: "Pairs", face: "up", at }]; count: true }`; `export function count(a: CountArgs): string`.

- [ ] **Step 1: Failing tests** in `web/test/cardGames.test.ts`: the deck has 51 codes and contains `"JS"` but no other jack; `count` with hands Ann 3, Bo 2, Cy 0 → `"5 cards left: Ann 3, Bo 2, Cy 0"`; with only `"JS"` left in Bo's hand → `"Bo keeps the jack of spades"`; seat `null` entries are skipped.
- [ ] **Step 2: Run** `cd web && node --test test/cardGames.test.ts` → FAIL.
- [ ] **Step 3: Implement** `rules.ts` and `main.ts`: `load()` exposes `count` (checks `caller.plugin === "hq-cards"`, else throws); `register()` helper calls `hq.plugins.call("hq-cards", "register", DEFINITION)` and is called on the first `update()` and in `onPlugins()` when `hq.plugins.running("hq-cards")`; a rejected call is logged once with `hq.log`. `plugin.json`: title "Old Maid", server only, a description naming Cards as required.
- [ ] **Step 4: Go tests** (append to `cards_test.go`): `TestOldMaidRegisters` covering Review Focus 2 — start order cards→pouilleux, pouilleux→cards, cards stopped and started, pouilleux stopped (a chosen Old Maid table's state becomes `unavailable`, only `reset` acts) and started (state back, not unavailable). Wait for the registration by polling the `games` message on a new `Use`, up to 2 s. `TestOldMaidGame`: choose Old Maid, 3 seats, dealAll → 17/17/17; Count → the count text in the state comes from the hook.
- [ ] **Step 5: Run** `cd web && node --test test/cardGames.test.ts` and `cd server && go test ./internal/plugin -run 'Cards|OldMaid' -race` → PASS.
- [ ] **Step 6: Commit** `git commit -m "hq-card-pouilleux: Old Maid for the card table"`.

### Task 9: `hq-card-lastcard` (Last Card)

**Files:**
- Create: `plugins/bundled/hq-card-lastcard/plugin.json`, `main.ts`, `rules.ts`, `tsconfig.json`, `tools/sprite.mjs`, `public/shared/cards.png`
- Test: `web/test/cardGames.test.ts` (append), `server/internal/plugin/cards_test.go` (append)

**Interfaces:**
- Produces (`rules.ts`): `export const CARDS: { name: string; value: number }[]` (108, frame = index; per colour Red, Yellow, Green, Blue: "Red 0", two each "Red 1".."Red 9", two "Red Skip", two "Red Reverse", two "Red Draw Two"; then four "Wild" and four "Wild Draw Four"); `export const BACK = 108`; `export const CELL: [20, 28]`; `export const DEFINITION` (title "Last Card", seats [2, 8], allow `["place","deal","shuffle","draw","gather","count"]`, deck `{ sheet: "shared/cards.png", cell: CELL, back: BACK, total: 108, cards }`, piles Draw (down) and Discard (up), count true); `export function count(a): string` ("Ann 32, Bo 0, Cy 70").
- [ ] **Step 1: Failing tests:** 108 cards, 25 per colour, 4 + 4 wilds, values: numbers their digit, Skip/Reverse/Draw Two 20, both wilds 50; `count` of known hands gives the exact string; no name contains "UNO" (case-insensitive).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `rules.ts`; `tools/sprite.mjs` writes `public/shared/cards.png`: 109 cells of 20×28 in rows of 16 (frame i at `(i % 16, i / 16)`), the back at 108. Original design: a coloured card with a thick inner frame, a large centred pixel numeral or a pixel icon (Skip: a crossed circle drawn as pixels, Reverse: two bent arrows, Draw Two: "+2", Wild: a four-colour square split diagonally, Wild Draw Four: the same with "+4"); no white oval, no tilted shapes, no wordmark. Run `node plugins/bundled/hq-card-lastcard/tools/sprite.mjs` and look at the PNG at 4×.
- [ ] **Step 4: Implement** `main.ts`: as Old Maid's, but registration sends the definition with the first 64 cards, then `registerCards({ from: 64, cards: rest })` (always two parts: it proves the split).
- [ ] **Step 5: Go test** `TestLastCardRegistersInParts`: after registration, a table can choose "Last Card", the `game` message has 108 names and the plugin `hq-card-lastcard`; deal 7 to 3 seats → hands of 7; Count → hook text.
- [ ] **Step 6: Run** web and Go tests → PASS.
- [ ] **Step 7: Commit** `git commit -m "hq-card-lastcard: Last Card with its own cards"`.

### Task 10: Browser scenarios, accessibility and captures

**Files:**
- Create: `e2e/scenarios/cards.mjs`, `e2e/scenarios/capture-cards.mjs`
- Modify: `e2e/scenarios/a11y.mjs`, `e2e/run.mjs:21` (add `"cards"` after `"chess"`)

**Interfaces:**
- Consumes: `window.__drawn` (Task 6), helpers of `e2e/lib.mjs`, the patterns of `e2e/scenarios/chess.mjs` (admin `PUT /api/admin/plugins/<name>`, `putMap` with a deck prop `hq-cards/deck` at (13, 22), `openWithX`, real mouse `drag`, `countFrames` through CDP, `within`).

- [ ] **Step 1: Write `cards.mjs`** with one `check` per spec criterion, named by its number. Players Ann, Bo, Cy, spectator Di. Every action through the real controls (X, modal buttons, mouse drags on the canvas, keyboard). Criteria: 1 (deck shows with hint; plugin off hides it and X does nothing; on again with its table), 2 (list shows Free table and Old Maid / Last Card per plugin on/off), 4, 5, 6, 7, 8, 9 (an Old Maid game to the end through the controls, Count names the jack of spades holder), 10 (server restart via the runner's restart helper; game plugin off → only Reset; on → back), 10b (Last Card dealt and played a few turns: cards drawn from its sheet — compare a drawn card's pixels with the PNG cell — names in the log, Count points), 12 (count `plg` frames: zero during a drag, one per drop; state message size from the Go test is referenced, not re-measured here). Check `window.__drawn` for what each page shows and compare one card's pixels per deck with `paintCard` / the sheet.
- [ ] **Step 2: Run** `cd e2e && node run.mjs cards` → it must go **red** before Tasks 5-9 are complete (run it on the commit before Task 5 if building in order, to see the scenario fail for the right reason: no `hq-cards`), then green now. Expected final: all `cards` checks pass.
- [ ] **Step 3: Extend `a11y.mjs`** like its chess block: a deck at (13, 22), the Cards window open with a dealt free table, zero axe violations; a card moved with the keyboard only reaches another page and is announced in its live region (criterion 13).
- [ ] **Step 4: Write `capture-cards.mjs`** (copy `capture-chess.mjs`): frames of the deck on its table in the office, the window with a free table dealt to 4, an Old Maid table, a Last Card table, the look-at-a-pile row; a contact sheet with ffmpeg. Run `cd e2e && node run.mjs capture-cards` and **look at every frame** (criterion 14): readable at the office's zoom, no third-party look.
- [ ] **Step 5: Run** `cd e2e && node run.mjs cards a11y plugins chess` → all pass.
- [ ] **Step 6: Commit** `git commit -m "Browser checks and captures for the card table"`.

### Task 11: Docs, changelog, gates

**Files:**
- Create: `plugins/bundled/hq-cards/docs/README.md`
- Modify: `docs/plugins.md` (intro paragraph: the third bundled plugin and its games; Views: shared images; a "Card games" subsection pointing to the guide), `docs/plugin-api.md` (views' CSP row; `hq-cards` hooks), `docs/status.md` (a row in the format of the chess row: what was run, what was not), `README.md` status table, `server/CHANGELOG.md` via `fchange`, `scripts/gauntlet.sh:50` and `.github/workflows/ci.yml:64` (add the three plugins' tsconfig folders: `hq-cards`, `hq-cards/public`, `hq-card-pouilleux`, `hq-card-lastcard`).

- [ ] **Step 1: Write the developer guide** (`hq-cards/docs/README.md`, like hq-pets's): what a game is, the `GameDefinition` with every limit, registering on the first `update()` and in `onPlugins()` (never in `load()`), `registerCards` for decks whose definition is over 4 KB, the `count` hook and its arguments, the sheet layout, a complete minimal example (Old Maid's `main.ts`).
- [ ] **Step 2: Update the docs and tables listed above.** Status row labels measured vs not run: no load or capacity measurement.
- [ ] **Step 3: Changelog:**
  ```bash
  fchange added "Cards: a card deck on the map opens a shared card table for any card game, with seats, piles, dealing and a log of every action (#38)" --pkg server
  fchange added "Old Maid and Last Card, two card games for the Cards table (#38)" --pkg server
  fchange changed "Plugin views can draw images from the shared folder of other running plugins (#38)" --pkg server
  ```
- [ ] **Step 4: Site check:** `cd site && node build.mjs && node check.mjs` → passes (new links resolve).
- [ ] **Step 5: Gates:** `scripts/gauntlet.sh` (whole suite) → `GATES GREEN`. Then run the gauntlet's critics (UX, invariants, regression) per `.agents/skills/gauntlet/SKILL.md`, fix blockers and majors, repeat.
- [ ] **Step 6: Commit** `git commit -m "Docs, status and changelog for the card table (#38)"`.
