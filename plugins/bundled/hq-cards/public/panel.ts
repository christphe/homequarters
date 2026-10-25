// The controls of hq-cards's table view (public/view.ts), as HTML beside the canvas on a wide screen and
// under it on a narrow one: the seats, who holds them, the table's actions the game allows (shuffle the
// stock, deal, gather, count, a new pile, offering my hand), the snapping switch, Reset, the count, a note
// when somebody offers me their hand, and the log. Buttons are rebuilt only when what they show changes,
// so the focus stays on a button that is still there; the two text fields keep what the player typed.
import { allows, type ClientGame } from "./games.ts";
import { labels } from "./labels.ts";
import { sentence, type LogEntry } from "./log.ts";
import type { Act, TableState } from "./messages.ts";
import { canReset, DEAL_MAX } from "./table.ts";

export interface PanelInput { st: TableState; game: ClientGame; me: number; log: LogEntry[]; card: (n: number) => string }

const NAME_MAX = 24;

/** Makes `into`'s children look like `kids`, keeping every element that stays the same kind at the same place
 * (a button also keeps its label: another label is another button). */
function morph(into: Element, kids: Node[]): void {
  kids.forEach((n, k) => {
    const o = into.childNodes[k];
    if (!o) into.append(n);
    else if (o instanceof Text && n instanceof Text) {
      if (o.data !== n.data) o.data = n.data;
    } else if (o instanceof Element && n instanceof Element && o.tagName === n.tagName && o.className === n.className
      && (!(o instanceof HTMLButtonElement) || o.textContent === n.textContent)
      && (!(o instanceof HTMLInputElement) || o.type === (n as HTMLInputElement).type)) patch(o, n);
    else into.replaceChild(n, o);
  });
  while (into.childNodes.length > kids.length) into.lastChild!.remove();
}
function patch(o: Element, n: Element): void {
  if (o instanceof HTMLButtonElement && n instanceof HTMLButtonElement) {
    o.onclick = n.onclick;
    o.disabled = n.disabled;
  } else if (o instanceof HTMLInputElement && n instanceof HTMLInputElement) {
    o.oninput = n.oninput;
    if (o.value !== n.value) o.value = n.value;
    return;
  } else morph(o, [...n.childNodes]);
  if (n.hasAttribute("aria-pressed")) o.setAttribute("aria-pressed", n.getAttribute("aria-pressed")!);
  else o.removeAttribute("aria-pressed");
}
const short = (s: string) => ([...s].length > NAME_MAX ? [...s].slice(0, NAME_MAX - 1).join("") + "…" : s);

export function createPanel(send: (m: Act) => void, newPileAt: () => [number, number]) {
  const root = document.createElement("section");
  root.className = "panel";
  root.setAttribute("aria-label", "Table controls");
  const top = document.createElement("div");
  top.className = "controls";
  const logList = document.createElement("ol");
  logList.className = "log";
  logList.setAttribute("aria-label", "Table log");
  root.append(top, logList);

  let dealN = 7;
  let pileName = "";
  let chosen: string[] = []; // ranks picked to set aside (rank letters of the standard deck, X for the jokers)
  let key = "";
  let logKey = "";

  const button = (label: string, fn: () => void, opts: { pressed?: boolean; disabled?: boolean } = {}) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = fn;
    if (opts.pressed !== undefined) b.setAttribute("aria-pressed", String(opts.pressed));
    if (opts.disabled) b.disabled = true;
    return b;
  };
  const row = (...kids: HTMLElement[]) => {
    const d = document.createElement("div");
    d.className = "row";
    d.append(...kids);
    return d;
  };
  const text = (s: string, cls = "") => {
    const p = document.createElement("p");
    if (cls) p.className = cls;
    p.textContent = s;
    return p;
  };
  const field = (label: string, input: HTMLInputElement) => {
    const l = document.createElement("label");
    l.className = "field";
    l.append(label, input);
    return l;
  };

  function update(i: PanelInput): void {
    const { st, game, me } = i;
    const t = st.t;
    const mine = (() => {
      const k = t.seats.findIndex((s) => s?.id === me);
      return k < 0 ? null : k;
    })();
    const present = new Set<number>([me, ...st.here]);
    const sig = JSON.stringify([t.seats, st.here, t.offer, t.count, t.snap, t.out.length, t.piles[0]?.name, game.allow, game.title, mine, canReset(t, me, present), pileName.trim() !== "", t.hands[mine ?? 0]?.length > 0, chosen]);
    if (sig !== key) {
      key = sig;
      const kids: HTMLElement[] = [];
      const h = document.createElement("h2");
      h.textContent = game.title;
      kids.push(h);
      const o = t.offer;
      if (o && mine !== null && o.to === mine) kids.push(text(`${short(t.seats[o.from]?.name ?? "")} offers you their hand: click their name on the table to draw a card.`, "notice"));
      // seats: a free one can be taken by somebody without a seat; a taken one says who, and whether they are here
      kids.push(row(...t.seats.map((seat, k) => seat
        ? button(labels.seat(k, seat.name, !st.here.includes(seat.id)), () => {}, { pressed: seat.id === me, disabled: true })
        : button(labels.freeSeat(k), () => send({ t: "seat", seat: k }), { disabled: mine !== null }))));
      const taken = t.seats.flatMap((seat, k) => (seat ? [`${k + 1} ${short(seat.name)} (${st.here.includes(seat.id) ? "here" : "away"})`] : []));
      const free = t.seats.filter((x) => !x).length;
      const freeText = free === 1 ? "1 seat free" : `${free} seats free`;
      kids.push(text(taken.length ? `Seats: ${taken.join(" · ")}${free ? ` · ${freeText}` : ""}` : `No seat taken yet · ${freeText}`, "muted"));
      if (mine === null) {
        kids.push(text(t.seats.every((x) => x) ? "Every seat is taken: you watch the game." : "Take a seat to play; anybody else with the window open watches.", "muted"));
        kids.push(text(t.snap ? "Snapping is on." : "Snapping is off.", "muted"));
      } else {
        const stock = t.piles[0];
        const acts: HTMLElement[] = [];
        if (stock && allows(game, "shuffle")) acts.push(button(labels.shuffle(stock.name), () => send({ t: "shuffle", pile: stock.id })));
        if (stock && allows(game, "dealAll")) acts.push(button("Deal all", () => send({ t: "dealAll", pile: stock.id })));
        if (allows(game, "gather")) acts.push(button("Gather all", () => send({ t: "gather" })));
        if (allows(game, "count")) acts.push(button("Count", () => send({ t: "count" })));
        if (acts.length) kids.push(row(...acts));
        if (stock && allows(game, "deal")) {
          const n = document.createElement("input");
          n.type = "number";
          n.min = "1";
          n.max = String(DEAL_MAX);
          n.value = String(dealN);
          n.oninput = (e) => {
            const v = Math.round(Number((e.currentTarget as HTMLInputElement).value)); // the input on the page (a rebuild patches it)
            if (v >= 1 && v <= DEAL_MAX) dealN = v;
          };
          kids.push(row(field("Cards each", n), button("Deal", () => send({ t: "deal", pile: stock.id, n: dealN }))));
        }
        if (allows(game, "createPile")) {
          const f = document.createElement("input");
          f.type = "text";
          f.maxLength = 16;
          f.value = pileName;
          f.oninput = (e) => {
            const was = pileName.trim() !== "";
            pileName = (e.currentTarget as HTMLInputElement).value;
            if (was !== (pileName.trim() !== "")) update(i); // the two buttons enable or disable
          };
          const make = (face: "up" | "down") => () => {
            send({ t: "newPile", name: pileName.trim(), face, at: newPileAt() });
            pileName = "";
            key = "";
            update(i);
          };
          const ok = pileName.trim() !== "";
          kids.push(row(field("New pile", f), button("Face up", make("up"), { disabled: !ok }), button("Face down", make("down"), { disabled: !ok })));
        }
        kids.push(row(button(t.snap ? "Snapping: on" : "Snapping: off", () => send({ t: "snap", on: !t.snap }), { pressed: t.snap })));
        // a smaller deck from the standard one: whole ranks out of the game until a reset
        if (allows(game, "remove") && "standard" in game.deck) {
          const aside = (ranks: string[]) => () => send({ t: "setAsideRanks", ranks });
          kids.push(row(button("Play with 32 cards", aside(["2", "3", "4", "5", "6", "X"])), button("Play with 52 cards", aside(["X"]))));
          kids.push(text("Or set aside every card of these ranks:", "muted"));
          const pick = (r: string) => () => {
            chosen = chosen.includes(r) ? chosen.filter((x) => x !== r) : [...chosen, r];
            update(i);
          };
          const ranks: [string, string][] = [["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"], ["6", "6"], ["7", "7"], ["8", "8"], ["9", "9"], ["T", "10"], ["J", "J"], ["Q", "Q"], ["K", "K"], ["A", "A"], ["X", "Jokers"]];
          kids.push(row(...ranks.map(([r, label]) => button(label, pick(r), { pressed: chosen.includes(r) }))));
          kids.push(row(button("Set the chosen aside", () => {
            send({ t: "setAsideRanks", ranks: chosen });
            chosen = [];
            update(i);
          }, { disabled: !chosen.length })));
        }
        if (allows(game, "offer")) {
          if (o?.from === mine) kids.push(row(button(labels.withdraw(t.seats[o.to]?.name ?? ""), () => send({ t: "offer", to: null }))));
          else if (t.hands[mine]?.length) {
            const to = t.seats.flatMap((seat, k) => (seat && k !== mine ? [button(labels.offer(seat.name), () => send({ t: "offer", to: k }))] : []));
            if (to.length) kids.push(row(...to));
          }
        }
      }
      if (t.out.length) kids.push(text(`${t.out.length} card${t.out.length === 1 ? "" : "s"} set aside until a reset`, "muted"));
      if (t.count) kids.push(text(`Count: ${t.count}`, "count"));
      kids.push(row(button("Reset", () => send({ t: "reset" }), { disabled: !canReset(t, me, present) })));
      // patched in place, not replaced: a click pressed while somebody else's move rebuilds the controls still
      // lands on its button (an element taken out of the page between press and release gets no click), and the
      // focus and what a field holds stay
      morph(top, kids);
    }
    const lines = i.log.map((e) => sentence(e, (s) => t.seats[s]?.name ?? `Seat ${s + 1}`, i.card));
    const lk = lines.join("\n");
    if (lk !== logKey) {
      logKey = lk;
      logList.replaceChildren(...lines.map((s) => Object.assign(document.createElement("li"), { textContent: s })));
      logList.scrollTop = logList.scrollHeight;
    }
  }

  return { root, update, logLines: () => [...logList.children].map((li) => li.textContent ?? "") };
}
