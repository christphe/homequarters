// The chess pieces of the board view, as pixel art drawn in code (original work, docs/art-style.md): each
// piece is 11 x 13 pixels, "#" its 1 px outline, "h" the lit side (light from the top-left), "o" the
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

export const TONES = {
  w: { "#": "#1a1526", h: "#ffffff", o: "#ece6d8", s: "#b9ae9c" },
  b: { "#": "#1a1526", h: "#7a6c90", o: "#4a4058", s: "#2c2536" },
} as const;

/** Paints the piece ("KQRBNP" white, "kqrbnp" black) with its top-left corner at (x, y), one call per pixel. */
export function paintPiece(piece: string, x: number, y: number, set: (x: number, y: number, colour: string) => void): void {
  const rows = ART[piece.toLowerCase()];
  if (!rows) return;
  const tone: Record<string, string> = piece === piece.toUpperCase() ? TONES.w : TONES.b;
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const c = tone[row[i]];
      if (c) set(x + i, y + j, c);
    }
  });
}

export const PIECE_NAMES: Record<string, string> = { p: "pawn", r: "rook", n: "knight", b: "bishop", q: "queen", k: "king" };
