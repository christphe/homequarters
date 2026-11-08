// Fakes of the two MediaManager singletons (web/src/media/MediaManager.ts: `media` for conversations, `spotlightMedia`
// for the spotlight) for component tests: every public method is a spy typed with the real signature, and the tiles
// are a list the test sets (setTiles), which subscribers see as they would see LiveKit's. Use it in a test file with
//
//   vi.mock("../src/media/MediaManager", async (original) =>
//     (await import("./support/media")).mediaModule(await original<typeof import("../src/media/MediaManager")>()));
//
// and get the fakes with mockMedia(). The module's pure helpers (describeMediaError, canShareScreen, micCapture...)
// stay the real ones.
import { vi, type Mock } from "vitest";
import type { MediaManager, Tile } from "../../src/media/MediaManager";
import { getState } from "../../src/store";
import { afterEveryTest } from "./cleanup";

type Fn<T> = T extends (...a: infer A) => infer R ? (...a: A) => R : never;
type MethodsOf<T> = { [K in keyof T]-?: T[K] extends (...a: never[]) => unknown ? K : never }[keyof T];
type MediaMethod = Exclude<MethodsOf<MediaManager>, "onSpeaking" | "onSharing" | "onNeedToken" | "onProblem">;

// Every public method of MediaManager but the callbacks the session sets. The checks fail the type check when one is
// added or removed.
const METHODS = ["subscribe", "getTiles", "join", "leave", "applySubscriptions", "setVolume", "applyNoiseSuppression", "pauseForMicTest",
  "setMic", "setCam", "release", "setShare", "switchDevice"] as const satisfies readonly MediaMethod[];
type Missing = Exclude<MediaMethod, (typeof METHODS)[number]>;
const complete: [Missing] extends [never] ? true : Missing = true;
void complete;
// Its public fields and getters too (a new one fails here until the fake gets it). The on* callbacks are set by the
// session, which is faked as well, so the fake leaves them out.
type MediaField = Exclude<keyof MediaManager, MethodsOf<MediaManager>>;
type FakedField = "tiles" | "currentRoom";
const fields: [MediaField] extends [FakedField] ? ([FakedField] extends [MediaField] ? true : never) : MediaField = true;
void fields;

export type MediaFake = { [K in MediaMethod]: Mock<Fn<MediaManager[K]>> } & {
  tiles: Tile[];
  /** The room's name, as the real getter: "" out of a room (set it in a test that needs one). */
  currentRoom: MediaManager["currentRoom"];
  /** Replaces the tiles and tells the subscribers, as the real manager does when the room changes. */
  setTiles(tiles: Tile[]): void;
};

function make(): MediaFake {
  const listeners = new Set<() => void>();
  const m = Object.fromEntries(METHODS.map((n) => [n, vi.fn()])) as unknown as MediaFake;
  m.tiles = [];
  m.setTiles = (tiles) => { m.tiles = tiles; listeners.forEach((f) => f()); };
  const defaults = () => {
    for (const n of METHODS) m[n].mockReset();
    listeners.clear();
    m.tiles = [];
    m.currentRoom = "";
    m.subscribe.mockImplementation((cb) => { listeners.add(cb); return () => listeners.delete(cb); });
    m.getTiles.mockImplementation(() => m.tiles);
    for (const n of ["join", "leave", "applyNoiseSuppression", "pauseForMicTest", "setMic", "setCam", "setShare", "switchDevice"] as const) m[n].mockResolvedValue(undefined);
    m.release.mockResolvedValue(true);
  };
  defaults();
  afterEveryTest(defaults);
  return m;
}

const media = make();
const spotlightMedia = make();

/** The fakes, reset (spies, tiles, subscribers) before every test. `active()` is the one activeMedia() returns now. */
export function mockMedia(): { media: MediaFake; spotlightMedia: MediaFake; active: () => MediaFake } {
  return { media, spotlightMedia, active: () => (getState().spotlight?.me ? spotlightMedia : media) };
}

/** A tile: a remote person (identity "2") with the microphone on, no camera, at full volume, unless `p` says otherwise. */
export const tile = (p: Partial<Tile> = {}): Tile => ({ identity: "2", name: "Bruno", local: false, mic: true, cam: false, speaking: false, video: null, screen: null, vol: 1, ...p });

type Module = typeof import("../../src/media/MediaManager");

/** What `vi.mock("../src/media/MediaManager", ...)` returns: the real module with the fakes in place of its singletons. */
export function mediaModule(original: Module): Module {
  return {
    ...original,
    media: media as unknown as MediaManager,
    spotlightMedia: spotlightMedia as unknown as MediaManager,
    // as the real activeMedia, on the fakes (the real one reads the module's own singletons)
    activeMedia: () => (getState().spotlight?.me ? spotlightMedia : media) as unknown as MediaManager,
  };
}
