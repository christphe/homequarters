// Pets plugin, browser side. It runs in a sandboxed iframe and only talks to the page through `hq`:
// the page loads the sheets, draws the pets, walks them, tints them, shows their names on hover and
// draws the plugin's buttons and modal.
import { KINDS, NAME_MAX, type Goal, type Goals, type GuestPet, type MemberPets, type Mode, type PetsMessage, type YouMessage } from "./messages";

const DIRS = ["down", "left", "right", "up"];
// A page draws at most this many of this plugin's sprites (the page allows 256): its own member's
// pets first, then the others' in the order they arrived.
const BUDGET = 240;
// Walking, the first pet keeps 20 px behind its owner and each next one 16 px further back. At rest
// they potter about the owner's feet, 8 to 14 px plus up to ROAM px away, in front or to a side
// (overlapping each other is fine): a crowd of pets still fits at a desk.
const ROAM = 14;
const gap = (i: number) => 20 + 16 * i;
const beside = (i: number) => [10, 8, 13, 11, 14, 9, 12, 10][i % 8];

// While they wander, each pet has a mood that changes about every 5 minutes. The owner's page runs
// the moods and picks the spots; the server relays them and every page walks the pets there, along
// paths around walls. "Home" is where the owner was when they let their pets wander.
type Mood = "explore" | "home" | "owner" | "socialize";
const MOODS: Record<Mood, { near: [number, number]; pause: [number, number]; speed: number }> = {
  explore: { near: [96, 240], pause: [4, 8], speed: 40 }, // long walks around the office, from home
  home: { near: [12, 44], pause: [2.5, 5], speed: 28 }, // pottering about near home
  owner: { near: [16, 40], pause: [1.5, 3.5], speed: 34 }, // staying close to the owner wherever they are
  // tagging along with another wandering pet (anybody's); with none around, it explores
  socialize: { near: [96, 240], pause: [3, 6], speed: 40 },
};
const MOOD_SECONDS = 300;
const between = ([a, b]: [number, number]) => a + Math.random() * (b - a);

// pets.png (their own colours) and pets-tint.png (light greys to tint): 16 x 20 cells, per kind 4
// rows (down, left, right, up) of 3 frames (idle, step A, step B). One sheet key per kind and sheet.
function animsFor(kind: number): HQ.Anims {
  const anims: HQ.Anims = {};
  DIRS.forEach((d, i) => {
    const row = kind * 4 + i;
    anims["walk-" + d] = { row, frames: [1, 0, 2, 0], fps: 8 };
    anims["idle-" + d] = { row, frames: [0], fps: 0 };
  });
  return anims;
}

interface Drawn { key: string; tint: string; gap: number; label: string | null; mode: Mode }
const members = new Map<number, MemberPets>(); // what the server said, in arrival order
const drawn = new Map<string, Drawn>(); // sprite id -> what is on the map
const along = new Map<string, string>(); // sprite id -> the wandering pet it goes along with (socialize)
let me = 0;
let limit = 0;
let modalOpen = false;
// my pets' moods while they wander, by pet id; home is where I let them wander
let wander: { home: [number, number]; pets: Map<string, { mood: Mood; until: number; next: number }> } | null = null;
let clock = 0; // seconds, from onUpdate

const spriteId = (member: number, pet: string) => member + ":" + pet;
// what the colour picker shows for a pet in its own colours (about its body's colour), so any other
// colour, white included, is a change
const BASE = ["#e8964a", "#b98450", "#f2f2f2", "#e8762e", "#f5d03c", "#3fcfb0", "#8a6040", "#f5a0c0", "#a7d97a"];
const kindName = (k: number) => KINDS[k] ?? "Pet";
/** A pet standing, facing us, for the modal: in its own colours, or tinted like on the map. */
const preview = (kind: number, colour: string, scale: number): HQ.SpriteCell =>
  colour ? { src: "pets-tint.png", frame: [0, kind * 80, 16, 20], scale, tint: "#" + colour } : { src: "pets.png", frame: [0, kind * 80, 16, 20], scale };

/** One sprite of a member: one of their pets, or a guest another plugin put with them (setPet hook). */
interface Entry {
  sid: string; // sprite id
  member: number;
  i: number; // place in the member's line
  key: string; // sprite sheet key
  tint: string;
  label: string; // name, or what it is
  mode: Mode;
}

// guests' sheets, loaded on first use: "<plugin>:<sheet>" -> sheet key
const guestSheets = new Map<string, string>();
const SHEETS_LEFT = 32 - 2 * KINDS.length; // the page allows 32 sheets per plugin; the kinds use 18

function guestKey(g: GuestPet): string | null {
  const k = g.from + ":" + g.sheet;
  let key = guestSheets.get(k);
  if (!key) {
    if (guestSheets.size >= SHEETS_LEFT) return null;
    key = "g" + guestSheets.size;
    hq.loadSprite(key, g.sheet, { frameW: g.cell[0], frameH: g.cell[1], anims: animsFor(0), from: g.from });
    guestSheets.set(k, key);
  }
  return key;
}

/** A member's line: their pets first, then their guests. */
function entries(m: MemberPets): Entry[] {
  const out: Entry[] = m.pets.map(([kind, colour, pet, name], i) => ({
    sid: spriteId(m.id, pet), member: m.id, i, key: (colour ? "t" : "n") + kind, tint: colour, label: name || kindName(kind), mode: m.mode,
  }));
  for (const g of items(m.guests)) {
    const key = guestKey(g);
    if (key) out.push({ sid: spriteId(m.id, "x:" + g.from + ":" + g.id), member: m.id, i: out.length, key, tint: "", label: g.name || "Pet", mode: m.mode });
  }
  return out;
}

/** Brings the map in line with `members`, within BUDGET sprites. */
function draw(): void {
  const want = new Map<string, Entry>();
  const order = [...members.values()].sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : 0));
  for (const m of order) {
    for (const e of entries(m)) {
      if (want.size >= BUDGET) break;
      want.set(e.sid, e);
    }
  }
  for (const id of [...drawn.keys()]) {
    if (!want.has(id)) {
      hq.remove(id);
      drawn.delete(id);
      along.delete(id);
    }
  }
  for (const [id, w] of want) {
    const was = drawn.get(id);
    // no position: a new pet appears behind its owner, an existing one keeps its place (new sheet)
    if (was?.key !== w.key) hq.spawn(id, w.key);
    if ((was?.tint ?? "") !== w.tint) hq.setTint(id, w.tint ? "#" + w.tint : null);
    // following walks back to the owner around walls when called from elsewhere; a new pet starts
    // next to its owner even when the others wander; a removed pet moves the next ones up the line
    if (w.mode === "follow" || !was || was.gap !== gap(w.i)) hq.follow(id, w.member, { gap: gap(w.i), beside: beside(w.i), roam: ROAM });
    if (w.mode === "wander" && was && was.mode !== "wander") hq.stop(id); // let wander: stays where it is
    if (w.mode !== "wander") along.delete(id);
    // a wandering pet tells who it is when the mouse is over it: its name (or kind) and its owner
    const label = w.mode === "wander" ? w.label : null;
    if ((was?.label ?? null) !== label) hq.setLabel(id, label, { owner: w.member });
    drawn.set(id, { key: w.key, tint: w.tint, gap: gap(w.i), label, mode: w.mode });
  }
}

const mine = (): MemberPets => members.get(me) ?? { id: me, pets: [], guests: [], mode: "follow" };

function drawControls(): void {
  const m = mine();
  hq.ui.slot("config", "sidebar", { onClick: openModal });
  if (m.pets.length || items(m.guests).length) {
    hq.ui.slot("call", "topbar", {
      label: m.mode === "wander" ? "Call pets" : "Let pets wander",
      onClick: () => hq.send({ t: "mode", m: m.mode === "wander" ? "follow" : "wander" }),
    });
  } else hq.ui.unslot("call");
  if (modalOpen) openModal();
}

function openModal(): void {
  modalOpen = true;
  const m = mine();
  const content: HQ.UINode[] = [];
  if (m.pets.length) {
    content.push(hq.ui.text("Your pets. On a computer, pointing at a wandering pet shows its name.", { muted: true }));
    m.pets.forEach(([kind, colour, , name], i) => {
      // one line per pet: its preview, its name (the placeholder says which pet), its colour; the labels
      // are for screen readers, the line says it all to the eye
      const title = `${kindName(kind)} ${i + 1}`;
      content.push(hq.ui.row([
        hq.ui.sprite({ ...preview(kind, colour, 3), alt: name || title }),
        hq.ui.field({ label: "Name of " + title, hideLabel: true, value: name ?? "", maxLength: NAME_MAX, placeholder: title, onChange: (n) => hq.send({ t: "name", i, n }) }),
        hq.ui.color({ label: "Colour of " + title, hideLabel: true, value: colour ? "#" + colour : BASE[kind] ?? "#ffffff", onChange: (c) => hq.send({ t: "colour", i, c: c.slice(1) }) }),
        ...(colour ? [hq.ui.button({ label: "Reset colour", onClick: () => hq.send({ t: "colour", i, c: "" }) })] : []),
        hq.ui.button({ label: "Remove", onClick: () => hq.send({ t: "remove", i }) }),
      ]));
    });
  } else {
    content.push(hq.ui.text(limit ? "No pets yet. Add one; it follows you around the office." : "Pets are turned off in this office.", { muted: true }));
  }
  if (m.pets.length < limit) {
    content.push(hq.ui.text(`Add a pet (${m.pets.length} of ${limit})`, { muted: true }));
    content.push(hq.ui.row(KINDS.map((label, k) => hq.ui.button({ label, sprite: preview(k, "", 2), onClick: () => hq.send({ t: "add", k }) }))));
  } else if (limit) {
    content.push(hq.ui.text(`You have ${limit} ${limit === 1 ? "pet" : "pets"}, the most this office allows.`, { muted: true }));
  }
  hq.ui.modal({ title: "Pets", size: "large", onClose: () => { modalOpen = false; } }, content);
}

hq.onLoad(() => {
  for (let k = 0; k < KINDS.length; k++) {
    hq.loadSprite("n" + k, "pets.png", { frameW: 16, frameH: 20, anims: animsFor(k) });
    hq.loadSprite("t" + k, "pets-tint.png", { frameW: 16, frameH: 20, anims: animsFor(k) });
  }
  hq.send({ t: "sync" });
});

// the server's messages are typed, but they still come over the network: only trust real arrays
const items = <T>(x: T[] | undefined): T[] => (Array.isArray(x) ? x : []);

hq.onMessage<PetsMessage | YouMessage>((msg) => {
  if (msg.t === "you") {
    limit = typeof msg.limit === "number" ? msg.limit : 0;
    drawControls();
    return;
  }
  if (msg.t !== "pets") return;
  let mineChanged = false;
  for (const m of items(msg.set)) {
    members.set(m.id, { id: m.id, pets: items(m.pets), guests: items(m.guests), mode: m.mode });
    if (m.id === me) mineChanged = true;
  }
  for (const id of items(msg.del)) members.delete(id);
  draw();
  for (const g of items(msg.go)) {
    const m = members.get(g.id);
    if (!m || m.mode !== "wander") continue;
    const line = entries(m);
    items(g.g).forEach((goal: Goal, i) => {
      const id = line[i]?.sid;
      if (!goal || !id || !drawn.has(id)) return;
      if (typeof goal === "string") {
        // go along with that pet; on a page that does not draw it, this one waits where it is
        along.set(id, goal);
        if (goal !== id && drawn.has(goal)) hq.follow(id, { sprite: goal }, { gap: 24, beside: 18 });
        return;
      }
      along.delete(id);
      hq.walkTo(id, goal[0], goal[1], { speed: goal[2] });
    });
  }
  if (mineChanged) {
    if (mine().mode !== "wander") wander = null;
    drawControls();
  }
});

/** Whether the pet with that sprite id is on the map and wandering. */
function wandering(id: string): boolean {
  const member = members.get(Number(id.split(":")[0]));
  return !!member && member.mode === "wander" && drawn.has(id);
}

/** Whether following `to` would close a ring back to `id` (pets following each other in a circle never settle). */
function ring(id: string, to: string): boolean {
  for (let cur: string | undefined = to, n = 0; cur && n < 64; cur = along.get(cur), n++) if (cur === id) return true;
  return false;
}

/** Another wandering pet to go along with: the current one while it still wanders, else one whose own
 * chain of companions does not lead back to this one. */
function companion(id: string): string | null {
  const now = along.get(id);
  if (now && wandering(now) && !ring(id, now)) return now;
  const others = [...drawn.keys()].filter((o) => o !== id && wandering(o) && !ring(id, o));
  return others.length ? others[Math.floor(Math.random() * others.length)] : null;
}

/** A new mood, never the one a pet just had. */
function nextMood(was?: Mood): Mood {
  const all = (Object.keys(MOODS) as Mood[]).filter((m) => m !== was);
  return all[Math.floor(Math.random() * all.length)];
}

hq.onUpdate((dt, world) => {
  clock += dt;
  if (!me && world.me) {
    me = world.me;
    draw(); // my pets go first in the budget
    drawControls();
  }
  const m = members.get(me);
  const line = m ? entries(m) : [];
  if (!m || m.mode !== "wander" || !line.length) return;
  const self = world.avatars.find((a) => a.id === me);
  if (!self) return;
  if (!wander) wander = { home: [self.x, self.y], pets: new Map() };
  // my page picks a spot for each pet whose pause is over, by its mood; one message for them all
  let any = false;
  const goals: Goals = line.map(({ sid }): Goal => {
    let s = wander!.pets.get(sid);
    if (!s) {
      s = { mood: nextMood(), until: clock + MOOD_SECONDS * between([0.3, 1]), next: clock + Math.random() * 2 };
      wander!.pets.set(sid, s);
    }
    if (clock >= s.until) {
      s.mood = nextMood(s.mood);
      s.until = clock + MOOD_SECONDS * between([0.9, 1.1]);
    }
    if (clock < s.next) return null;
    const mood = MOODS[s.mood];
    s.next = clock + between(mood.pause);
    if (s.mood === "socialize") {
      const id = sid, friend = companion(id);
      if (friend && friend === along.get(id)) return null; // still together
      if (friend) {
        any = true;
        return friend;
      }
      // nobody to go along with: explore instead, and look again after this walk
    }
    const [cx, cy] = s.mood === "owner" ? [self.x, self.y] : wander!.home;
    const a = Math.random() * Math.PI * 2, r = between(mood.near);
    any = true;
    return [Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), mood.speed];
  });
  if (any) hq.send({ t: "wander", g: goals });
});
