// Chess plugin, browser side (the hidden iframe). It draws the Chess window when the server opens a board
// (X next to a chessboard): the seat buttons, Reset and the board view (public/board.ts), and relays
// between the view and the server. It also pins the playing badge over the head of every present seated
// player (public/badges.png, white or black).
import { canReset, type Board, type Side } from "./game";
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

function draw(): void {
  if (!open) return;
  const { x, y, s } = open;
  const mine: Side | null = s.w?.id === me ? "w" : s.b?.id === me ? "b" : null;
  const board: Board = { p: s.p, w: s.w, b: s.b };
  // who has the board open, as the server says it: the seated players marked here, and me (my window is open)
  const present = new Set<number>([me]);
  for (const seat of [s.w, s.b]) if (seat?.here) present.add(seat.id);
  hq.ui.modal({ title: "Chess", size: "medium", onClose: closed }, [
    hq.ui.row([
      seatButton(s, "w", mine),
      seatButton(s, "b", mine),
      // a spectator is anybody without a seat: pressed then, and out of reach once seated
      hq.ui.button({ label: "Spectate", pressed: mine === null, disabled: mine !== null }),
    ]),
    hq.ui.row([hq.ui.button({ label: "Reset", disabled: !canReset(board, me, present), onClick: () => send({ t: "reset", x, y }) })]),
    hq.ui.view({ view: "board", label: "Chessboard", height: "large", onMessage: fromView }),
  ]);
  const toView: ViewIn = { s, me };
  hq.ui.post(toView);
}

function fromView(m: ViewOut): void {
  if (!open || !m || m.t !== "move" || !Number.isInteger(m.from) || !Number.isInteger(m.to)) return;
  send({ t: "move", x: open.x, y: open.y, from: m.from, to: m.to });
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
  } else if (m.t === "state") {
    if (!open || open.x !== m.x || open.y !== m.y) return;
    open.s = m.s;
  }
  draw();
});
