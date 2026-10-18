// What the pets plugin's server and browser code say to each other, typed once for both sides (main.ts
// imports it, public/client.ts too). Types only, except the kind list both sides read.

/** The kinds, in the order of pets.png and pets-tint.png (4 rows each). */
export const KINDS = ["Cat", "Dog", "Bunny", "Fox", "Chick", "Slime", "Owl", "Axolotl", "Seedling"] as const;


export type Mode = "follow" | "wander";

/** One pet: its kind (index into KINDS), its colour ("rrggbb", or "" for the kind's own colours), an id
 * that stays the same while it lives (removing one pet never makes another one change on screen) and
 * its name ("" for none; at most NAME_MAX characters). */
export type Pet = [kind: number, colour: string, id: string, name: string];

export const NAME_MAX = 24;

/** A pet another plugin put with a member (the setPet hook): drawn from that plugin's shared/ sheet,
 * 4 rows (down, left, right, up) of 3 cells (idle, step A, step B) of cell px. Not counted in the
 * office's limit and not shown in the Pets modal: the plugin that put it manages it. */
export interface GuestPet {
  from: string; // the plugin
  id: string;
  sheet: string; // shared/... in that plugin's public/
  cell: [w: number, h: number];
  name: string;
}

/** The most guest pets a member can have, all plugins together. */
export const MAX_GUESTS = 4;

/** A member's pets, as every page is told (at most the office's limit), then their guests. */
export interface MemberPets {
  id: number;
  pets: Pet[];
  guests: GuestPet[];
  mode: Mode;
}

/** A wander goal for each of a member's pets, in order: where to walk and how fast (px/s, 10-80), or
 * the sprite id ("member:pet") of another wandering pet to go along with; null: that pet keeps doing
 * what it does. */
export type Goal = [x: number, y: number, speed: number] | string | null;
export type Goals = Goal[];

/** Server to pages: members whose pets changed, members who left, wander goals to walk to. */
export interface PetsMessage {
  t: "pets";
  set: MemberPets[];
  del: number[];
  go: { id: number; g: Goals }[];
}

/** Server to one page: how many pets a member may have (the office's setting). Sent when they arrive
 * and when an administrator changes it. */
export interface YouMessage {
  t: "you";
  limit: number;
}

/** Page to server. */
export type PageMessage =
  | { t: "sync" }
  | { t: "add"; k: number }
  | { t: "remove"; i: number }
  | { t: "colour"; i: number; c: string }
  | { t: "name"; i: number; n: string }
  | { t: "mode"; m: Mode }
  | { t: "wander"; g: Goals };
