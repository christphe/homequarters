// Sample plugin, server side: every member online has a seedling. From the plugin's modal (side panel >
// Plugins > Sample pet) a member shows or hides theirs and picks its colour; a button in the top bar lets
// it wander around where it was left, or calls it back. Colour and visibility are remembered (hq.kv).
// The browser side is public/client.ts.
//
// Habits worth copying:
//   * changes are collected and broadcast once per update (10 times a second), so a whole office
//     arriving at once (a restart) is one message, well inside the send budget;
//   * messages from browsers are checked before use, and what a member can repeat is throttled:
//     every error counts toward the 10 a minute that stop the plugin.

import type { PetState, PetsMessage } from "./public/messages";

type Pet = Omit<PetState, "id">;

const VARIANTS = 4;

const pets = new Map<number, Pet>();
let changed = new Set<number>(); // seedlings that changed since the last broadcast
let gone = new Set<number>(); // members who left since the last broadcast
let goals = new Map<number, { x: number; y: number }>(); // wander goals to relay
const buckets = new Map<number, { tokens: number; at: number }>();

function stored(id: number): number {
  const v = Number(hq.kv.get("v:" + id));
  if (Number.isInteger(v) && v >= 0 && v < VARIANTS) return v;
  const r = Math.floor(Math.random() * VARIANTS);
  hq.kv.set("v:" + id, String(r));
  return r;
}

const state = (id: number): PetState => ({ id, ...pets.get(id)! });
const list = (ids: Iterable<number>): PetState[] => [...ids].filter((id) => pets.has(id)).map(state);

// at most 5 changes a second per member, with a burst of 5 (a token bucket): quick clicks go
// through, a script hammering the plugin does not
function allowed(id: number): boolean {
  const now = hq.now();
  const b = buckets.get(id) ?? { tokens: 5, at: now };
  b.tokens = Math.min(5, b.tokens + (now - b.at) * 5);
  b.at = now;
  buckets.set(id, b);
  if (b.tokens < 1) return false;
  b.tokens--;
  return true;
}

export function onJoin(p: HQ.Player): void {
  pets.set(p.id, { v: stored(p.id), shown: hq.kv.get("h:" + p.id) !== "1", mode: "follow" });
  changed.add(p.id);
  gone.delete(p.id);
}

export function onLeave(p: HQ.Player): void {
  pets.delete(p.id);
  changed.delete(p.id);
  goals.delete(p.id);
  buckets.delete(p.id);
  gone.add(p.id);
}

export function update(): void {
  const msg: PetsMessage = { t: "pets", set: list(changed), del: [...gone], go: [...goals].map(([id, g]) => ({ id, ...g })) };
  if (!msg.set.length && !msg.del.length && !msg.go.length) return;
  // a refused broadcast (send budget) is kept and retried on the next update
  if (hq.broadcast(msg)) {
    changed = new Set();
    gone = new Set();
    goals = new Map();
  }
}

const coord = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 100000;

export function onMessage(p: HQ.Player, m: unknown): void {
  const me = pets.get(p.id);
  if (!me || typeof m !== "object" || m === null) return;
  const msg = m as Record<string, unknown>;
  if (msg.t === "sync") {
    // a page (re)started: tell it every seedling at once
    const all: PetsMessage = { t: "pets", set: list(pets.keys()), del: [], go: [] };
    hq.send(p.id, all);
  } else if (msg.t === "variant" && typeof msg.v === "number" && Number.isInteger(msg.v) && msg.v >= 0 && msg.v < VARIANTS) {
    if (!allowed(p.id)) return;
    me.v = msg.v;
    hq.kv.set("v:" + p.id, String(msg.v));
    changed.add(p.id);
  } else if (msg.t === "shown" && typeof msg.on === "boolean") {
    if (!allowed(p.id)) return;
    me.shown = msg.on;
    hq.kv.set("h:" + p.id, msg.on ? "0" : "1");
    changed.add(p.id);
  } else if (msg.t === "mode" && (msg.m === "follow" || msg.m === "wander")) {
    if (!allowed(p.id)) return;
    me.mode = msg.m;
    goals.delete(p.id);
    changed.add(p.id);
  } else if (msg.t === "wander" && me.mode === "wander" && coord(msg.x) && coord(msg.y)) {
    // the owner's page picks where its seedling strolls; everybody's page walks it there
    if (!allowed(p.id)) return;
    goals.set(p.id, { x: msg.x, y: msg.y });
  }
}
