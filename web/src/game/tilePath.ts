// Path finding for plugin sprites (a seedling called back to its owner): a breadth-first search over
// the map's 16 px tiles, then string pulling so the sprite walks straight wherever it can. Pure, so it
// runs under node --test. The server has its own search for walk-to; this one is cosmetic and local.

const T = 16;

export interface Point {
  x: number;
  y: number;
}

/** Whether the straight segment a-b stays on walkable tiles (sampled every 4 px). */
export function clearLine(ax: number, ay: number, bx: number, by: number, walkable: (tx: number, ty: number) => boolean) {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 4));
  for (let i = 0; i <= steps; i++) {
    const x = ax + ((bx - ax) * i) / steps, y = ay + ((by - ay) * i) / steps;
    if (!walkable(Math.floor(x / T), Math.floor(y / T))) return false;
  }
  return true;
}

/**
 * Waypoints (world px) from (fx, fy) to (tx, ty), the start excluded and the exact target last, or null
 * when the target cannot be reached within maxNodes tiles of search. With closest, a target it cannot
 * reach (off the map, in a wall, too far) gives the way to the searched tile nearest to it instead,
 * null only when that is where it already is.
 */
export function findPath(fx: number, fy: number, tx: number, ty: number, walkable: (tx: number, ty: number) => boolean, maxNodes = 4096, closest = false): Point[] | null {
  if (clearLine(fx, fy, tx, ty, walkable)) return [{ x: tx, y: ty }];
  const sx = Math.floor(fx / T), sy = Math.floor(fy / T);
  let gx = Math.floor(tx / T), gy = Math.floor(ty / T);
  if (!walkable(gx, gy) && !closest) return null;
  const key = (x: number, y: number) => x + "," + y;
  const prev = new Map<string, string | null>([[key(sx, sy), null]]);
  const queue: [number, number][] = [[sx, sy]];
  let found = false;
  let near = [sx, sy], nearD = Math.hypot(sx - gx, sy - gy);
  for (let head = 0; head < queue.length; head++) {
    if (prev.size > maxNodes) break;
    const [x, y] = queue[head];
    if (x === gx && y === gy) {
      found = true;
      break;
    }
    const d = Math.hypot(x - gx, y - gy);
    if (d < nearD) {
      near = [x, y];
      nearD = d;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (prev.has(k) || !walkable(nx, ny)) continue;
      prev.set(k, key(x, y));
      queue.push([nx, ny]);
    }
  }
  if (!found) {
    if (!closest || (near[0] === sx && near[1] === sy)) return null;
    [gx, gy] = near;
    tx = gx * T + T / 2;
    ty = gy * T + T / 2;
  }
  // tile centres from start to goal, then the exact target
  const tiles: Point[] = [];
  for (let k: string | null = key(gx, gy); k; k = prev.get(k) ?? null) {
    const [x, y] = k.split(",").map(Number);
    tiles.unshift({ x: x * T + T / 2, y: y * T + T / 2 });
  }
  tiles.shift();
  tiles.push({ x: tx, y: ty });
  // string pulling: from where we are, go to the farthest waypoint in a straight clear line
  const out: Point[] = [];
  let cx = fx, cy = fy, i = 0;
  while (i < tiles.length) {
    let j = tiles.length - 1;
    while (j > i && !clearLine(cx, cy, tiles[j].x, tiles[j].y, walkable)) j--;
    out.push(tiles[j]);
    cx = tiles[j].x;
    cy = tiles[j].y;
    i = j + 1;
  }
  return out;
}
