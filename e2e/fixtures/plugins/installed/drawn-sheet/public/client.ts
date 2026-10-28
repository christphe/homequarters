// Test plugin (e2e): its sprite sheet is not a file. It draws one on an OffscreenCanvas, as a plugin
// would after fetching pictures it cannot ship, and hands the page the image data (hq.loadSprite with a
// Blob). A follower walks with each member, and the modal shows a cell of that sheet (hq.ui.sprite).
const CELL = 16;
const SHADES = ["#e06666", "#6fa8dc", "#93c47d", "#f6b26b"]; // one colour per facing: down, left, right, up

async function sheet(): Promise<Blob> {
  const c = new OffscreenCanvas(CELL * 3, CELL * 4);
  const g = c.getContext("2d")!;
  SHADES.forEach((shade, row) => {
    for (let col = 0; col < 3; col++) {
      g.fillStyle = "#1a1526";
      g.fillRect(col * CELL + 3, row * CELL + 3 - (col ? 1 : 0), 10, 12);
      g.fillStyle = shade;
      g.fillRect(col * CELL + 4, row * CELL + 4 - (col ? 1 : 0), 8, 10);
    }
  });
  return c.convertToBlob({ type: "image/png" });
}

const anims: HQ.Anims = {};
["down", "left", "right", "up"].forEach((d, row) => {
  anims["walk-" + d] = { row, frames: [1, 0, 2, 0], fps: 8 };
  anims["idle-" + d] = { row, frames: [0], fps: 0 };
});

let started = false;
hq.onLoad(() => void load());
async function load() {
  hq.loadSprite("drawn", await sheet(), { frameW: CELL, frameH: CELL, anims });
  // not an image: refused when the page decodes it, and the plugin goes on
  hq.loadSprite("bogus", new Blob(["not a picture"], { type: "text/plain" }), { frameW: CELL, frameH: CELL });
  hq.ui.slot("open", "sidebar", {
    onClick: () => hq.ui.modal({ title: "Drawn sheet" }, [hq.ui.sprite({ sheet: "drawn", frame: [0, 0, CELL, CELL], scale: 3, alt: "A drawn creature" })]),
  });
}

hq.onUpdate((_dt, world) => {
  if (started || !world.me) return;
  started = true;
  for (const a of world.avatars) {
    hq.spawn("d" + a.id, "drawn");
    hq.follow("d" + a.id, a.id, { gap: 20 });
  }
});
