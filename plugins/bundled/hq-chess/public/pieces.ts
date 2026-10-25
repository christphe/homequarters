// The chess pieces of the board view, as pixel art drawn in code (original work, docs/art-style.md): each
// piece is 11 x 13 pixels (in a 16 px square), and again 7 x 8 (in an 8 px cell of the reserve and the
// promotion choice: redrawn at that size, not scaled down), "#" its 1 px outline, "h" the lit side (light from the top-left), "o" the
// body, "s" the shade, "." nothing. Pure data plus a painter that takes any pixel setter, so the view
// draws them on its canvas and a script can draw them into a PNG to look at.

export const PIECE_W = 11;
export const PIECE_H = 13;

const ART: Record<string, string[]> = {
  p: [
    "...........",
    "...........",
    "...........",
    "....###....",
    "...#hos#...",
    "...#oss#...",
    "....#s#....",
    "...#hos#...",
    "....#o#....",
    "...#hos#...",
    "..#hooss#..",
    ".#hooooss#.",
    ".#########.",
  ],
  r: [
    "...........",
    "...........",
    ".##.###.##.",
    ".#h#hos#s#.",
    ".#hooooss#.",
    "..#hooss#..",
    "..#hooss#..",
    "..#hooss#..",
    "..#hooss#..",
    "..#hooss#..",
    ".#hoooosss#",
    ".#hoooosss#",
    ".##########",
  ],
  n: [
    "...........",
    "....##.....",
    "...#ho##...",
    "..#hooos#..",
    ".#hoo#oss#.",
    ".#ho#ooss#.",
    "..##hooss#.",
    "...#hooss#.",
    "..#hoooss#.",
    "..#hoooss#.",
    ".#hooooss#.",
    ".#hooooss#.",
    ".#########.",
  ],
  b: [
    "...........",
    ".....#.....",
    "....#h#....",
    "...#hos#...",
    "..#ho#ss#..",
    "..#h#oss#..",
    "..#hooss#..",
    "...#hos#...",
    "....#o#....",
    "...#hos#...",
    "..#hooss#..",
    ".#hooooss#.",
    ".#########.",
  ],
  q: [
    "...........",
    ".#..#.#..#.",
    "#h##o#o##s#",
    "#hoohoooss#",
    ".#hoooooss#",
    ".#hoooooss#",
    "..#hooos#..",
    "...#hos#...",
    "...#hos#...",
    "..#hooss#..",
    "..#hooss#..",
    ".#hooooss#.",
    ".#########.",
  ],
  k: [
    ".....#.....",
    "....#h#....",
    "...#hhos#..",
    "....#o#....",
    "..##hos##..",
    ".#hooooss#.",
    ".#hooooss#.",
    "..#hooss#..",
    "...#hos#...",
    "...#hos#...",
    "..#hooss#..",
    ".#hooooss#.",
    ".#########.",
  ],
};

// The half-size pieces: the same silhouettes with fewer pixels, still outlined.
export const SMALL_W = 7;
export const SMALL_H = 8;

const SMALL: Record<string, string[]> = {
  p: [
    ".......",
    ".......",
    "..###..",
    ".#hos#.",
    "..#o#..",
    ".#hos#.",
    "#hooos#",
    "#######",
  ],
  r: [
    "#.#.#.#",
    "#h#o#s#",
    "#hooos#",
    ".#hos#.",
    ".#hos#.",
    ".#hos#.",
    "#hooos#",
    "#######",
  ],
  n: [
    "..##...",
    ".#ho#..",
    "#hoos#.",
    "#ho#os#",
    ".##hos#",
    "..#hos#",
    "#hooos#",
    "#######",
  ],
  b: [
    "...#...",
    "..#h#..",
    ".#h#s#.",
    ".#hos#.",
    "..#o#..",
    ".#hos#.",
    "#hooos#",
    "#######",
  ],
  q: [
    "...#...",
    "#.#h#.#",
    "#h#o#s#",
    "#hooos#",
    ".#hos#.",
    "..#o#..",
    "#hooos#",
    "#######",
  ],
  k: [
    "..#h#..",
    ".#hhs#.",
    "..#o#..",
    ".#hos#.",
    "#hooos#",
    ".#hos#.",
    "#hooos#",
    "#######",
  ],
};

export const TONES = {
  w: { "#": "#1a1526", h: "#ffffff", o: "#ece6d8", s: "#b9ae9c" },
  b: { "#": "#1a1526", h: "#7a6c90", o: "#4a4058", s: "#2c2536" },
} as const;

/** Paints the piece ("KQRBNP" white, "kqrbnp" black) with its top-left corner at (x, y), one call per pixel;
 * small: the half-size drawing. */
export function paintPiece(piece: string, x: number, y: number, set: (x: number, y: number, colour: string) => void, small = false): void {
  const rows = (small ? SMALL : ART)[piece.toLowerCase()];
  if (!rows) return;
  const tone: Record<string, string> = piece === piece.toUpperCase() ? TONES.w : TONES.b;
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const c = tone[row[i]];
      if (c) set(x + i, y + j, c);
    }
  });
}

