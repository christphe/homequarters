// What the sample plugin's server and browser code say to each other, typed once for both sides
// (main.ts imports it, public/client.ts too). Types only: nothing of it runs.

export type Mode = "follow" | "wander";

/** A member's seedling, as every page is told. */
export interface PetState {
  id: number;
  v: number; // colour, 0-3
  shown: boolean;
  mode: Mode;
}

/** Server to pages: seedlings that changed, members who left, wander goals to walk to. */
export interface PetsMessage {
  t: "pets";
  set: PetState[];
  del: number[];
  go: { id: number; x: number; y: number }[];
}

/** Page to server. */
export type PageMessage =
  | { t: "sync" }
  | { t: "variant"; v: number }
  | { t: "shown"; on: boolean }
  | { t: "mode"; m: Mode }
  | { t: "wander"; x: number; y: number };
