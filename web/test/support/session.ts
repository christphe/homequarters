// A fake of the `session` singleton (web/src/session.ts) for component tests: every public method is a spy, typed
// with the real method's signature, so a component's call is checked by name and arguments and a renamed or new
// method fails the type check (`pnpm exec tsc -p tsconfig.test.json`). Use it in a test file with
//
//   vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());
//
// and get the fake with mockSession(). Nothing here imports web/src/session.ts at run time (that import is the mock).
import { vi, type Mock } from "vitest";
import type { session as realSession } from "../../src/session";
import type { WorldView } from "../../src/game/WorldView";
import type { PluginManager } from "../../src/plugins/manager";
import type { Socket } from "../../src/net/socket";
import { afterEveryTest } from "./cleanup";

type Fn<T> = T extends (...a: infer A) => infer R ? (...a: A) => R : never;
type MethodsOf<T> = { [K in keyof T]-?: T[K] extends (...a: never[]) => unknown ? K : never }[keyof T];
type Spies<T, K extends keyof T> = { [P in K]: Mock<Fn<T[P]>> };

type Session = typeof realSession;
type SessionMethod = MethodsOf<Session>;

// Every public method of Session. The two checks below fail the type check when Session gains or loses one.
const SESSION_METHODS = ["start", "setOsIdle", "stop", "setStatus", "toggleBusy", "backToAvailable", "setConsent", "chat", "locate", "emote",
  "follow", "goToPerson", "goHome", "claimDesk", "releaseDesk", "wave", "mute", "hand", "toggleHand", "note", "toggleRun", "lead", "lock",
  "knock", "force", "answerKnock", "board", "setEco"] as const satisfies readonly SessionMethod[];
type MissingSessionMethod = Exclude<SessionMethod, (typeof SESSION_METHODS)[number]>;
const sessionComplete: [MissingSessionMethod] extends [never] ? true : MissingSessionMethod = true;
void sessionComplete;
// Its public fields too: the fake has exactly these (a new public field fails here until the fake gets it).
type SessionField = Exclude<keyof Session, SessionMethod>;
const sessionFields: [SessionField] extends ["view" | "socket" | "plugins"] ? (["view" | "socket" | "plugins"] extends [SessionField] ? true : never) : SessionField = true;
void sessionFields;

// The parts of WorldView the UI reads through session.view (add one here when a component starts using it).
const VIEW_METHODS = ["currentMap", "mapImage", "goTo", "position", "setHover", "setEditing", "previewMap", "screenToTile", "toggleRun",
  "setDirection", "setEco", "interact"] as const satisfies readonly MethodsOf<WorldView>[];
const PLUGIN_METHODS = ["event", "closeModal", "sheetImage", "attachView", "dropNext"] as const satisfies readonly MethodsOf<PluginManager>[];

export type ViewFake = Spies<WorldView, (typeof VIEW_METHODS)[number]> & Pick<WorldView, "stats">;
export type PluginsFake = Spies<PluginManager, (typeof PLUGIN_METHODS)[number]>;
export type SocketFake = Spies<Socket, "send"> & Pick<Socket, "rtt">;
export type SessionFake = Spies<Session, SessionMethod> & { view: ViewFake | null; socket: SocketFake | null; plugins: PluginsFake | null };

function spies<T, K extends keyof T>(names: readonly K[]): Spies<T, K> {
  return Object.fromEntries(names.map((n) => [n, vi.fn()])) as unknown as Spies<T, K>;
}

const fake = spies<Session, SessionMethod>(SESSION_METHODS) as SessionFake;

/** A view with spies; currentMap and mapImage answer null (no map yet), position the origin, screenToTile tile 0,0. */
export function fakeView(): ViewFake {
  const v = spies<WorldView, (typeof VIEW_METHODS)[number]>(VIEW_METHODS) as ViewFake;
  v.currentMap.mockReturnValue(null);
  v.mapImage.mockReturnValue(null);
  v.position.mockReturnValue({ x: 0, y: 0 });
  v.screenToTile.mockReturnValue([0, 0]);
  v.stats = { fps: 0, frameMs: 0, worldMsgs: 0, entities: 0, visible: 0, renders: 0 };
  return v;
}

/** The plugin manager's spies: sheetImage answers null (no picture), attachView a detach spy. */
export function fakePlugins(): PluginsFake {
  const p = spies<PluginManager, (typeof PLUGIN_METHODS)[number]>(PLUGIN_METHODS);
  p.sheetImage.mockReturnValue(null);
  p.attachView.mockReturnValue(vi.fn());
  return p;
}

function reset(): void {
  for (const n of SESSION_METHODS) fake[n].mockReset();
  fake.claimDesk.mockResolvedValue(true);
  fake.releaseDesk.mockResolvedValue(true);
  fake.start.mockResolvedValue(undefined);
  fake.view = fakeView();
  fake.plugins = fakePlugins();
  fake.socket = { send: vi.fn(), rtt: 0 };
}
reset();
afterEveryTest(reset);

/**
 * The fake session the mocked module hands out: spies reset before every test, a fresh view, plugin manager and
 * socket each time (set `view` to null for "not in the world yet"). claimDesk and releaseDesk resolve true.
 */
export function mockSession(): SessionFake {
  return fake;
}

/** What `vi.mock("../src/session", ...)` returns: the real module's shape, with the fake as `session`. */
export function sessionModule(): typeof import("../../src/session") {
  return { session: fake as unknown as Session };
}
