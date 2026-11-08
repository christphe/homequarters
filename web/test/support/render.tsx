// renderUI: a component rendered on a known store, with a user-event session. The store (web/src/store.ts) is a
// module singleton: without a reset, what one test set (a roster, a toast, a conversation) shows in the next.
import { render, type RenderResult } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import type { AvatarSpec, Person } from "../../src/net/protocol";
import { getState, setState, type State } from "../../src/store";
import { installCanvas } from "./canvas";
import { afterEveryTest } from "./cleanup";

// The app's own initial state, read before any test changes it (storage is empty on a fresh jsdom).
const pristine: State = getState();

/** The look every test person has unless a test gives another. */
export const LOOK: AvatarSpec = { sk: 1, hs: 0, hc: 1, sh: 4, pa: 1 };

/** A roster entry: available member with the default look, unless `p` says otherwise. */
export const person = (id: number, n: string, p: Partial<Person> = {}): Person => ({ id, n, av: LOOK, s: "available", r: "member", ...p });

/** Me in the known state: id 1, named "Me". */
export const ME = person(1, "Me");

/**
 * The known state every test starts from: the app's initial state, in the office (phase "play", socket open),
 * signed in as ME (id 1, in the roster), with empty storage. Fresh Maps and arrays each time.
 */
export function baseState(): State {
  return { ...pristine, phase: "play", conn: "open", meId: ME.id, office: "Test office", roster: new Map([[ME.id, ME]]), owners: new Map(),
    chat: [], locked: [], denied: [], areaCounts: [], pluginUI: { slots: [], modal: null }, pluginObjects: { specs: [], titles: {} } };
}

/** Empties storage and puts the store back to baseState() plus `patch` (a roster in the patch replaces the base one). */
export function resetStore(patch: Partial<State> = {}): void {
  try { localStorage.clear(); } catch { /* no storage */ }
  setState({ ...baseState(), ...patch });
}

/** A roster Map from people (ME is added unless already there). */
export const roster = (...people: Person[]): Map<number, Person> => new Map([ME, ...people].map((p) => [p.id, p]));

export type UIResult = RenderResult & { user: UserEvent };

/**
 * Resets the store to baseState() + `patch`, installs the canvas stub, renders `ui` and returns Testing Library's
 * result with a user-event session (`user`). Everything is undone after the test (web/test/support/cleanup.ts).
 */
export function renderUI(ui: ReactElement, patch: Partial<State> = {}): UIResult {
  resetStore(patch);
  installCanvas();
  const user = userEvent.setup();
  return { ...render(ui), user };
}

// a test's patch must not reach the next test, even one that renders without renderUI
afterEveryTest(() => resetStore());
