// hq-cards's standard deck, drawn in code (original pixel art, docs/art-style.md): 20 x 28 px cards, a 1 px
// outline with cut corners, the rank and a small suit at the top left, the rank turned at the bottom right,
// and a large suit in the middle, or for jacks, queens and kings a small figure of the suit's colour (a cap, long
// hair, a crown). The two jokers carry a jester's hat. One back: a red lattice inside a paper frame.
// Pure: paint(set) calls set(x, y, colour) for each pixel; the view draws with it, the tests read it.

export const CARD_W = 20;
export const CARD_H = 28;
export type Set = (x: number, y: number, hex: string) => void;

const OUT = "#1a1526"; // the shared outline colour of web/src/game/art/pixel.ts
const PAPER = { hi: "#ffffff", mid: "#f4efe2", lo: "#d6ccb8" };
const RED = { hi: "#e8786a", mid: "#c8463c", lo: "#8e2f2a" };
const DARK = { hi: "#5a5470", mid: "#2e2a3a", lo: "#1f1b2a" };
const SKIN = { mid: "#f0c8a0", lo: "#c99a76" };
const GOLD = { hi: "#f6dc78", mid: "#d9a93a" };
const BACK = { hi: "#e07a6a", mid: "#b8443a", lo: "#86302c" };
/** Every colour the deck uses (the tests check nothing else appears). */
export const PALETTE: readonly string[] = [OUT, ...Object.values(PAPER), ...Object.values(RED), ...Object.values(DARK), ...Object.values(SKIN), ...Object.values(GOLD), ...Object.values(BACK)];

// 3 x 5 rank glyphs ("T" is a 5-wide 10); "*" is the jokers' star
const RANKS: Record<string, string[]> = {
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  "2": ["##.", "..#", ".#.", "#..", "###"],
  "3": ["##.", "..#", ".#.", "..#", "##."],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "##.", "..#", "##."],
  "6": [".##", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "##."],
  T: ["#.###", "#.#.#", "#.#.#", "#.#.#", "#.###"],
  J: ["..#", "..#", "..#", "#.#", ".#."],
  Q: [".#.", "#.#", "#.#", "##.", ".##"],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  "*": ["#.#", ".#.", "###", ".#.", "#.#"],
};
// 5 x 5 small suits and 9 x 9 large ones
const SMALL: Record<string, string[]> = {
  S: ["..#..", ".###.", "#####", "#.#.#", "..#.."],
  H: [".#.#.", "#####", "#####", ".###.", "..#.."],
  D: ["..#..", ".###.", "#####", ".###.", "..#.."],
  C: [".###.", ".###.", "#####", "#.#.#", "..#.."],
};
const LARGE: Record<string, string[]> = {
  S: ["....#....", "...###...", "..#####..", ".#######.", "#########", "#########", ".##.#.##.", "....#....", "...###..."],
  H: [".##...##.", "####.####", "#########", "#########", ".#######.", "..#####..", "...###...", "....#....", "........."],
  D: ["....#....", "...###...", "..#####..", ".#######.", "#########", ".#######.", "..#####..", "...###...", "....#...."],
  C: ["...###...", "..#####..", "..#####..", "##.###.##", "#########", "##.###.##", "....#....", "...###...", "..#####.."],
};
// 9 x 11 figures: o outline, h hat or hair (suit colour), g gold, s skin, k shaded skin, b body (suit colour)
const FIGURES: Record<string, string[]> = {
  J: ["..ooooo..", ".ohhhhho.", "ohhhhhhho", "..ossso..", "..osoko..", "..ossko..", "...okk...", "..obbbo..", ".obbgbbo.", "obbbgbbbo", "obbbgbbbo"],
  Q: ["...ogo...", "..ohhho..", ".ohssshho", ".ohsoshho", ".ohsskhho", ".ohhkhhho", "ohhhkhhho", "..obbbo..", ".obbgbbo.", "obbbbbbbo", "obbbbbbbo"],
  K: ["og.og.og.", "oggoggogo", "ogggggggo", "..ossso..", "..osoko..", "..ossko..", "..ohhho..", "..obbbo..", ".obgggbo.", "obbbgbbbo", "obbbgbbbo"],
  X: ["oh.....ho", "ohh...hho", ".ohhghho.", "..ohhho..", "..ossso..", "..osoko..", "..ossko..", "...okk...", "..obgbo..", ".obbgbbo.", "obbbgbbbo"],
};

function glyph(rows: string[], x0: number, y0: number, hex: string, set: Set, turned = false): void {
  const h = rows.length, w = rows[0].length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rows[y][x] !== "#") continue;
      set(turned ? x0 + w - 1 - x : x0 + x, turned ? y0 + h - 1 - y : y0 + y, hex);
    }
  }
}

/** The paper: outline with cut corners, lit from the top-left. */
function blank(set: Set): void {
  for (let y = 0; y < CARD_H; y++) {
    for (let x = 0; x < CARD_W; x++) {
      const corner = (x === 0 || x === CARD_W - 1) && (y === 0 || y === CARD_H - 1);
      if (corner) continue;
      const edge = x === 0 || y === 0 || x === CARD_W - 1 || y === CARD_H - 1;
      let c = PAPER.mid;
      if (edge) c = OUT;
      else if (x === 1 || y === 1) c = PAPER.hi;
      else if (x === CARD_W - 2 || y === CARD_H - 2) c = PAPER.lo;
      set(x, y, c);
    }
  }
}

function figure(rows: string[], tone: typeof RED, x0: number, y0: number, set: Set): void {
  const colours: Record<string, string> = { o: OUT, h: tone.mid, g: GOLD.mid, s: SKIN.mid, k: SKIN.lo, b: tone.lo };
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (colours[ch]) set(x0 + x, y0 + y, colours[ch]);
  }));
}

/** Paints a card of the standard deck by its code (rank A23456789TJQK and suit SHDC, or XR / XB for the jokers). */
export function paintCard(code: string, set: Set): void {
  blank(set);
  const joker = code[0] === "X";
  const red = joker ? code === "XR" : code[1] === "H" || code[1] === "D";
  const tone = red ? RED : DARK;
  const rank = RANKS[joker ? "*" : code[0]];
  const rw = rank[0].length;
  // the corners: the rank with a small suit under it at the top left, the rank turned at the bottom right
  glyph(rank, 2, 2, tone.mid, set);
  glyph(rank, CARD_W - 2 - rw, CARD_H - 7, tone.mid, set, true);
  if (!joker) glyph(SMALL[code[1]], 2, 8, tone.mid, set);
  // the middle
  // the middle, clear of the corners: a figure (with its suit in gold under it) or a large suit
  if (joker) figure(FIGURES.X, tone, 7, 9, set);
  else if ("JQK".includes(code[0])) {
    figure(FIGURES[code[0]], tone, 7, 9, set);
    glyph(SMALL[code[1]], 9, 21, GOLD.hi, set);
  } else {
    glyph(LARGE[code[1]], 6, 13, tone.mid, set);
    glyph([LARGE[code[1]][0]], 6, 13, tone.hi, set); // a highlight on the top row
  }
}

/** The back: a red lattice inside a paper frame. */
export function paintBack(set: Set): void {
  blank(set);
  for (let y = 3; y < CARD_H - 3; y++) {
    for (let x = 3; x < CARD_W - 3; x++) {
      const frame = x === 3 || y === 3 || x === CARD_W - 4 || y === CARD_H - 4;
      set(x, y, frame ? BACK.lo : (x + y) % 4 === 0 || (x - y + 64) % 4 === 0 ? BACK.hi : BACK.mid);
    }
  }
}
