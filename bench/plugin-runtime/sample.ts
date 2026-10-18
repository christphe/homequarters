// The sample plugin's server side (plugins/sample-pet/main.lua) in TypeScript, for the runtime spike.
// Same logic, same messages: only the language changes.

declare const tw: {
  kv: { get(key: string): string | null; set(key: string, value: string): void };
  broadcast(msg: unknown): boolean;
  send(id: number, msg: unknown): boolean;
  now(): number;
};

type Player = { id: number; name: string; role: string };
type Pet = { v: number; shown: boolean; mode: "follow" | "wander" };

const VARIANTS = 4;
const pets = new Map<number, Pet>();
let changed = new Set<number>();
let gone = new Set<number>();
let goals = new Map<number, { x: number; y: number }>();
const buckets = new Map<number, { tokens: number; at: number }>();

function stored(id: number): number {
  const v = Number(tw.kv.get("v:" + id));
  if (Number.isInteger(v)) return v;
  const r = Math.floor(Math.random() * VARIANTS);
  tw.kv.set("v:" + id, String(r));
  return r;
}

const entry = (id: number) => ({ id, ...pets.get(id)! });
const list = (ids: Iterable<number>) => [...ids].filter((id) => pets.has(id)).map(entry);

function allowed(id: number): boolean {
  const now = tw.now();
  const b = buckets.get(id) ?? { tokens: 5, at: now };
  b.tokens = Math.min(5, b.tokens + (now - b.at) * 5);
  b.at = now;
  buckets.set(id, b);
  if (b.tokens < 1) return false;
  b.tokens--;
  return true;
}

export function on_join(p: Player) {
  pets.set(p.id, { v: stored(p.id), shown: tw.kv.get("h:" + p.id) !== "1", mode: "follow" });
  changed.add(p.id);
  gone.delete(p.id);
}

export function on_leave(p: Player) {
  pets.delete(p.id);
  changed.delete(p.id);
  goals.delete(p.id);
  buckets.delete(p.id);
  gone.add(p.id);
}

export function update(_dt: number) {
  const set = list(changed), del = [...gone], go = [...goals].map(([id, g]) => ({ id, ...g }));
  if (!set.length && !del.length && !go.length) return;
  if (tw.broadcast({ t: "pets", set, del, go })) {
    changed = new Set();
    gone = new Set();
    goals = new Map();
  }
}

const coord = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 100000;

export function on_message(p: Player, m: any) {
  const me = pets.get(p.id);
  if (!m || typeof m !== "object" || !me) return;
  if (m.t === "sync") tw.send(p.id, { t: "pets", set: list(pets.keys()), del: [], go: [] });
  else if (m.t === "variant" && Number.isInteger(m.v) && m.v >= 0 && m.v < VARIANTS) {
    if (!allowed(p.id)) return;
    me.v = m.v;
    tw.kv.set("v:" + p.id, String(m.v));
    changed.add(p.id);
  } else if (m.t === "shown" && typeof m.on === "boolean") {
    if (!allowed(p.id)) return;
    me.shown = m.on;
    tw.kv.set("h:" + p.id, m.on ? "0" : "1");
    changed.add(p.id);
  } else if (m.t === "mode" && (m.m === "follow" || m.m === "wander")) {
    if (!allowed(p.id)) return;
    me.mode = m.m;
    goals.delete(p.id);
    changed.add(p.id);
  } else if (m.t === "wander" && me.mode === "wander" && coord(m.x) && coord(m.y)) {
    if (!allowed(p.id)) return;
    goals.set(p.id, { x: m.x, y: m.y });
  }
}
