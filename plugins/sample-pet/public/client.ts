// Sample plugin, browser side. It runs in a sandboxed iframe and only talks to the page through `hq`:
// the page loads the sheet, draws the seedlings, walks them and draws the plugin's buttons and modal.
import type { PetsMessage, PetState } from "./messages";

const COLOURS = ["Meadow", "Blossom", "Ember", "Frost"];
const DIRS = ["down", "left", "right", "up"];
const WANDER_EVERY = 2.5; // seconds between strolls
const WANDER_RADIUS = 40; // px around the spot where the seedling was left

// creatures.png: 16 x 16 cells; per colour 4 rows (down, left, right, up) of 3 frames (idle, step A,
// step B). One sprite sheet key per colour, each with its walk and idle animations.
function animsFor(colour: number): HQ.Anims {
  const anims: HQ.Anims = {};
  DIRS.forEach((d, i) => {
    const row = colour * 4 + i;
    anims["walk-" + d] = { row, frames: [1, 0, 2, 0], fps: 8 };
    anims["idle-" + d] = { row, frames: [0], fps: 0 };
  });
  return anims;
}

type Pet = Omit<PetState, "id">;
const pets = new Map<number, Pet>(); // member id -> what the server said
const drawn = new Map<number, string>(); // member id -> sprite sheet key on the map
let me = 0;
let modalOpen = false;
let wander: { x: number; y: number; next: number } | null = null; // my stroll, around where I left my seedling

function draw(id: number): void {
  const p = pets.get(id);
  const sprite = "pet-" + id;
  if (!p || !p.shown) {
    if (drawn.delete(id)) hq.remove(sprite);
    return;
  }
  const key = "sprout-" + p.v;
  const fresh = !drawn.has(id);
  // no position: a new seedling appears behind its owner, an existing one keeps its place (new colour)
  if (drawn.get(id) !== key) hq.spawn(sprite, key);
  drawn.set(id, key);
  // following walks back to the owner around walls when called from elsewhere;
  // a new seedling starts next to its owner even when it is meant to wander
  if (p.mode === "follow" || fresh) hq.follow(sprite, id, { gap: 36 }); // farther back than a built-in pet (20 px)
  else hq.stop(sprite);
}

const mine = (): Pet => pets.get(me) ?? { v: 0, shown: true, mode: "follow" };

function drawControls(): void {
  const p = mine();
  hq.ui.slot("config", "sidebar", { onClick: openModal });
  hq.ui.slot("call", "topbar", {
    label: p.mode === "wander" ? "Call" : "Let wander",
    onClick: () => hq.send({ t: "mode", m: p.mode === "wander" ? "follow" : "wander" }),
  });
  if (modalOpen) openModal();
}

function openModal(): void {
  modalOpen = true;
  const p = mine();
  hq.ui.modal({ title: "Sample pet", size: "small", onClose: () => { modalOpen = false; } }, [
    hq.ui.text("Your seedling", { muted: true }),
    hq.ui.row([
      hq.ui.button({ label: "Shown", pressed: p.shown, onClick: () => hq.send({ t: "shown", on: true }) }),
      hq.ui.button({ label: "Hidden", pressed: !p.shown, onClick: () => hq.send({ t: "shown", on: false }) }),
    ]),
    hq.ui.text("Colour", { muted: true }),
    hq.ui.row(COLOURS.map((label, v) => hq.ui.button({ label, pressed: p.v === v, onClick: () => hq.send({ t: "variant", v }) }))),
  ]);
}

hq.onLoad(() => {
  for (let v = 0; v < COLOURS.length; v++) hq.loadSprite("sprout-" + v, "creatures.png", { frameW: 16, frameH: 16, anims: animsFor(v) });
  hq.send({ t: "sync" });
});

// the server's message is typed, but it still comes over the network: only trust real arrays
const items = <T>(x: T[] | undefined): T[] => (Array.isArray(x) ? x : []);

hq.onMessage<PetsMessage>((m) => {
  if (m.t !== "pets") return;
  let mineChanged = false;
  for (const p of items(m.set)) {
    pets.set(p.id, { v: p.v, shown: p.shown, mode: p.mode });
    draw(p.id);
    if (p.id === me) mineChanged = true;
  }
  for (const id of items(m.del)) {
    pets.delete(id);
    draw(id);
  }
  for (const g of items(m.go)) if (drawn.has(g.id)) hq.moveTo("pet-" + g.id, g.x, g.y, { speed: 30 });
  if (mineChanged) {
    if (mine().mode !== "wander") wander = null;
    drawControls();
  }
});

hq.onUpdate((dt, world) => {
  if (!me && world.me) {
    me = world.me;
    drawControls();
  }
  // my seedling wanders: my page picks a spot near where I left it, everybody's page walks it there
  const p = pets.get(me);
  if (!p || p.mode !== "wander" || !p.shown) return;
  const self = world.avatars.find((a) => a.id === me);
  if (!wander && self) wander = { x: self.x, y: self.y, next: 0 };
  if (!wander || (wander.next -= dt) > 0) return;
  wander.next = WANDER_EVERY * (0.6 + Math.random() * 0.8);
  const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * (WANDER_RADIUS - 12);
  hq.send({ t: "wander", x: Math.round(wander.x + Math.cos(a) * r), y: Math.round(wander.y + Math.sin(a) * r) });
});
