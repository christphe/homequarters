import type { MapData, Prop } from "../../net/protocol";
import { OUT, blob, dark, hash, light, px, slab, type Ctx } from "./pixel";

export const T = 16;

// ---------- floors ----------
interface Floor {
  kind: "planks" | "carpet" | "plate" | "hatch";
  a: string;
  b: string;
  seam: string;
  edge: string;
  trim: string; // colour of the stripe on the wall face above this floor
}
// The names come from the server's map data; the look is decided here.
const FLOORS: Record<string, Floor> = {
  wood_light: { kind: "plate", a: "#f8f0be", b: "#f2e8ae", seam: "#d2c486", edge: "#b8aa68", trim: "#e8603c" },
  wood_warm: { kind: "planks", a: "#dcb658", b: "#d2ac4c", seam: "#a88434", edge: "#8a6a28", trim: "#f09030" },
  carpet_blue: { kind: "hatch", a: "#eaf2fa", b: "#dce8f4", seam: "#b4c4d8", edge: "#7890b8", trim: "#4a78d0" },
  carpet_teal: { kind: "carpet", a: "#52b0a0", b: "#4aa898", seam: "#3c9484", edge: "#2a7468", trim: "#2a9c90" },
  carpet_plum: { kind: "carpet", a: "#9a70b4", b: "#9068ac", seam: "#7c58a0", edge: "#5e4280", trim: "#8a52b0" },
  carpet_green: { kind: "carpet", a: "#62b070", b: "#5aa868", seam: "#4c9458", edge: "#367a44", trim: "#3c9c50" },
  desk_mat: { kind: "carpet", a: "#8fa6c6", b: "#889fc0", seam: "#7a90b2", edge: "#5a6e96", trim: "#4a6088" }, // an assigned desk's space
  tile_gray: { kind: "plate", a: "#d8dce8", b: "#d0d4e2", seam: "#b0b6ca", edge: "#9aa0b8", trim: "#7a7ab0" },
};

function floorTile(ctx: Ctx, f: Floor, tx: number, ty: number) {
  const x = tx * T, y = ty * T;
  if (f.kind === "planks") {
    // two wide 8px planks per tile, each with its own staggered end joint
    for (let i = 0; i < 2; i++) {
      const row = ty * 2 + i;
      const shade = hash(tx, row, 1) < 0.4 ? f.b : f.a;
      px(ctx, x, y + i * 8, T, 8, shade);
      px(ctx, x, y + i * 8, T, 1, light(shade, 0.2));
      px(ctx, x, y + i * 8 + 7, T, 1, f.seam);
      const j = Math.floor(hash(tx, row, 2) * 13) + 2;
      px(ctx, x + j, y + i * 8, 1, 8, f.seam);
      px(ctx, x + j + 1, y + i * 8 + 1, 1, 6, light(shade, 0.12));
      if (hash(tx, row, 3) < 0.35) px(ctx, x + ((j + 7) % 13) + 1, y + i * 8 + 3, 2, 1, dark(shade, 0.14));
    }
  } else if (f.kind === "carpet") {
    px(ctx, x, y, T, T, f.a);
    for (let yy = 0; yy < T; yy++)
      for (let xx = 0; xx < T; xx++) {
        if ((xx + yy) % 2 === 0 && hash(tx * T + xx, ty * T + yy, 4) < 0.5) px(ctx, x + xx, y + yy, 1, 1, f.b);
      }
    for (let i = 0; i < 3; i++) {
      const hx = Math.floor(hash(tx, ty, 10 + i) * 14), hy = Math.floor(hash(tx, ty, 20 + i) * 14);
      px(ctx, x + hx, y + hy, 2, 1, light(f.a, 0.12));
    }
  } else if (f.kind === "hatch") {
    // pale lab floor with fine diagonal hatching
    px(ctx, x, y, T, T, f.a);
    for (let yy = 0; yy < T; yy++)
      for (let xx = 0; xx < T; xx++) if ((xx + yy) % 8 === 0) px(ctx, x + xx, y + yy, 1, 1, f.b);
    px(ctx, x, y + T - 1, T, 1, f.seam);
    px(ctx, x + T - 1, y, 1, T, f.seam);
    px(ctx, x, y, T - 1, 1, "#ffffff");
    px(ctx, x, y + 1, 1, T - 3, light(f.a, 0.5));
  } else {
    // beveled plate: lit top-left edge, darker joint lines, a dot where four plates meet
    px(ctx, x, y, T, T, f.a);
    px(ctx, x, y + T - 1, T, 1, f.seam);
    px(ctx, x + T - 1, y, 1, T, f.seam);
    px(ctx, x, y, T - 1, 1, light(f.a, 0.5));
    px(ctx, x, y + 1, 1, T - 3, light(f.a, 0.3));
    px(ctx, x + T - 2, y + T - 2, 1, 1, dark(f.seam, 0.2));
    px(ctx, x + 2, y + 2, 5, 1, light(f.a, 0.35));
    px(ctx, x + 2, y + 3, 1, 3, light(f.a, 0.2));
  }
}

// ---------- walls ----------
const WALL = {
  cap: "#544c78", capHi: "#6a6294",
  cream: "#f2e6bc", creamHi: "#fff8dc", creamSeam: "#e2d2a2",
  line: "#5a4a48", wain: "#c9a86e", wainHi: "#dcc088", base: "#8c6c48",
};

function wallTile(ctx: Ctx, tx: number, ty: number, isWall: (x: number, y: number) => boolean, trim: string) {
  const x = tx * T, y = ty * T;
  const below = isWall(tx, ty + 1);
  if (!below) {
    // banded wall face: cream upper wall, coloured stripe, wooden wainscot and baseboard
    px(ctx, x, y, T, T, WALL.cream);
    px(ctx, x, y, T, 1, WALL.creamHi);
    for (const sx of [0, 8]) {
      px(ctx, x + sx, y + 1, 1, 5, WALL.creamSeam);
      px(ctx, x + sx + 1, y + 1, 1, 5, light(WALL.cream, 0.25));
    }
    px(ctx, x, y + 6, T, 1, WALL.line);
    px(ctx, x, y + 7, T, 3, trim);
    px(ctx, x, y + 7, T, 1, light(trim, 0.35));
    px(ctx, x, y + 9, T, 1, dark(trim, 0.3));
    px(ctx, x, y + 10, T, 1, WALL.line);
    px(ctx, x, y + 11, T, 3, WALL.wain);
    px(ctx, x, y + 11, T, 1, WALL.wainHi);
    for (const sx of [3, 11]) px(ctx, x + sx, y + 12, 1, 2, dark(WALL.wain, 0.2));
    px(ctx, x, y + 14, T, 1, WALL.base);
    px(ctx, x, y + 15, T, 1, OUT);
  } else {
    px(ctx, x, y, T, T, WALL.cap);
    for (let i = 0; i < 6; i++) {
      const hx = Math.floor(hash(tx, ty, 30 + i) * 15), hy = Math.floor(hash(tx, ty, 40 + i) * 15);
      px(ctx, x + hx, y + hy, 1, 1, WALL.capHi);
    }
  }
  // outline along edges that face open floor
  if (!isWall(tx - 1, ty)) px(ctx, x, y, 1, below ? T : T - 1, OUT);
  if (!isWall(tx + 1, ty)) px(ctx, x + T - 1, y, 1, below ? T : T - 1, OUT);
  if (!isWall(tx, ty - 1)) px(ctx, x, y, T, 1, OUT);
}

function windowDeco(ctx: Ctx, tx: number, ty: number) {
  const x = tx * T, y = ty * T;
  px(ctx, x + 2, y + 2, 12, 9, OUT);
  px(ctx, x + 3, y + 3, 10, 7, "#94d2f2");
  px(ctx, x + 3, y + 3, 10, 2, "#b8e6fa");
  px(ctx, x + 8, y + 3, 1, 7, "#f2f6fa");
  px(ctx, x + 3, y + 6, 10, 1, "#f2f6fa");
  px(ctx, x + 4, y + 4, 2, 1, "#ffffff");
  px(ctx, x + 2, y + 11, 12, 1, light(WALL.cream, 0.4));
}
function posterDeco(ctx: Ctx, tx: number, ty: number) {
  const x = tx * T, y = ty * T;
  const cols = ["#e8685a", "#f2b84a", "#58b8a0", "#6a8ede", "#b878d0"];
  const c = cols[Math.floor(hash(tx, ty, 50) * cols.length)];
  px(ctx, x + 4, y + 2, 8, 9, OUT);
  px(ctx, x + 5, y + 3, 6, 7, "#f6f2e6");
  px(ctx, x + 6, y + 4, 4, 3, c);
  px(ctx, x + 6, y + 8, 4, 1, dark("#f6f2e6", 0.25));
}

// ---------- props ----------
const WOOD = "#c08a52";
// A monitor seen from the front, from the top of its screen (top) down to its foot (top + 12): the foot
// sits right under the screen.
function screenFront(ctx: Ctx, cx: number, top: number) {
  px(ctx, cx - 7, top, 14, 10, OUT);
  px(ctx, cx - 6, top + 1, 12, 8, "#3a4262"); // bezel
  px(ctx, cx - 5, top + 2, 10, 6, "#5cc4e6");
  px(ctx, cx - 5, top + 2, 10, 2, "#8ee0f6");
  px(ctx, cx - 4, top + 2, 2, 1, "#e2fbff");
  px(ctx, cx - 3, top + 5, 5, 1, "#3a9cc4"); // a window on the screen
  px(ctx, cx - 3, top + 6, 3, 1, "#3a9cc4");
  px(ctx, cx - 3, top + 10, 6, 2, OUT); // foot
  px(ctx, cx - 2, top + 10, 4, 1, "#8a92ac");
}
// The same monitor seen from behind.
function screenBack(ctx: Ctx, cx: number, top: number) {
  px(ctx, cx - 7, top, 14, 10, OUT);
  px(ctx, cx - 6, top + 1, 12, 8, "#8c93ab");
  px(ctx, cx - 6, top + 1, 12, 1, "#b4bace");
  px(ctx, cx - 4, top + 3, 8, 1, "#737a94"); // vents
  px(ctx, cx - 4, top + 5, 8, 1, "#737a94");
  px(ctx, cx - 2, top + 7, 4, 2, "#646b86"); // the stand's mount
  px(ctx, cx - 3, top + 10, 6, 2, OUT);
  px(ctx, cx - 2, top + 10, 4, 1, "#8a92ac");
}
// A keyboard in a full outline, 4 px tall, its mouse on the user's right: on our right when they face
// away from us, on our left when they face us.
function keyboard(ctx: Ctx, cx: number, y: number, mouse: "right" | "left") {
  px(ctx, cx - 5, y, 10, 4, OUT);
  px(ctx, cx - 4, y + 1, 8, 2, "#eceef6");
  for (let k = 0; k < 4; k++) px(ctx, cx - 3 + k * 2, y + 2, 1, 1, "#b4b8cc");
  const mx = mouse === "right" ? cx + 6 : cx - 9;
  px(ctx, mx, y, 3, 4, OUT);
  px(ctx, mx + 1, y + 1, 1, 2, "#eceef6");
}
// Every desk has the same body. Seen from the front, it rises above its tile by its own height: 6 px for
// the top, its 2 px edge and the legs. Drawn back to front, a desk below covers exactly the edge and legs
// of the desk it is pushed against.
const DESK_RISE = 6;
function deskBody(ctx: Ctx, x: number, y: number, w: number) {
  slab(ctx, x, y - DESK_RISE, w, T + 3, WOOD, 2);
  for (const lx of [x + 1, x + w - 3]) {
    px(ctx, lx, y + 13, 2, 3, OUT);
    px(ctx, lx, y + 13, 1, 2, "#7c4c28");
  }
}
// The desks of an island mirror each other across the line where they meet: 2 px from the user's edge
// to the keyboard, 2 px from the keyboard to the screen's foot. Seat below: the screen faces us.
// A desk without a pc prop on it (a map saved before PCs existed) still draws its own.
function desk(ctx: Ctx, x: number, y: number, w: number, withPC: boolean) {
  deskBody(ctx, x, y, w);
  if (hash(x, y, 70) < 0.5) {
    const mx = hash(x, y, 71) < 0.5 ? x + 3 : x + w - 6; // a mug
    px(ctx, mx, y - 3, 3, 4, OUT);
    px(ctx, mx + 1, y - 2, 1, 2, hash(x, y, 72) < 0.5 ? "#e8685a" : "#f6f2e6");
  }
  if (!withPC) pcFront(ctx, x + w / 2, y);
}
// A computer on a desk whose top is at y, centred on cx. Facing us: its screen, foot at y - 1..y, then
// its keyboard (the edge's line is at y + 10).
function pcFront(ctx: Ctx, cx: number, y: number) {
  screenFront(ctx, cx, y - 11);
  keyboard(ctx, cx, y + 4, "right");
}
// The same on a turned desk: the keyboard on the far side, the back of the screen rising over it (foot
// at y + 5..y + 6).
function pcBack(ctx: Ctx, cx: number, y: number) {
  keyboard(ctx, cx, y - 3, "left");
  screenBack(ctx, cx, y - 5);
}
function chair(ctx: Ctx, x: number, y: number) {
  px(ctx, x + 4, y + 13, 8, 2, "rgba(40,24,80,0.2)");
  px(ctx, x + 4, y + 1, 8, 7, OUT);
  px(ctx, x + 5, y + 2, 6, 5, "#4a5f9c");
  px(ctx, x + 5, y + 2, 6, 1, "#7088c4");
  px(ctx, x + 3, y + 8, 10, 4, OUT);
  px(ctx, x + 4, y + 9, 8, 2, "#5e76b4");
  px(ctx, x + 7, y + 12, 2, 2, OUT);
  px(ctx, x + 4, y + 14, 3, 1, OUT);
  px(ctx, x + 9, y + 14, 3, 1, OUT);
}
// A chair seen from behind: its occupant faces the desk or table above it.
function chairBack(ctx: Ctx, x: number, y: number) {
  px(ctx, x + 4, y + 13, 8, 2, "rgba(40,24,80,0.2)");
  px(ctx, x + 4, y + 2, 8, 11, OUT); // the backrest hides the seat
  px(ctx, x + 5, y + 3, 6, 9, "#4a5f9c");
  px(ctx, x + 5, y + 3, 6, 1, "#7088c4");
  px(ctx, x + 6, y + 5, 4, 5, "#3e5088");
  px(ctx, x + 7, y + 13, 2, 1, OUT);
  px(ctx, x + 4, y + 14, 3, 1, OUT);
  px(ctx, x + 9, y + 14, 3, 1, OUT);
}
function plant(ctx: Ctx, x: number, y: number) {
  px(ctx, x + 3, y + 14, 10, 2, "rgba(40,24,80,0.22)");
  blob(ctx, x + 8, y + 5.5, 5.5, 4.5, "#3f9c56");
  blob(ctx, x + 5, y + 8, 3, 2.5, "#2e8148");
  blob(ctx, x + 11, y + 7, 3, 2.5, "#5cbc6c");
  px(ctx, x + 6, y + 3, 2, 1, "#9ce29a");
  px(ctx, x + 10, y + 5, 1, 1, "#9ce29a");
  px(ctx, x + 4, y + 10, 8, 6, OUT);
  px(ctx, x + 5, y + 11, 6, 4, "#c8683c");
  px(ctx, x + 4, y + 10, 8, 2, "#a8502c");
  px(ctx, x + 5, y + 10, 6, 1, "#e48c5a");
  px(ctx, x + 5, y + 11, 1, 4, "#dc7c4c");
}
function couch(ctx: Ctx, x: number, y: number, w: number) {
  // blue bench with yellow seat cushions
  px(ctx, x + 1, y + 14, w - 2, 2, "rgba(40,24,80,0.22)");
  px(ctx, x, y + 1, w, 7, OUT);
  px(ctx, x + 1, y + 2, w - 2, 5, "#4a78d0");
  px(ctx, x + 1, y + 2, w - 2, 1, "#8ab0f4");
  px(ctx, x + 1, y + 6, w - 2, 1, "#3058a8");
  px(ctx, x + 3, y + 7, w - 6, 7, OUT);
  px(ctx, x + 4, y + 8, w - 8, 5, "#f4cc48");
  px(ctx, x + 4, y + 8, w - 8, 1, "#fff09a");
  px(ctx, x + 4, y + 12, w - 8, 1, "#c89c28");
  for (let sx = 16; sx < w - 4; sx += 16) px(ctx, x + sx, y + 8, 1, 5, "#c89c28");
  px(ctx, x, y + 4, 4, 11, OUT);
  px(ctx, x + 1, y + 5, 2, 9, "#3a68c0");
  px(ctx, x + 1, y + 5, 2, 1, "#8ab0f4");
  px(ctx, x + w - 4, y + 4, 4, 11, OUT);
  px(ctx, x + w - 3, y + 5, 2, 9, "#3058a8");
  px(ctx, x + w - 3, y + 5, 2, 1, "#8ab0f4");
}
function table(ctx: Ctx, x: number, y: number, w: number, h: number, low = false) {
  px(ctx, x + 2, y + h - 2, w - 4, 2, "rgba(40,24,80,0.22)");
  // legs under the front edge, at the corners; a coffee table's are short
  const legH = low ? 2 : 4;
  slab(ctx, x, y + 2, w, h - 1 - legH, "#d8a86c", low ? 3 : 4);
  for (const lx of [x + 2, x + w - 4]) {
    px(ctx, lx, y + h - legH, 2, legH, OUT);
    if (!low) px(ctx, lx, y + h - legH, 1, legH - 1, "#8a5c32");
  }
  // a few things on top so meeting rooms feel used
  for (let i = 0; i < Math.floor(w / 16); i++) {
    const px0 = x + 5 + i * 14 + Math.floor(hash(x, i, 7) * 3);
    const py0 = y + 5 + Math.floor(hash(y, i, 8) * 4);
    if (h >= 24) {
      px(ctx, px0, py0, 6, 4, OUT);
      px(ctx, px0 + 1, py0 + 1, 4, 2, i % 2 ? "#f4f4f8" : "#8ad4ee");
    }
  }
}
function reception(ctx: Ctx, x: number, y: number, w: number) {
  px(ctx, x + 2, y + 14, w - 4, 2, "rgba(40,24,80,0.22)");
  px(ctx, x, y + 2, w, 13, OUT);
  px(ctx, x + 1, y + 3, w - 2, 5, "#fff6dc"); // cream top
  px(ctx, x + 1, y + 3, w - 2, 1, "#ffffff");
  px(ctx, x + 1, y + 7, w - 2, 1, "#d8c8a0");
  px(ctx, x + 1, y + 8, w - 2, 6, "#e8603c"); // coral front
  px(ctx, x + 1, y + 8, w - 2, 1, "#f89070");
  px(ctx, x + 1, y + 13, w - 2, 1, "#b8402a");
  for (let sx = 16; sx < w - 1; sx += 16) {
    px(ctx, x + sx, y + 9, 1, 4, "#b8402a");
    px(ctx, x + sx + 1, y + 9, 1, 4, "#f47c58");
  }
  // bell and monitor
  px(ctx, x + w / 2 - 3, y + 1, 6, 3, OUT);
  px(ctx, x + w / 2 - 2, y + 1, 4, 2, "#ffc84a");
  px(ctx, x + w - 22, y - 1, 10, 7, OUT);
  px(ctx, x + w - 21, y, 8, 5, "#7ad6f0");
  px(ctx, x + w - 21, y, 8, 1, "#c8f4ff");
}
function bookshelf(ctx: Ctx, x: number, y: number, w: number) {
  px(ctx, x, y, w, 16, OUT);
  px(ctx, x + 1, y + 1, w - 2, 14, "#4e3220");
  const books = ["#e05a50", "#4a86d8", "#f0c84a", "#58b868", "#8a62cc", "#f09a3a", "#e8e4d8"];
  for (let row = 0; row < 2; row++) {
    let bx = x + 2;
    const base = y + 7 + row * 7;
    let i = 0;
    while (bx < x + w - 3) {
      const bw = 2 + Math.floor(hash(bx, row, 5) * 2);
      const bh = 4 + Math.floor(hash(bx, row, 6) * 3);
      if (hash(bx, row, 9) > 0.08) {
        px(ctx, bx, base - bh, bw, bh, books[(i + row * 3) % books.length]);
        px(ctx, bx, base - bh, 1, bh, light(books[(i + row * 3) % books.length], 0.3));
      }
      bx += bw;
      i++;
    }
    px(ctx, x + 1, base, w - 2, 1, "#8e5c36");
  }
  px(ctx, x + 1, y + 1, w - 2, 1, "#7a5232");
}
function coffee(ctx: Ctx, x: number, y: number) {
  px(ctx, x + 3, y + 14, 10, 2, "rgba(40,24,80,0.22)");
  px(ctx, x + 3, y, 10, 15, OUT);
  px(ctx, x + 4, y + 1, 8, 13, "#8c94ac");
  px(ctx, x + 4, y + 1, 8, 2, "#b4bcd0");
  px(ctx, x + 5, y + 3, 6, 3, "#1e2a3c");
  px(ctx, x + 9, y + 4, 1, 1, "#58e070");
  px(ctx, x + 6, y + 7, 4, 3, OUT);
  px(ctx, x + 6, y + 10, 4, 3, "#f6f2e6");
  px(ctx, x + 6, y + 10, 4, 1, "#c8c4b6");
  px(ctx, x + 11, y + 3, 1, 1, "#e85a50");
}
function whiteboard(ctx: Ctx, x: number, y: number, w: number) {
  px(ctx, x + 1, y + 1, w - 2, 13, OUT);
  px(ctx, x + 2, y + 2, w - 4, 10, "#f6f8fc");
  px(ctx, x + 2, y + 11, w - 4, 1, "#d6dae6");
  const cols = ["#e05a50", "#4a86d8", "#58b868"];
  for (let i = 0; i < 4; i++) {
    const lw = 8 + Math.floor(hash(x, i, 11) * (w - 22));
    px(ctx, x + 4, y + 3 + i * 2, lw, 1, cols[i % 3]);
  }
  px(ctx, x + w - 9, y + 4, 4, 4, "#f2b84a");
  px(ctx, x + 1, y + 14, w - 2, 1, "#9aa0b4");
}
function lamp(ctx: Ctx, x: number, y: number) {
  px(ctx, x + 3, y + 1, 10, 7, "rgba(255,226,122,0.16)");
  px(ctx, x + 4, y + 2, 8, 5, OUT);
  px(ctx, x + 5, y + 3, 6, 3, "#ffe27a");
  px(ctx, x + 5, y + 3, 6, 1, "#fff4b8");
  px(ctx, x + 7, y + 7, 2, 7, OUT);
  px(ctx, x + 5, y + 14, 6, 2, OUT);
  px(ctx, x + 6, y + 14, 4, 1, "#6a6f88");
}
function rug(ctx: Ctx, x: number, y: number, w: number, h: number) {
  // green rug with a dotted border band and a scattered-dot field
  px(ctx, x, y, w, h, "#1e4a30");
  px(ctx, x + 1, y + 1, w - 2, h - 2, "#3c8c58");
  px(ctx, x + 2, y + 2, w - 4, h - 4, "#78c886");
  px(ctx, x + 4, y + 4, w - 8, h - 8, "#4aa068");
  for (let xx = 4; xx < w - 4; xx += 4) {
    px(ctx, x + xx, y + 3, 1, 1, "#3c8c58");
    px(ctx, x + xx, y + h - 4, 1, 1, "#3c8c58");
  }
  for (let yy = 4; yy < h - 4; yy += 4) {
    px(ctx, x + 3, y + yy, 1, 1, "#3c8c58");
    px(ctx, x + w - 4, y + yy, 1, 1, "#3c8c58");
  }
  for (let yy = 7; yy < h - 7; yy += 4)
    for (let xx = 7 + ((yy / 4) % 2) * 2; xx < w - 7; xx += 4) px(ctx, x + xx, y + yy, 1, 1, "#8ad894");
}

// A desk whose seat is above it (back to back in an island): its keyboard is on the far side and we see
// the back of its screen, standing on the near edge.
function deskUp(ctx: Ctx, x: number, y: number, w: number, withPC: boolean) {
  // the same desk, seat above, mirrored: 2 px from its far edge (the outline at y - 6) to the keyboard,
  // 2 px to the screen's foot; the screen's back rises over the keyboard
  deskBody(ctx, x, y, w);
  if (!withPC) pcBack(ctx, x + w / 2, y);
}
function armchair(ctx: Ctx, x: number, y: number) {
  px(ctx, x + 2, y + 14, 12, 2, "rgba(40,24,80,0.22)");
  px(ctx, x + 2, y + 1, 12, 8, OUT);
  px(ctx, x + 3, y + 2, 10, 6, "#d0644c");
  px(ctx, x + 3, y + 2, 10, 1, "#f09a7c");
  px(ctx, x + 1, y + 6, 14, 9, OUT);
  px(ctx, x + 2, y + 7, 3, 7, "#b84c3a");
  px(ctx, x + 11, y + 7, 3, 7, "#b84c3a");
  px(ctx, x + 2, y + 7, 3, 1, "#f09a7c");
  px(ctx, x + 11, y + 7, 3, 1, "#f09a7c");
  px(ctx, x + 5, y + 8, 6, 5, "#e8806a");
  px(ctx, x + 5, y + 8, 6, 1, "#ffc0a8");
}
// An armchair seen from the side, facing right (mirrored to face left): backrest on the left.
function armchairSide(ctx: Ctx, x: number, y: number) {
  px(ctx, x + 2, y + 14, 12, 2, "rgba(40,24,80,0.22)");
  px(ctx, x + 1, y + 1, 6, 14, OUT); // backrest
  px(ctx, x + 2, y + 2, 4, 12, "#b84c3a");
  px(ctx, x + 2, y + 2, 4, 1, "#f09a7c");
  px(ctx, x + 2, y + 2, 1, 12, "#d0644c");
  px(ctx, x + 5, y + 7, 10, 8, OUT); // seat
  px(ctx, x + 6, y + 8, 8, 4, "#e8806a");
  px(ctx, x + 6, y + 8, 8, 1, "#ffc0a8");
  px(ctx, x + 6, y + 12, 8, 2, "#b84c3a");
  px(ctx, x + 5, y + 5, 10, 4, OUT); // armrest along the near side
  px(ctx, x + 6, y + 6, 8, 2, "#d0644c");
  px(ctx, x + 6, y + 6, 8, 1, "#f09a7c");
  px(ctx, x + 13, y + 14, 2, 1, OUT);
}
// Stands: rows of seats on stepped concrete, facing the viewer; the caller turns them to face the field.
function seatRows(ctx: Ctx, x: number, y: number, w: number, h: number) {
  px(ctx, x, y, w, h, OUT);
  for (let ry = y; ry < y + h; ry += T) {
    px(ctx, x + 1, ry + 1, w - 2, 11, "#ded4ae"); // the step
    px(ctx, x + 1, ry + 1, w - 2, 1, "#f0e8c8");
    px(ctx, x + 1, ry + 12, w - 2, 3, "#b8a87e"); // its riser
    px(ctx, x + 1, ry + 12, w - 2, 1, "#9c8c64");
    const n = Math.floor((w - 2) / 8); // one seat every 8 px, centred in the row
    for (let i = 0, sx = x + 1 + Math.floor((w - 2 - n * 8) / 2); i < n; i++, sx += 8) {
      px(ctx, sx + 1, ry + 2, 6, 6, OUT); // backrest
      px(ctx, sx + 2, ry + 3, 4, 4, "#4a64a4");
      px(ctx, sx + 2, ry + 3, 4, 1, "#7a94d4");
      px(ctx, sx, ry + 6, 8, 5, OUT); // the seat, wider, in front
      px(ctx, sx + 1, ry + 7, 6, 2, "#6a88d0");
      px(ctx, sx + 1, ry + 7, 6, 1, "#9ab4ec");
    }
  }
}
// Side stands, seen from the side, the seats facing right: one tier per 16 px column, each seat a
// backrest and a seat in profile, one every 8 px down the column. Mirrored to face left.
function seatCols(ctx: Ctx, x: number, y: number, w: number, h: number) {
  px(ctx, x, y, w, h, OUT);
  const n = Math.floor((h - 2) / 8);
  for (let cx = x; cx < x + w; cx += T) {
    px(ctx, cx + 1, y + 1, T - 2, h - 2, "#ded4ae"); // the tier
    px(ctx, cx + 1, y + 1, 1, h - 2, "#f0e8c8");
    px(ctx, cx + T - 3, y + 1, 2, h - 2, "#b8a87e"); // its edge, down to the next tier
    for (let i = 0, sy = y + 1 + Math.floor((h - 2 - n * 8) / 2); i < n; i++, sy += 8) {
      const x0 = cx + 3;
      px(ctx, x0, sy, 3, 6, OUT); // backrest, a gap below it before the next seat
      px(ctx, x0 + 1, sy + 1, 1, 4, "#4a64a4");
      px(ctx, x0 + 2, sy + 2, 7, 5, OUT); // seat
      px(ctx, x0 + 3, sy + 3, 5, 3, "#6a88d0");
      px(ctx, x0 + 3, sy + 3, 5, 1, "#9ab4ec");
    }
  }
}
// Stairs through the stands: plain steps, lit from above.
// Steps run across the way up: horizontal bands for stairs climbing up or down the map, vertical ones
// (across) for stairs climbing sideways.
function stairs(ctx: Ctx, x: number, y: number, w: number, h: number, across = false) {
  px(ctx, x, y, w, h, OUT);
  if (across) {
    for (let sx = x + 1; sx < x + w - 1; sx += 4) {
      px(ctx, sx, y + 1, 3, h - 2, "#e6dcb8");
      px(ctx, sx, y + 1, 1, h - 2, "#f6f0d8");
      px(ctx, sx + 3, y + 1, 1, h - 2, "#a8986c");
    }
    return;
  }
  for (let sy = y + 1; sy < y + h - 1; sy += 4) {
    px(ctx, x + 1, sy, w - 2, 3, "#e6dcb8");
    px(ctx, x + 1, sy, w - 2, 1, "#f6f0d8");
    px(ctx, x + 1, sy + 3, w - 2, 1, "#a8986c");
  }
}
// Stands below the field: we see the seats from behind, their backs on the steps.
function seatRowsBack(ctx: Ctx, x: number, y: number, w: number, h: number) {
  px(ctx, x, y, w, h, OUT);
  for (let ry = y; ry < y + h; ry += T) {
    px(ctx, x + 1, ry + 1, w - 2, 14, "#ded4ae"); // the step
    px(ctx, x + 1, ry + 1, w - 2, 1, "#9c8c64"); // the edge down to the step in front
    px(ctx, x + 1, ry + 2, w - 2, 1, "#f0e8c8");
    const n = Math.floor((w - 2) / 8);
    for (let i = 0, sx = x + 1 + Math.floor((w - 2 - n * 8) / 2); i < n; i++, sx += 8) {
      px(ctx, sx + 1, ry + 4, 6, 9, OUT); // the seat's back hides the seat
      px(ctx, sx + 2, ry + 5, 4, 7, "#4a64a4");
      px(ctx, sx + 2, ry + 5, 4, 1, "#7a94d4");
      px(ctx, sx + 3, ry + 7, 2, 3, "#3e5088");
    }
  }
}
// The field in the middle of the arena: a coral kerb, a teal floor in mown bands, white lines (border,
// half-way line, centre circle and spot). Generic: no emblem of any sport's league or any game.
function court(ctx: Ctx, x: number, y: number, w: number, h: number) {
  px(ctx, x, y, w, h, OUT);
  px(ctx, x + 1, y + 1, w - 2, h - 2, "#e8603c");
  px(ctx, x + 1, y + 1, w - 2, 1, "#f89070");
  px(ctx, x + 3, y + 3, w - 6, h - 6, OUT);
  for (let bx = 0; bx < w - 8; bx += 16) px(ctx, x + 4 + bx, y + 4, Math.min(16, w - 8 - bx), h - 8, (bx / 16) % 2 ? "#4aa898" : "#52b0a0");
  const line = "#e6f6ee";
  px(ctx, x + 8, y + 8, w - 16, 1, line);
  px(ctx, x + 8, y + h - 9, w - 16, 1, line);
  px(ctx, x + 8, y + 8, 1, h - 16, line);
  px(ctx, x + w - 9, y + 8, 1, h - 16, line);
  px(ctx, x + w / 2, y + 8, 1, h - 16, line);
  const cx = x + w / 2, cy = y + h / 2, r = 14;
  for (let a = 0; a < 128; a++) {
    const t = (a / 128) * Math.PI * 2;
    px(ctx, Math.round(cx + Math.cos(t) * r), Math.round(cy + Math.sin(t) * r), 1, 1, line);
  }
  px(ctx, cx - 1, cy - 1, 3, 3, line);
}
// A pennant hanging on a wall: coral or blue by column.
function banner(ctx: Ctx, x: number, y: number) {
  const c = (x / T) % 2 ? "#4a78d0" : "#e8603c";
  px(ctx, x + 1, y + 1, 14, 2, OUT); // rod
  px(ctx, x + 3, y + 2, 10, 11, OUT);
  px(ctx, x + 4, y + 3, 8, 9, c);
  px(ctx, x + 4, y + 3, 8, 1, light(c, 0.35));
  px(ctx, x + 7, y + 6, 2, 2, light(c, 0.5)); // a small diamond
  px(ctx, x + 6, y + 7, 4, 1, light(c, 0.5));
  px(ctx, x + 4, y + 12, 3, 2, OUT); // forked tail
  px(ctx, x + 9, y + 12, 3, 2, OUT);
  px(ctx, x + 5, y + 12, 1, 1, c);
  px(ctx, x + 10, y + 12, 1, 1, c);
}
// A dark board on a wall with two amber scores.
function scoreboard(ctx: Ctx, x: number, y: number, w: number) {
  px(ctx, x + 1, y + 1, w - 2, 13, OUT);
  px(ctx, x + 2, y + 2, w - 4, 11, "#2a2840");
  px(ctx, x + 2, y + 2, w - 4, 1, "#46445e");
  const digit = (dx: number) => {
    px(ctx, dx, y + 5, 4, 1, "#ffc84a");
    px(ctx, dx, y + 7, 4, 1, "#ffc84a");
    px(ctx, dx, y + 9, 4, 1, "#ffc84a");
    px(ctx, dx + 3, y + 5, 1, 5, "#ffc84a");
  };
  digit(x + w / 2 - 12);
  digit(x + w / 2 + 8);
  px(ctx, x + w / 2 - 1, y + 6, 2, 1, "#f2eefc");
  px(ctx, x + w / 2 - 1, y + 8, 2, 1, "#f2eefc");
}
/** Draws f as if the prop were turned (a quarter turn either way, upside down or mirrored) inside its rectangle. */
function turned(ctx: Ctx, x: number, y: number, w: number, h: number, turn: "cw" | "ccw" | "flip" | "mirror", f: (x: number, y: number, w: number, h: number) => void) {
  ctx.save();
  if (turn === "mirror") {
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    f(0, 0, w, h);
  } else if (turn === "flip") {
    ctx.translate(x, y + h);
    ctx.scale(1, -1);
    f(0, 0, w, h);
  } else {
    ctx.translate(x + (turn === "cw" ? w : 0), y + (turn === "cw" ? 0 : h));
    ctx.rotate(turn === "cw" ? Math.PI / 2 : -Math.PI / 2);
    f(0, 0, h, w);
  }
  ctx.restore();
}

const DIMS: Record<string, [number, number]> = {
  desk: [2, 1], chair: [1, 1], plant: [1, 1], couch: [3, 1], table: [3, 2], reception_desk: [6, 1],
  bookshelf: [2, 1], coffee: [1, 1], whiteboard: [3, 1], rug: [4, 3], lamp: [1, 1],
  armchair: [1, 1], bleachers: [4, 2], court: [6, 4], stairs: [2, 2], banner: [1, 1], scoreboard: [4, 1],
  note: [1, 1], image: [1, 1], embed: [2, 1], portal: [1, 1], spotlight: [1, 1], pc: [1, 1],
};
/** The props drawn again as sprites over the bake, sorted in depth with the avatars. */
export const DEPTH_OBJECTS = new Set(["desk", "pc"]);

/** The desk whose footprint holds p's tile (where a pc stands). */
export function deskOf(props: Prop[], p: Prop): Prop | undefined {
  return props.find((q) => {
    if (q.t !== "desk") return false;
    const r = propRect(q);
    return p.x * T >= r.x && p.x * T < r.x + r.w && p.y * T >= r.y && p.y * T < r.y + r.h;
  });
}

/** Draws a desk or a pc at its map pixels (in the bake, and as the depth sprites drawn over it). A pc
 * faces the way its desk does, shifted by its dx, dy. */
export function drawObject(ctx: Ctx, p: Prop, props: Prop[]) {
  const { x, y, w } = propRect(p);
  if (p.t === "desk") {
    const withPC = props.some((q) => q.t === "pc" && deskOf([p], q));
    return p.up ? deskUp(ctx, x, y, w, withPC) : desk(ctx, x, y, w, withPC);
  }
  if (p.t !== "pc") return;
  const cx = x + T / 2 + (p.dx ?? 0), top = y + (p.dy ?? 0);
  if (deskOf(props, p)?.up) pcBack(ctx, cx, top);
  else pcFront(ctx, cx, top);
}

export function propRect(p: Prop) {
  const d = DIMS[p.t] ?? [1, 1];
  return { x: p.x * T, y: p.y * T, w: (p.w ?? d[0]) * T, h: (p.h ?? d[1]) * T };
}
/** Whether a table (or a desk) touches the rectangle on the given side: seats face it, a couch turns its back to it. */
function tableBeside(props: Prop[], p: Prop, side: "left" | "right" | "above" | "below") {
  const r = propRect(p);
  return props.some((q) => {
    if (q.t !== "table" && q.t !== "desk") return false;
    const o = propRect(q);
    if (side === "above") return o.y + o.h === r.y && o.x < r.x + r.w && r.x < o.x + o.w;
    if (side === "below") return o.y === r.y + r.h && o.x < r.x + r.w && r.x < o.x + o.w;
    const touch = side === "right" ? o.x === r.x + r.w : o.x + o.w === r.x;
    return touch && o.y < r.y + r.h && r.y < o.y + o.h;
  });
}
type Rect = { x: number; y: number; w: number; h: number };
/** Whether two rectangles share an edge (side by side or one above the other). */
function touching(a: Rect, b: Rect) {
  const overlapX = a.x < b.x + b.w && b.x < a.x + a.w, overlapY = a.y < b.y + b.h && b.y < a.y + a.h;
  return (overlapY && (a.x + a.w === b.x || b.x + b.w === a.x)) || (overlapX && (a.y + a.h === b.y || b.y + b.h === a.y));
}
function drawProp(ctx: Ctx, p: Prop, props: Prop[] = []) {
  const { x, y, w, h } = propRect(p);
  switch (p.t) {
    case "rug": return rug(ctx, x, y, w, h);
    case "court": return court(ctx, x, y, w, h);
    case "bleachers": {
      // the seats face the field (the court nearest to them)
      const f = props.find((q) => q.t === "court");
      const fr = f ? propRect(f) : { x, y: y + h, w, h };
      const dx = fr.x + fr.w / 2 - (x + w / 2), dy = fr.y + fr.h / 2 - (y + h / 2);
      const draw = (x0: number, y0: number, w0: number, h0: number) => seatRows(ctx, x0, y0, w0, h0);
      if (Math.abs(dx) > Math.abs(dy)) // beside the field: seen from the side
        return dx > 0 ? seatCols(ctx, x, y, w, h) : turned(ctx, x, y, w, h, "mirror", (x0, y0, w0, h0) => seatCols(ctx, x0, y0, w0, h0));
      return dy >= 0 ? draw(x, y, w, h) : seatRowsBack(ctx, x, y, w, h);
    }
    case "stairs": {
      // beside the field they climb sideways
      const f = props.find((q) => q.t === "court");
      if (!f) return stairs(ctx, x, y, w, h);
      const fr = propRect(f);
      const dx = fr.x + fr.w / 2 - (x + w / 2), dy = fr.y + fr.h / 2 - (y + h / 2);
      return stairs(ctx, x, y, w, h, Math.abs(dx) > Math.abs(dy));
    }
    case "banner": return banner(ctx, x, y);
    case "scoreboard": return scoreboard(ctx, x, y, w);
    case "armchair":
      // beside a table it faces it, seen from the side
      if (tableBeside(props, p, "right")) return armchairSide(ctx, x, y);
      if (tableBeside(props, p, "left")) return turned(ctx, x, y, w, h, "mirror", (x0, y0) => armchairSide(ctx, x0, y0));
      return armchair(ctx, x, y);
    case "desk": case "pc": return drawObject(ctx, p, props);
    case "chair":
      // a chair is pulled up to its desk or table, off the tile grid: under one it shows its back
      if (tableBeside(props, p, "above")) return chairBack(ctx, x, y - 4);
      if (tableBeside(props, p, "below")) // a desk's top already rises towards it; a table's does not
        return chair(ctx, x, props.some((q) => q.t === "desk" && touching(propRect(q), { x, y, w, h })) ? y : y + 3);
      return chair(ctx, x, y);
    case "plant": return plant(ctx, x, y);
    case "couch":
      // an upright couch beside a table, or one under it, turns its back to the table
      if (h > w) return turned(ctx, x, y, w, h, tableBeside(props, p, "right") ? "ccw" : "cw", (x0, y0, ww) => couch(ctx, x0, y0, ww));
      if (tableBeside(props, p, "above")) return turned(ctx, x, y, w, h, "flip", (x0, y0, ww) => couch(ctx, x0, y0, ww));
      return couch(ctx, x, y, w);
    case "table": // a table among couches is a coffee table
      return table(ctx, x, y, w, h, props.some((q) => q.t === "couch" && touching(propRect(q), { x, y, w, h })));
    case "reception_desk": return reception(ctx, x, y, w);
    case "bookshelf": return bookshelf(ctx, x, y, w);
    case "coffee": return coffee(ctx, x, y);
    case "whiteboard": return whiteboard(ctx, x, y, w);
    case "lamp": return lamp(ctx, x, y);
    case "note":
      px(ctx, x + 3, y + 1, 10, 14, OUT);
      px(ctx, x + 4, y + 2, 8, 10, "#fff4d0");
      for (let row = 4; row < 11; row += 3) px(ctx, x + 5, y + row, 6, 1, "#847754");
      return;
    case "image":
    case "embed":
      px(ctx, x + 1, y + 1, w - 2, 12, OUT);
      px(ctx, x + 2, y + 2, w - 4, 9, "#78c8dc");
      px(ctx, x + 4, y + 5, w - 8, 5, "#297854");
      px(ctx, x + 4, y + 3, 3, 2, "#fff4b0");
      px(ctx, x + w / 2 - 1, y + 13, 2, 2, OUT);
      return;
    case "portal":
      for (let ring = 0; ring < 3; ring++) {
        const inset = 1 + ring * 2;
        px(ctx, x + inset, y + inset, 16 - inset * 2, 16 - inset * 2, [OUT, "#8860c8", "#92e8e0"][ring]);
      }
      return;
    case "spotlight":
      px(ctx, x + 1, y + 2, 14, 12, OUT);
      px(ctx, x + 2, y + 3, 12, 10, "#ffdb66");
      px(ctx, x + 7, y + 4, 2, 5, "#785028");
      px(ctx, x + 4, y + 7, 8, 2, "#785028");
      px(ctx, x + 6, y + 9, 4, 2, "#785028");
      return;
  }
}

// ---------- whole map ----------
export function bakeMapCanvas(map: MapData): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = map.w * T;
  canvas.height = map.h * T;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  const isWall = (x: number, y: number) => x < 0 || y < 0 || x >= map.w || y >= map.h || map.walls[y][x] === "#";
  const areaAt = new Int16Array(map.w * map.h).fill(-1);
  for (let pass = 0; pass < 2; pass++)
    map.areas.forEach((a, i) => {
      if ((a.kind === "room") !== (pass === 1)) return;
      for (let y = a.y; y < a.y + a.h; y++) for (let x = a.x; x < a.x + a.w; x++) areaAt[y * map.w + x] = i;
    });
  const areaOf = (x: number, y: number) => (x < 0 || y < 0 || x >= map.w || y >= map.h ? -2 : areaAt[y * map.w + x]);
  const floorOf = (x: number, y: number) => {
    let i = areaAt[y * map.w + x];
    // a tile in no area (a doorway in a wall) continues the floor of a room next to it
    for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      if (i >= 0) break;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.w && ny < map.h) i = areaAt[ny * map.w + nx];
    }
    return FLOORS[i >= 0 ? map.areas[i].floor : "tile_gray"] ?? FLOORS.tile_gray;
  };

  // A doorway (a tile in no area, in a wall) between two areas: half of each floor, a sill in the middle,
  // across the way through ("h": rooms above and below, "v": rooms left and right).
  const doorway = (tx: number, ty: number) => {
    if (areaOf(tx, ty) !== -1) return null;
    const up = areaOf(tx, ty - 1), dn = areaOf(tx, ty + 1), lf = areaOf(tx - 1, ty), rt = areaOf(tx + 1, ty);
    if ((isWall(tx - 1, ty) || isWall(tx + 1, ty)) && up >= 0 && dn >= 0 && up !== dn) return { dir: "h" as const, a: up, b: dn };
    if ((isWall(tx, ty - 1) || isWall(tx, ty + 1)) && lf >= 0 && rt >= 0 && lf !== rt) return { dir: "v" as const, a: lf, b: rt };
    return null;
  };
  const floorNamed = (i: number) => FLOORS[map.areas[i].floor] ?? FLOORS.tile_gray;

  // 1. floors
  for (let ty = 0; ty < map.h; ty++)
    for (let tx = 0; tx < map.w; tx++) {
      if (isWall(tx, ty)) continue;
      const d = doorway(tx, ty);
      if (!d) {
        floorTile(ctx, floorOf(tx, ty), tx, ty);
        continue;
      }
      floorTile(ctx, floorNamed(d.a), tx, ty);
      ctx.save();
      ctx.beginPath();
      if (d.dir === "h") ctx.rect(tx * T, ty * T + T / 2, T, T / 2);
      else ctx.rect(tx * T + T / 2, ty * T, T / 2, T);
      ctx.clip();
      floorTile(ctx, floorNamed(d.b), tx, ty);
      ctx.restore();
    }
  // 2. carpet edges where a carpet meets another area, plus contact shadow under wall faces
  for (let ty = 0; ty < map.h; ty++)
    for (let tx = 0; tx < map.w; tx++) {
      if (isWall(tx, ty)) continue;
      const f = floorOf(tx, ty);
      const x = tx * T, y = ty * T, me = areaOf(tx, ty);
      if (f.kind === "carpet" && me !== -1) { // a doorway gets a sill instead (below)
        // no border towards a doorway half made of this same carpet
        const edge = (nx: number, ny: number) => {
          if (isWall(nx, ny) || areaOf(nx, ny) === me) return false;
          const d = doorway(nx, ny);
          return !(d && (d.a === me || d.b === me));
        };
        if (edge(tx - 1, ty)) {
          px(ctx, x, y, 2, T, f.edge);
          for (let yy = 1; yy < T; yy += 4) px(ctx, x + 2, y + yy, 1, 1, light(f.edge, 0.5));
        }
        if (edge(tx + 1, ty)) {
          px(ctx, x + T - 2, y, 2, T, f.edge);
          for (let yy = 1; yy < T; yy += 4) px(ctx, x + T - 3, y + yy, 1, 1, light(f.edge, 0.5));
        }
        if (edge(tx, ty - 1)) {
          px(ctx, x, y, T, 2, f.edge);
          for (let xx = 1; xx < T; xx += 4) px(ctx, x + xx, y + 2, 1, 1, light(f.edge, 0.5));
        }
        if (edge(tx, ty + 1)) {
          px(ctx, x, y + T - 2, T, 2, f.edge);
          for (let xx = 1; xx < T; xx += 4) px(ctx, x + xx, y + T - 3, 1, 1, light(f.edge, 0.5));
        }
      }
      if (isWall(tx, ty - 1)) {
        px(ctx, x, y, T, 3, "rgba(40,24,90,0.24)");
        px(ctx, x, y + 3, T, 2, "rgba(40,24,90,0.10)");
      }
      if (isWall(tx - 1, ty)) px(ctx, x, y, 2, T, "rgba(40,24,90,0.14)");
    }
  // the doorways' sills: a light grey threshold strip where one floor gives way to the other
  for (let ty = 0; ty < map.h; ty++)
    for (let tx = 0; tx < map.w; tx++) {
      const d = isWall(tx, ty) ? null : doorway(tx, ty);
      if (!d || map.areas[d.a].floor === map.areas[d.b].floor) continue; // the same floor on both sides needs no sill
      const x = tx * T, y = ty * T;
      if (d.dir === "h") px(ctx, x, y + T / 2, T, 1, "#d8dae4");
      else px(ctx, x + T / 2, y, 1, T, "#d8dae4");
    }
  // 3. floor decor, then walls, then furniture (back to front)
  const props = [...map.props].sort((a, b) => a.y + (propRect(a).h / T) - (b.y + propRect(b).h / T));
  for (const p of props) if (p.t === "rug" || p.t === "court") drawProp(ctx, p);
  for (let ty = 0; ty < map.h; ty++)
    for (let tx = 0; tx < map.w; tx++)
      if (isWall(tx, ty)) wallTile(ctx, tx, ty, isWall, isWall(tx, ty + 1) || ty + 1 >= map.h ? WALL.cap : floorOf(tx, ty + 1).trim);
  for (let ty = 0; ty < map.h; ty++)
    for (let tx = 0; tx < map.w; tx++) {
      if (!isWall(tx, ty) || isWall(tx, ty + 1) || ty + 1 >= map.h) continue; // only visible wall faces
      if (ty === 0 && tx % 8 === 3) windowDeco(ctx, tx, ty);
      else if (ty > 0 && tx % 6 === 2 && hash(tx, ty, 60) < 0.7) posterDeco(ctx, tx, ty);
    }
  for (const p of props) {
    if (p.t === "rug" || p.t === "court" || p.t === "pc") continue;
    drawProp(ctx, p, props);
    // a desk's pcs right after it, where its built-in screen used to be drawn
    if (p.t === "desk") for (const q of props) if (q.t === "pc" && deskOf([p], q)) drawObject(ctx, q, props);
  }
  return canvas;
}
