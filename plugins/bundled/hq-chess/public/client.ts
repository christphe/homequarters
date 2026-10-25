// Chess plugin, browser side (the hidden iframe). It draws the Chess window when the server opens a board
// (X next to a chessboard), full screen: the seat buttons, Undo, Reset and the board view (public/board.ts), and relays
// between the view and the server. It also pins the playing badge over the head of every present seated
// player (public/badges.png, white or black).
import { canReset, PROMOTIONS, type Board, type Side } from "./game";
import type { BoardState, ToClient, ToServer, ViewIn, ViewOut } from "./messages";

const NAME_MAX = 24; // a seat's label must stay within a button's 40 characters
let me = 0;
let open: { x: number; y: number; s: BoardState } | null = null;
const badges = new Map<number, Side>(); // member -> the badge pinned over their head

const send = (m: ToServer) => hq.send(m);
const short = (name: string) => {
  const c = [...name];
  return c.length > NAME_MAX ? c.slice(0, NAME_MAX - 1).join("") + "…" : name;
};
const sideName = (s: Side) => (s === "w" ? "White" : "Black");

function seatButton(s: BoardState, side: Side, mine: Side | null): HQ.UINode {
  const seat = s[side];
  if (seat) {
    // taken: who holds it and whether they have the board open; never pressable (leaving takes a reset)
    const label = `${sideName(side)}: ${short(seat.name)}${seat.here ? "" : " (away)"}`;
    return hq.ui.button({ label, pressed: seat.id === me, disabled: true });
  }
  const x = open!.x, y = open!.y;
  return hq.ui.button({ label: sideName(side), disabled: mine !== null, onClick: () => send({ t: "seat", x, y, side }) });
}

/** Who holds each seat, as a line of text: disabled seat buttons are out of the Tab order, this line is not. */
function holders(s: BoardState): string {
  const one = (side: Side) => {
    const seat = s[side];
    return `${sideName(side)}: ${seat ? `${short(seat.name)} (${seat.here ? "here" : "away"})` : "free"}`;
  };
  return `${one("w")} · ${one("b")}`;
}

function draw(): void {
  if (!open) return;
  const { x, y, s } = open;
  const mine: Side | null = s.w?.id === me ? "w" : s.b?.id === me ? "b" : null;
  const board: Board = { p: s.p, w: s.w, b: s.b, r: s.r };
  // who has the board open, as the server says it: the seated players marked here, and me (my window is open)
  const present = new Set<number>([me]);
  for (const seat of [s.w, s.b]) if (seat?.here) present.add(seat.id);
  // the whole screen: the buttons on top, then the view, which takes the height left and scales the board
  // to it (public/board.ts); on a short screen the board keeps 2x and the view scrolls
  hq.ui.modal({ title: "Chess", size: "full", onClose: closed }, [
    // one row of buttons (the seats, then Undo and Reset) and the seat holders' line: at 1280x720 the
    // height left lets the board take 3x
    hq.ui.row([
      seatButton(s, "w", mine),
      seatButton(s, "b", mine),
      // the last action, whoever made it: for a seated player whose window is open (mine is)
      hq.ui.button({ label: "Undo", disabled: !(s.u && mine !== null), onClick: () => send({ t: "undo", x, y }) }),
      hq.ui.button({ label: "Reset", disabled: !canReset(board, me, present), onClick: () => send({ t: "reset", x, y }) }),
    ]),
    hq.ui.text(holders(s), { muted: true }),
    hq.ui.view({ view: "board", label: "Chessboard", height: "full", onMessage: fromView }),
  ]);
  const toView: ViewIn = { s, me, id: `${x},${y}` };
  hq.ui.post(toView);
}

// The view's message, checked for shape only (the server checks the rules), one message to the server each.
function fromView(m: ViewOut): void {
  if (!open || !m || typeof m !== "object") return;
  const { x, y } = open;
  const int = Number.isInteger;
  if (m.t === "move" && int(m.from) && int(m.to)) {
    if (m.promote === undefined) send({ t: "move", x, y, from: m.from, to: m.to });
    else if ((PROMOTIONS as readonly string[]).includes(m.promote)) send({ t: "move", x, y, from: m.from, to: m.to, promote: m.promote });
  } else if (m.t === "place" && typeof m.piece === "string" && m.piece.length === 1 && int(m.to)) send({ t: "place", x, y, piece: m.piece, to: m.to });
  else if (m.t === "stash" && int(m.from)) send({ t: "stash", x, y, from: m.from });
}

function closed(): void {
  if (!open) return;
  send({ t: "close", x: open.x, y: open.y });
  open = null;
}

function playing(list: { id: number; side: Side }[]): void {
  const now = new Map(list.map((e) => [e.id, e.side]));
  for (const id of badges.keys()) {
    if (now.has(id)) continue;
    hq.remove("badge-" + id);
    badges.delete(id);
  }
  for (const [id, side] of now) {
    if (badges.get(id) === side) continue;
    if (badges.has(id)) hq.setAnim("badge-" + id, side);
    else {
      hq.spawn("badge-" + id, "badges", { anim: side });
      hq.attach("badge-" + id, id);
    }
    badges.set(id, side);
  }
}

hq.onLoad(() => {
  hq.loadSprite("badges", "badges.png", { frameW: 7, frameH: 9, anims: { w: { row: 0, frames: [0], fps: 0 }, b: { row: 0, frames: [1], fps: 0 } } });
  // the page (re)started: no window of mine is open, wherever I was seated
  send({ t: "hello" });
});

hq.onUpdate((_dt, world) => {
  if (world.me === me) return;
  me = world.me;
  draw();
});

hq.onMessage<ToClient>((m) => {
  if (m.t === "playing") return playing(m.list);
  if (m.t === "open") {
    // another board's window was open: that one is closed now
    if (open && (open.x !== m.x || open.y !== m.y)) send({ t: "close", x: open.x, y: open.y });
    open = { x: m.x, y: m.y, s: m.s };
    // the window is drawn: say so (if the plugin started after X was pressed, the hello came after the open)
    send({ t: "opened", x: m.x, y: m.y });
  } else if (m.t === "state") {
    if (!open || open.x !== m.x || open.y !== m.y) return;
    open.s = m.s;
  }
  draw();
});
