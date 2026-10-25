// Cards plugin, browser side (the hidden iframe). It draws the Cards window when the server opens a table
// (X next to a deck): the choice of a game while none is chosen; then the seat buttons, the game's table
// actions (shuffle, deal, gather, count, a new pile, offering my hand) and Reset, above the table view
// (public/view.ts). It relays between the view and the server, adding the table's tile to each action.
import { allows, type ClientGame } from "./games.ts";
import { labels } from "./labels.ts";
import { canReset, DEAL_MAX } from "./table.ts";
import type { Act, LogEntry, TableState, ToClient, ToServer, ViewIn } from "./messages.ts";

const NAME_MAX = 24; // a seat's label must stay within a button's 40 characters
const ACTS = new Set(["choose", "seat", "place", "flip", "order", "offer", "pick", "dealAll", "deal", "shuffle", "gather", "count", "reset", "unlook", "newPile", "delPile", "look", "draw", "reorder"]);

let me = 0;
let open: { x: number; y: number } | null = null;
let games: { name: string; title: string }[] = [];
let game: ClientGame | null = null;
let state: TableState | null = null;
let log: LogEntry[] = [];
let dealN = 7;
let pileName = "";
// what the view must be sent again (each in its own message)
const toView = { game: false, state: false, log: false };
// A view may draw the shared/ images of the plugins running when it starts (its security policy is fixed
// then): when a game with its own cards arrives, the view is started afresh once for that game's plugin.
let viewFor = "";
let renewing = false;
let renewals = 0; // fresh views asked by a view that could not load a game's sheet, for this window
let viewShown = false; // the last draw had the view (a new one must be sent everything)

const send = (m: ToServer) => hq.send(m);
const short = (name: string) => {
  const c = [...name];
  return c.length > NAME_MAX ? c.slice(0, NAME_MAX - 1).join("") + "…" : name;
};

function mySeat(): number | null {
  const i = state?.t.seats.findIndex((s) => s?.id === me) ?? -1;
  return i < 0 ? null : i;
}

function act(m: Act): void {
  if (!open) return;
  send({ ...m, x: open.x, y: open.y } as ToServer);
}

/** Where a new pile goes: the first free place of a row along the top of the felt. */
function newPileAt(): [number, number] {
  const taken = state?.t.piles.map((p) => p.at) ?? [];
  for (let i = 0; i < 12; i++) {
    const at: [number, number] = [24 + i * 26, 22];
    if (!taken.some((a) => Math.abs(a[0] - at[0]) < 22 && Math.abs(a[1] - at[1]) < 30)) return at;
  }
  return [160, 22];
}

function seatButtons(s: TableState, mine: number | null): HQ.UINode[] {
  return s.t.seats.map((seat, i) => {
    if (seat) {
      const away = !s.here.includes(seat.id);
      return hq.ui.button({ label: labels.seat(i, seat.name, away), pressed: seat.id === me, disabled: true });
    }
    return hq.ui.button({ label: labels.freeSeat(i), disabled: mine !== null, onClick: () => act({ t: "seat", seat: i }) });
  });
}

/** Who holds each seat, as a line of text: disabled seat buttons are out of the Tab order, this line is not. */
function holders(s: TableState): string {
  const taken = s.t.seats.flatMap((seat, i) => (seat ? [`${i + 1} ${short(seat.name)} (${s.here.includes(seat.id) ? "here" : "away"})`] : []));
  const free = s.t.seats.filter((x) => !x).length;
  const freeText = free === 1 ? "1 seat free" : `${free} seats free`;
  if (!taken.length) return `No seat taken yet · ${freeText}`;
  return `Seats: ${taken.join(" · ")}${free ? ` · ${freeText}` : ""}`;
}

function actions(s: TableState, g: ClientGame, mine: number | null): HQ.UINode[] {
  if (mine === null) {
    const full = s.t.seats.every((x) => x);
    return [hq.ui.text(full ? "Every seat is taken: you watch the game." : "Take a seat to play; anybody else with the window open watches.", { muted: true })];
  }
  const out: HQ.UINode[] = [];
  const stock = s.t.piles[0]?.id;
  const row: HQ.UINode[] = [];
  if (stock && allows(g, "shuffle")) row.push(hq.ui.button({ label: labels.shuffle(s.t.piles[0].name), onClick: () => act({ t: "shuffle", pile: stock }) }));
  if (stock && allows(g, "dealAll")) row.push(hq.ui.button({ label: "Deal all", onClick: () => act({ t: "dealAll", pile: stock }) }));
  if (allows(g, "gather")) row.push(hq.ui.button({ label: "Gather all", onClick: () => act({ t: "gather" }) }));
  if (allows(g, "count")) row.push(hq.ui.button({ label: "Count", onClick: () => act({ t: "count" }) }));
  if (row.length) out.push(hq.ui.row(row));
  if (stock && allows(g, "deal")) {
    out.push(hq.ui.row([
      hq.ui.number({ label: "Cards each", value: dealN, min: 1, max: DEAL_MAX, onChange: (n) => (dealN = n) }),
      hq.ui.button({ label: labels.deal(dealN), onClick: () => act({ t: "deal", pile: stock, n: dealN }) }),
    ]));
  }
  if (allows(g, "createPile")) {
    const ok = !!pileName.trim();
    out.push(hq.ui.row([
      hq.ui.field({ label: "New pile's name", value: pileName, maxLength: 16, onChange: (v) => ((pileName = v), draw()) }),
      hq.ui.button({ label: "New pile face up", disabled: !ok, onClick: () => act({ t: "newPile", name: pileName.trim(), face: "up", at: newPileAt() }) }),
      hq.ui.button({ label: "New pile face down", disabled: !ok, onClick: () => act({ t: "newPile", name: pileName.trim(), face: "down", at: newPileAt() }) }),
    ]));
  }
  if (allows(g, "offer")) {
    const o = s.t.offer;
    if (o?.from === mine) out.push(hq.ui.row([hq.ui.button({ label: labels.withdraw(s.t.seats[o.to]?.name ?? ""), onClick: () => act({ t: "offer", to: null }) })]));
    else if (s.t.hands[mine].length) {
      const to = s.t.seats.flatMap((seat, i) => (seat && i !== mine ? [hq.ui.button({ label: labels.offer(seat.name), onClick: () => act({ t: "offer", to: i }) })] : []));
      if (to.length) out.push(hq.ui.row(to));
    }
  }
  return out;
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
  const content: HQ.UINode[] = [];
  if (!s || s.t.game === null) {
    content.push(hq.ui.text("Choose what to play at this table."));
    content.push(hq.ui.row(games.map((g) => hq.ui.button({ label: g.title, onClick: () => act({ t: "choose", game: g.name }) }))));
  } else if (s.unavailable || !game) {
    content.push(hq.ui.text("This game is not available: its plugin is turned off. Its table is kept for when it comes back."));
    content.push(hq.ui.row([hq.ui.button({ label: "Reset", onClick: () => act({ t: "reset" }) })]));
  } else {
    const mine = mySeat();
    content.push(hq.ui.text(game.title));
    const o = s.t.offer;
    if (o && o.to === mine && mine !== null) content.push(hq.ui.text(`${short(s.t.seats[o.from]?.name ?? "")} offers you their hand: click their name on the table to draw a card.`));
    content.push(hq.ui.row(seatButtons(s, mine)));
    content.push(hq.ui.text(holders(s), { muted: true }));
    content.push(...actions(s, game, mine));
    if (s.t.count) content.push(hq.ui.text(`Count: ${s.t.count}`));
    const present = new Set<number>([me, ...s.here]);
    content.push(hq.ui.row([hq.ui.button({ label: "Reset", disabled: !canReset(s.t, me, present), onClick: () => act({ t: "reset" }) })]));
  }
  // the table's view only once a game is chosen: the choice alone stays short enough to show whole
  const withView = !!s && s.t.game !== null;
  if (withView) content.push(hq.ui.view({ view: "table", label: "Card table", height: "large", onMessage: fromView }));
  if (withView && !viewShown) toView.game = toView.state = toView.log = true;
  viewShown = withView;
  hq.ui.modal({ title: "Cards", size: "large", onClose: closed }, content);
  if (withView) post();
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
