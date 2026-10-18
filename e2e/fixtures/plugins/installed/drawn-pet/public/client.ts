// Test plugin (e2e): draws, on this page, the sheet of a guest pet it put by metadata (hq-pets' format:
// 4 rows of 3 cells), as a plugin would after fetching pictures it cannot ship. No file, no network.
const CELL = 16;
const SHADES = ["#e06666", "#6fa8dc", "#93c47d", "#f6b26b"];

hq.provideSheet(async (metadata: { shade: number }) => {
  const shade = SHADES[metadata.shade] ?? SHADES[0];
  const c = new OffscreenCanvas(CELL * 3, CELL * 4);
  const g = c.getContext("2d")!;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      g.fillStyle = "#1a1526";
      g.fillRect(col * CELL + 3, row * CELL + 3 - (col ? 1 : 0), 10, 12);
      g.fillStyle = shade;
      g.fillRect(col * CELL + 4, row * CELL + 4 - (col ? 1 : 0), 8, 10);
    }
  }
  return { image: await c.convertToBlob({ type: "image/png" }), frameW: CELL, frameH: CELL };
});

hq.onLoad(() => hq.send({ shade: 2 })); // ask the server for my pet: it calls setPet for me
