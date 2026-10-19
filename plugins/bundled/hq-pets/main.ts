// Pets plugin, server side: every member may add pets that follow them, any of the built-in kinds or
// the seedling, several of one kind if they like, each with its own name and colour, up to the number
// an administrator sets for the office in Administration > Plugins (the "limit" setting of
// plugin.json, 3 unless changed). From the plugin's modal (side panel > Plugins > Pets) a member adds,
// names, recolours and removes theirs; a button in the top bar lets them wander, or calls them back.
// Pets are remembered (hq.kv). The browser side is public/client.ts.
//
// Habits worth copying:
//   * changes are collected and broadcast once per update (10 times a second), cut into messages of
//     at most BUDGET bytes of UTF-8 (what the 4 KB limit counts: names may be in any script), so a
//     whole office arriving at once (a restart) never makes a message too big;
//   * messages from browsers are checked before use, and what a member can repeat is throttled:
//     every error counts toward the 10 a minute that stop the plugin;
//   * the office's setting is an administrator's, made in the admin dialog: the plugin only reads it.

import { KINDS, MAX_GUESTS, METADATA_MAX, NAME_MAX, type Goal, type Goals, type GuestPet, type MemberPets, type Mode, type PageMessage, type Pet, type PetsMessage, type YouMessage } from "./public/messages";

const BUDGET = 3500; // bytes of UTF-8 JSON per message, under the 4096 a plugin message may carry
const MAX_PETS = 8; // the setting's maximum (plugin.json)

interface Member {
  player: HQ.Player;
  pets: Pet[];
  guests: GuestPet[];
  mode: Mode;
}

const members = new Map<number, Member>();
let changed = new Set<number>(); // members whose pets changed since the last broadcast
const gone = new Set<number>(); // members who left since the last broadcast
const goals = new Map<number, Goals>(); // wander goals to relay
// where each wandering member's pets went last (the owner's page decides): a page that starts later
// puts them there, so every page shows them in the same place
const lastGoals = new Map<number, Goals>();
const buckets = new Map<number, { tokens: number; at: number }>();

const limit = (): number => hq.settings().limit ?? 3;

/** Bytes of s in UTF-8, as the server counts a message. */
function bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}
const size = (v: unknown) => bytes(JSON.stringify(v));

const isColour = (c: unknown): c is string => typeof c === "string" && (c === "" || /^[0-9a-f]{6}$/.test(c));
/** A pet's name: one line, trimmed, at most NAME_MAX characters, never cut inside one ("" for none). */
function cleanName(n: unknown): string {
  if (typeof n !== "string") return "";
  const chars = [...n.trim()].filter((c) => c >= " " && c !== "\u007f");
  return chars.slice(0, NAME_MAX).join("").trim();
}

const isKind = (k: unknown): k is number => typeof k === "number" && Number.isInteger(k) && k >= 0 && k < KINDS.length;

/** A member's pets as stored; anything that does not parse is dropped. */
function stored(id: number): Pet[] {
  try {
    const v: unknown = JSON.parse(hq.kv.get("p:" + id) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v
      .filter((p) => Array.isArray(p) && isKind(p[0]) && isColour(p[1]) && typeof p[2] === "string" && /^[a-z0-9]{1,8}$/.test(p[2]))
      .map((p): Pet => [p[0], p[1], p[2], cleanName(p[3])])
      .slice(0, MAX_PETS);
  } catch {
    return [];
  }
}

/** A member's guest pets as stored (other plugins put them there with the setPet hook). */
function storedGuests(id: number): GuestPet[] {
  try {
    const v: unknown = JSON.parse(hq.kv.get("g:" + id) ?? "[]");
    return Array.isArray(v) ? v.filter(isGuest).slice(0, MAX_GUESTS) : [];
  } catch {
    return [];
  }
}

function isGuest(g: unknown): g is GuestPet {
  const o = g as GuestPet;
  if (typeof o !== "object" || o === null || typeof o.from !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(o.from) ||
    typeof o.id !== "string" || !/^[a-z0-9-]{1,16}$/.test(o.id) || typeof o.name !== "string") return false;
  if (o.metadata !== undefined) {
    // drawn by the plugin that put it (hq.provideSheet in its browser code): no sheet, no cell
    const json = JSON.stringify(o.metadata);
    return o.sheet === undefined && o.cell === undefined && json !== undefined && utf8Length(json) <= METADATA_MAX;
  }
  return typeof o.sheet === "string" && /^shared\/[A-Za-z0-9_\-/]+\.png$/.test(o.sheet) &&
    !o.sheet.includes("..") && Array.isArray(o.cell) && o.cell.length === 2 && o.cell.every((n) => Number.isInteger(n) && n >= 8 && n <= 64);
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? (i++, 4) : 3;
  }
  return n;
}

function saveGuests(id: number, guests: GuestPet[]): void {
  hq.kv.set("g:" + id, JSON.stringify(guests));
  const m = members.get(id);
  if (m) {
    m.guests = guests;
    changed.add(id);
  }
}

function save(id: number, m: Member): void {
  // pets hidden by a lowered limit are let go once their owner changes theirs: removing one must not
  // bring back a forgotten one
  m.pets = m.pets.slice(0, limit());
  hq.kv.set("p:" + id, JSON.stringify(m.pets));
  changed.add(id);
}

/** What pages are told: a lowered limit hides the extra pets without forgetting them. */
const shown = (id: number, m: Member): MemberPets => ({ id, pets: m.pets.slice(0, limit()), guests: m.guests, mode: m.mode });

/** Cuts a list into pieces whose JSON stays under BUDGET bytes. */
function pieces<T>(list: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [], n = 0;
  for (const x of list) {
    const b = size(x) + 1;
    if (cur.length && n + b > BUDGET) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(x);
    n += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

function you(m: Member): void {
  const msg: YouMessage = { t: "you", limit: limit() };
  hq.send(m.player.id, msg);
}

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

// Hooks other plugins may call (hq.plugins.call("hq-pets", ...)): they put a pet of their own
// drawing with a member, and the pet then follows, wanders and shows its name like the others. Each
// plugin manages its own guests; the member's own pets and the office's limit are not theirs to touch.
// The member is the caller's (Home Quarters says for whom the calling plugin acts: the member whose
// request or message it is handling), never an argument: no plugin can give someone else a pet.
export function load(): void {
  /** { id, sheet: "shared/....png", cell: [w, h], name }, or { id, metadata, name } for a pet the calling
   * plugin draws on each page (hq.provideSheet), puts (or replaces) that plugin's pet with the member. */
  hq.expose("setPet", (caller: HQ.Caller, a: { id: string; sheet?: string; cell?: [number, number]; metadata?: HQ.Json; name?: string }) => {
    if (!caller.member) return { ok: false, error: "no member: call while handling a member's request or message" };
    // what was given, as given: isGuest refuses a sheet with metadata, or a cell without a sheet
    const guest: GuestPet = { from: caller.plugin, id: a?.id, name: cleanName(a?.name) };
    if (a?.sheet !== undefined) guest.sheet = a.sheet;
    if (a?.cell !== undefined) guest.cell = a.cell;
    if (a?.metadata !== undefined) guest.metadata = a.metadata;
    if (!isGuest(guest)) return { ok: false, error: "bad arguments" };
    const others = storedGuests(caller.member).filter((g) => !(g.from === guest.from && g.id === guest.id));
    if (others.length >= MAX_GUESTS) return { ok: false, error: "full" };
    saveGuests(caller.member, [...others, guest]);
    return { ok: true };
  });
  /** { id } takes that plugin's pet away from the member. */
  hq.expose("removePet", (caller: HQ.Caller, a: { id: string }) => {
    if (!caller.member) return { ok: false, error: "no member" };
    const before = storedGuests(caller.member);
    const after = before.filter((g) => !(g.from === caller.plugin && g.id === a?.id));
    if (after.length !== before.length) saveGuests(caller.member, after);
    return { ok: true, removed: after.length !== before.length };
  });
}

export function onJoin(p: HQ.Player): void {
  const m: Member = { player: p, pets: stored(p.id), guests: storedGuests(p.id), mode: "follow" };
  members.set(p.id, m);
  changed.add(p.id);
  gone.delete(p.id);
  you(m);
}

export function onLeave(p: HQ.Player): void {
  members.delete(p.id);
  changed.delete(p.id);
  goals.delete(p.id);
  lastGoals.delete(p.id);
  buckets.delete(p.id);
  gone.add(p.id);
}

/** An administrator changed the limit: a lower one hides pets, a higher one shows remembered ones again. */
export function onSettings(): void {
  for (const [id, m] of members) {
    changed.add(id);
    you(m);
  }
}

export function update(): void {
  if (!changed.size && !gone.size && !goals.size) return;
  // one message per update, filled up to BUDGET bytes: members who left, wander goals, then pets;
  // what does not fit waits for the next update, and a refused broadcast (send budget) is retried then
  const msg: PetsMessage = { t: "pets", set: [], del: [], go: [] };
  let n = size(msg);
  for (const id of gone) {
    if (n + 12 > BUDGET) break;
    msg.del.push(id);
    n += 12;
  }
  for (const [id, g] of goals) {
    const b = size({ id, g }) + 1;
    if (n + b > BUDGET) break;
    msg.go.push({ id, g });
    n += b;
  }
  for (const id of changed) {
    const m = members.get(id);
    if (!m) continue;
    const s = shown(id, m), b = size(s) + 1;
    if (n + b > BUDGET) break;
    msg.set.push(s);
    n += b;
  }
  if (!msg.set.length && !msg.del.length && !msg.go.length) {
    changed = new Set([...changed].filter((id) => members.has(id)));
    return;
  }
  if (!hq.broadcast(msg)) return;
  for (const s of msg.set) changed.delete(s.id);
  for (const id of msg.del) gone.delete(id);
  for (const g of msg.go) goals.delete(g.id);
}

const coord = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 100000;
const speed = (v: unknown): v is number => typeof v === "number" && v >= 10 && v <= 80;
// a sprite id: member:pet, or member:x:plugin:id for a guest
const pal = (v: unknown): v is string => typeof v === "string" && /^[0-9]{1,10}:[a-z0-9:-]{1,60}$/.test(v);

export function onMessage(p: HQ.Player, raw: unknown): void {
  const me = members.get(p.id);
  if (!me || typeof raw !== "object" || raw === null) return;
  const msg = raw as PageMessage;
  switch (msg.t) {
    case "sync": {
      // a page (re)started: tell it every member's pets, then where the wandering ones are
      for (const part of pieces([...members].map(([id, m]) => shown(id, m)))) {
        const all: PetsMessage = { t: "pets", set: part, del: [], go: [] };
        hq.send(p.id, all);
      }
      const where = [...lastGoals].filter(([id]) => members.get(id)?.mode === "wander").map(([id, g]) => ({ id, g }));
      for (const part of pieces(where)) {
        const placed: PetsMessage = { t: "pets", set: [], del: [], go: part, place: true };
        hq.send(p.id, placed);
      }
      you(me);
      return;
    }
    case "add":
      if (!isKind(msg.k) || me.pets.length >= limit() || !allowed(p.id)) return;
      me.pets.push([msg.k, "", Math.random().toString(36).slice(2, 8) || "p", ""]);
      save(p.id, me);
      return;
    case "remove":
      if (!Number.isInteger(msg.i) || !me.pets[msg.i] || !allowed(p.id)) return;
      me.pets.splice(msg.i, 1);
      save(p.id, me);
      return;
    case "colour":
      if (!Number.isInteger(msg.i) || !me.pets[msg.i] || !isColour(msg.c) || !allowed(p.id)) return;
      me.pets[msg.i][1] = msg.c;
      save(p.id, me);
      return;
    case "name":
      if (!Number.isInteger(msg.i) || !me.pets[msg.i] || typeof msg.n !== "string" || !allowed(p.id)) return;
      me.pets[msg.i][3] = cleanName(msg.n); // shown to everybody: never logged
      save(p.id, me);
      return;
    case "mode":
      if ((msg.m !== "follow" && msg.m !== "wander") || !allowed(p.id)) return;
      me.mode = msg.m;
      goals.delete(p.id);
      lastGoals.delete(p.id);
      changed.add(p.id);
      return;
    case "wander": {
      // the owner's page picks where its pets stroll; everybody's page walks them there
      if (me.mode !== "wander" || !Array.isArray(msg.g) || msg.g.length > MAX_PETS + MAX_GUESTS || !allowed(p.id)) return;
      if (!msg.g.every((g) => g === null || pal(g) || (Array.isArray(g) && coord(g[0]) && coord(g[1]) && speed(g[2])))) return;
      // whole numbers: a goal costs the same few bytes whatever the page sent
      const next = msg.g.map((g): Goal => (g === null || typeof g === "string" ? g : [Math.round(g[0]), Math.round(g[1]), Math.round(g[2])]));
      goals.set(p.id, next);
      // remembered per pet: a null keeps the pet's previous goal
      const before = lastGoals.get(p.id) ?? [];
      lastGoals.set(p.id, next.map((g, i) => g ?? before[i] ?? null));
      return;
    }
  }
}
