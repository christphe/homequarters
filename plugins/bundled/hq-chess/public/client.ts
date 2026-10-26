// Chess plugin, browser side (the hidden iframe). It draws the Chess window when the server opens a board
// (X next to a chessboard), full screen: the seat buttons, Undo, Reset and the board view (public/board.ts), and relays
// between the view and the server. It also pins the playing badge over the head of every present seated
// player (public/badges.png, white or black).
// What the window shows for a state (seat labels, Undo, Reset, the holders' line) is public/window.ts.
import { PROMOTIONS, type Side } from "./game.ts";
import type { BoardState, ToClient, ToServer, ViewIn, ViewOut } from "./messages.ts";
import { holders, resetAllowed, seatButton, undoAllowed } from "./window.ts";

let me = 0;
let open: { x: number; y: number; s: BoardState } | null = null;
const badges = new Map<number, Side>(); // member -> the badge pinned over their head

const send = (m: ToServer) => hq.send(m);
function seat(s: BoardState, side: Side): HQ.UINode {
  const b = seatButton(s, side, me);
  // taken: who holds it, pressed for its holder, never pressable (leaving takes a reset)
  if (!b.free) return hq.ui.button({ label: b.label, pressed: b.pressed, disabled: true });
  const x = open!.x, y = open!.y;
  return hq.ui.button({ label: b.label, disabled: b.disabled, onClick: () => send({ t: "seat", x, y, side }) });
}

function draw(): void {
  if (!open) return;
  const { x, y, s } = open;
  // the whole screen: the buttons on top, then the view, which takes the height left and scales the board
  // to it (public/board.ts); on a short screen the board keeps 2x and the view scrolls
  hq.ui.modal({ title: "Chess", size: "full", onClose: closed }, [
    // one row of buttons (the seats, then Undo and Reset) and the seat holders' line: at 1280x720 the
    // height left lets the board take 3x
    hq.ui.row([
      seat(s, "w"),
      seat(s, "b"),
      // the last action, whoever made it: for a seated player whose window is open (mine is)
      hq.ui.button({ label: "Undo", disabled: !undoAllowed(s, me), onClick: () => send({ t: "undo", x, y }) }),
      hq.ui.button({ label: "Reset", disabled: !resetAllowed(s, me), onClick: () => send({ t: "reset", x, y }) }),
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
