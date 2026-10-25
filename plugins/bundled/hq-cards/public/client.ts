// Cards plugin, browser side (the hidden iframe). It draws the Cards window when the server opens a table
// (X next to a deck): the choice of a game while none is chosen; then, full screen, the table view
// (public/view.ts), which holds the table, its controls and its log. It relays between the view and the
// server, adding the table's tile to each action.
import type { ClientGame } from "./games.ts";
import type { Act, LogEntry, TableState, ToClient, ToServer, ViewIn } from "./messages.ts";

const ACTS = new Set(["choose", "seat", "place", "flip", "order", "offer", "pick", "dealAll", "deal", "shuffle", "gather", "count", "reset", "unlook", "newPile", "delPile", "look", "draw", "reorder", "snap", "moveCards", "movePile", "setAside"]);

let me = 0;
let open: { x: number; y: number } | null = null;
let games: { name: string; title: string }[] = [];
let game: ClientGame | null = null;
let state: TableState | null = null;
let log: LogEntry[] = [];
// what the view must be sent again (each in its own message)
const toView = { game: false, state: false, log: false };
// A view may draw the shared/ images of the plugins running when it starts (its security policy is fixed
// then): when a game with its own cards arrives, the view is started afresh once for that game's plugin.
let viewFor = "";
let renewing = false;
let renewals = 0; // fresh views asked by a view that could not load a game's sheet, for this window
let viewShown = false; // the last draw had the view (a new one must be sent everything)

const send = (m: ToServer) => hq.send(m);

function act(m: Act): void {
  if (!open) return;
  send({ ...m, x: open.x, y: open.y } as ToServer);
}

function draw(): void {
  if (!open) return;
  const s = state;
  if (renewing) {
    // drawn once without the view, which removes its iframe; the next draw starts a new one
    renewing = false;
    hq.ui.modal({ title: "Cards", size: "large", onClose: closed }, [hq.ui.text("Loading the cards…", { muted: true })]);
    viewShown = false;
    setTimeout(() => {
      toView.game = toView.state = toView.log = true;
      draw();
    }, 150);
    return;
  }
  if (!s || s.t.game === null) {
    hq.ui.modal({ title: "Cards", size: "medium", onClose: closed }, [
      hq.ui.text("Choose what to play at this table."),
      hq.ui.row(games.map((g) => hq.ui.button({ label: g.title, onClick: () => act({ t: "choose", game: g.name }) }))),
    ]);
    viewShown = false;
    return;
  }
  if (s.unavailable || !game) {
    hq.ui.modal({ title: "Cards", size: "medium", onClose: closed }, [
      hq.ui.text("This game is not available: its plugin is turned off. Its table is kept for when it comes back."),
      hq.ui.row([hq.ui.button({ label: "Reset", onClick: () => act({ t: "reset" }) })]),
    ]);
    viewShown = false;
    return;
  }
  // a game: the whole screen for the table; its seats, actions and log are in the view (public/panel.ts)
  if (!viewShown) toView.game = toView.state = toView.log = true;
  viewShown = true;
  hq.ui.modal({ title: "Cards", size: "full", onClose: closed }, [hq.ui.view({ view: "table", label: "Card table", height: "full", onMessage: fromView })]);
  post();
}

/** Sends the view what changed, each part in its own message. */
function post(): void {
  if (!open) return;
  const id = `${open.x},${open.y}`;
  if (toView.game) hq.ui.post({ t: "game", g: game, id } satisfies ViewIn);
  if (toView.state && state) hq.ui.post({ t: "state", s: state, me, id } satisfies ViewIn);
  if (toView.log) hq.ui.post({ t: "log", log, id } satisfies ViewIn);
  toView.game = toView.state = toView.log = false;
}

// The view's message: an act, checked for its type only (the server checks the rest), sent with the tile.
function fromView(m: unknown): void {
  if (!open || typeof m !== "object" || m === null) return;
  if ((m as { t?: unknown }).t === "renew") {
    // the page may learn of the game's plugin a moment after the game itself: try again, a few times
    if (renewals++ < 3) setTimeout(() => ((renewing = true), draw()), 1000);
    return;
  }
  if (!ACTS.has((m as Act).t)) return;
  act(m as Act);
}

function closed(): void {
  if (!open) return;
  send({ t: "close", x: open.x, y: open.y });
  open = null;
  viewFor = "";
  renewals = 0;
  viewShown = false;
}

hq.onLoad(() => {
  // the page (re)started: no window of mine is open
  send({ t: "hello" });
});

hq.onUpdate((_dt, world) => {
  if (world.me === me) return;
  me = world.me;
  toView.state = true;
  draw();
});

hq.onMessage<ToClient>((m) => {
  if (!m || typeof m !== "object") return;
  if (m.t === "open") {
    // another table's window was open: that one is closed now
    if (open && (open.x !== m.x || open.y !== m.y)) send({ t: "close", x: open.x, y: open.y });
    if (!open || open.x !== m.x || open.y !== m.y) toView.game = toView.log = true;
    open = { x: m.x, y: m.y };
  }
  if (!open || open.x !== m.x || open.y !== m.y) return;
  if (m.t === "open" || m.t === "state") {
    state = m.s;
    toView.state = true;
  } else if (m.t === "games") {
    games = m.list;
    game = null;
    toView.game = true;
  } else if (m.t === "game") {
    game = m.g;
    toView.game = true;
    const plugin = "plugin" in m.g.deck ? m.g.deck.plugin : "";
    if (plugin && plugin !== viewFor) {
      viewFor = plugin;
      renewing = true;
    }
  } else if (m.t === "log") {
    log = m.log;
    toView.log = true;
  }
  draw();
});
