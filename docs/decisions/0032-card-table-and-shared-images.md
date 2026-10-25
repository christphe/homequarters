# 0032: A card table plugin, games as plugins, and views drawing shared images

Date: 2026-10-25. Status: accepted.

## Context

Members wanted small games besides chess, and card games are the family where one table can host many games. A table needs the same things for every game: a deck on the map, seats and spectators, dealing, hands, piles, cards dropped anywhere. Each game adds only a few rules, and some games bring their own cards. A plugin cannot import another plugin's code (imports stay inside its folder), and until now a view could load images only from its own plugin's folder.

## Decision

- **`hq-cards` is the table.** It owns the `deck` map object, the choice of a game, the seats (kept until a reset, as in chess), the state of each table (`table:<x>,<y>` in `hq.kv`), its log (`log:<x>,<y>`), the window and its view. A table is a free table, or plays a game.
- **Games are plugins that register.** A game calls `hq.plugins.call("hq-cards", "register", definition)` on its first `update()` and in `onPlugins()` when hq-cards starts (calls are refused in `load()`), and `registerCards` for the rest of a deck whose definition is over 4 KB. A definition gives a title, a seat range, the actions it allows from a fixed list, its deck (a part of the standard 54 cards, or its own sheet in `public/shared/` with a name per card), its starting piles, and whether it counts with its own `count` hook. A game never checks moves: it narrows the actions or adds a deck, piles and a count. The first two are `hq-card-pouilleux` (Old Maid) and `hq-card-lastcard` (Last Card, with its own cards).
- **Free placement and a log instead of hidden information.** Every browser at a table gets the whole state and hides what its member should not see (other hands, face-down cards, pile contents). Every action, including looking through a pile, is written in the table's log, shown to everybody at the table, as at a real table. A card seen by one player alone is never named in the log.
- **Views draw other plugins' shared images.** A view's Content Security Policy adds, to `img-src`, the `shared/` folder of every plugin running when the view starts. `public/shared/` is already the part of a plugin meant for others (`hq.loadSprite(..., { from })` on the page). Nothing else of another plugin, no script and no fetch, is reachable. A view started before a game's plugin cannot draw that game's cards, so the Cards window starts its view afresh (drawn once without it) when a game with its own cards arrives.

## Alternatives

- **Each game draws its own window, `hq-cards` only offers functions:** two plugins would share one game (who has the window open, who is told of a change), and every game would redraw cards. Rejected with the user.
- **A cards library copied into each game:** no common deck to choose a game from, and copies drift (imports cannot leave a plugin's folder).
- **Hiding information on the server (each player sent only their hand):** not needed among colleagues; the log keeps players honest. It can be added later without changing games.
- **Relaying a game's images through the page (`hq.ui.post` of image data):** messages are 4 KB; a sheet of 108 cards does not fit, and the browser would fetch it anyway.

## Impact

- **Performance:** one state message (at most 4 KB) per change to the viewers of that table only, one message per drop (none while dragging), the log in its own message (at most 2 KB). A table is at most 3650 bytes of JSON. Not measured: no load or capacity test was run for this change.
- **Maintenance:** the table rules are pure TypeScript (`hq-cards/public/table.ts`, `games.ts`, `log.ts`) covered by web unit tests, the server code by Go tests through the real plugin host, the window by the `cards` and `a11y` browser scenarios.
- **Install:** none. No migration; the three plugins are bundled and start off, like hq-chess.
