# Component-test support

Helpers for the client's component tests (`web/test/*.test.tsx`, Vitest with React Testing Library and user-event on jsdom; [decision 0038](../../../docs/decisions/0038-pnpm-workspace-vitest.md)). They exist so a test of a panel or dialog can start from a known store, fake what the component talks to, and still fail loudly when it does something the test did not expect. Examples: `SidePanel.test.tsx` (session fake), `SettingsDialog.test.tsx` (fetch, offline), `VideoDock.test.tsx` (media fake), and `support.test.tsx`, which checks the helpers themselves.

## The rule

**Every component test that runs on a fake (session, media, fetch) keeps one browser check of the same feature, through its real controls.** A fake proves what the component asks for, not that the bundle wires it to the real session, LiveKit or server: the browser check is what catches a wrong import, a missing provider or a server that answers differently. Before you delete a browser check that a component test now covers, name the browser check that stays for that feature in the scenario's header comment (as `e2e/scenarios/consent.ts` and `offices.ts` do), and name it in the component test's header too. What only a browser shows stays there: CSS hover and focus styles, layout, real media, PixiJS frames, timing against the server's tick.

## Starting a test file

```tsx
// @vitest-environment jsdom
// Component test of <what>: <what it checks>. The browser keeps <which check, in which scenario>.
import { renderUI, person, roster } from "./support"; // first: see "Import order"
import { mockSession } from "./support/session";
import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SidePanel } from "../src/ui/SidePanel";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());

it("Wave at asks the server", async () => {
  const { user } = renderUI(<SidePanel />, { roster: roster(person(2, "Bruno")) });
  await user.click(screen.getByRole("button", { name: "Wave at Bruno" }));
  expect(mockSession().wave).toHaveBeenCalledWith(2);
});
```

Everything a helper sets up is undone after each test (`cleanup.ts`): Testing Library unmounts, stubs are removed, the fakes' spies and the store are reset. That includes `vi.unstubAllGlobals()` after every test: make a `vi.stubGlobal` in `beforeEach` or in the test, never once in `beforeAll` or at the top of the file. A request or timer that outlives its test is not caught: it reaches the real `fetch` and its store writes land in the next test, so a component with polling or retries needs fake timers (`vi.useFakeTimers()`) or an unmount and an awaited settle before the test ends.

**Import order.** Import `./support` (or any helper) before the components: importing it puts the canvas and media-element stubs in place, and PixiJS probes a canvas as it loads (jsdom then prints "not implemented").

## Helpers

| Helper | File | What it is for |
| --- | --- | --- |
| `renderUI(ui, patch?)` | `render.tsx` | Resets the store, renders `ui`, returns Testing Library's result plus `user` (a user-event session). |
| `resetStore(patch?)`, `baseState()` | `render.tsx` | The known state: the app's initial state, in the office (`phase: "play"`, `conn: "open"`), signed in as `ME` (id 1, "Me", in the roster), storage empty. A patch replaces whole keys (a `roster` replaces the base one: build it with `roster(...)`). Reset after every test as well. |
| `person(id, name, patch?)`, `roster(...people)`, `ME`, `LOOK` | `render.tsx` | Roster entries typed as `Person` (web/src/net/protocol.ts); `roster` adds `ME`. |
| `mockSession()`, `sessionModule()` | `session.ts` | The `session` singleton faked: every public method of `Session` is a `vi.fn` typed with the real signature (a renamed, added or removed method, or a new public field, fails `tsc -p tsconfig.test.json`), plus `view` (spies for the WorldView methods components call, listed in `VIEW_METHODS`, which you extend when a component calls another: `currentMap` and `mapImage` answer null), `plugins` (PluginManager spies) and `socket` (`send`, `rtt`). Set `view` to null for "not in the world". Mock with `vi.mock("../src/session", async () => (await import("./support/session")).sessionModule())`. |
| `mockMedia()`, `mediaModule(original)`, `tile(patch?)` | `media.ts` | `media` and `spotlightMedia` faked: MediaManager's public methods as typed spies, tiles set by the test (`setTiles` tells subscribers, as LiveKit's changes do); `active()` is what `activeMedia()` returns (its rule is copied from MediaManager.ts: keep them in step). A new public method or field of MediaManager fails `tsc`. The module's pure helpers stay real. Mock with `vi.mock("../src/media/MediaManager", async (original) => (await import("./support/media")).mediaModule(await original<typeof import("../src/media/MediaManager")>()))`. |
| `stubFetch(routes)` | `fetch.ts` | Answers `fetch` from `{ "METHOD /path": reply }` (`/prefix*` matches a prefix; a reply is `{ status?, json? }`, a `Response`, or a function of the request). Records `requests` (method, path, query, parsed body). A request no route answers gets a 404 **and fails the test**: `request()` (web/src/net/http.ts) never throws, so a forgotten route would otherwise pass unseen. |
| `offlineFetch()` | `fetch.ts` | `fetch` rejecting with a `TypeError`, as with no network: `request()` answers `{ ok: false, status: 0 }` and the component takes its error path. |
| `unhandledRejections()` | `fetch.ts` | Collects promise rejections nobody handled during the test, to assert there were none (`expect(r).toEqual([])` after a `setTimeout(0)`). While it listens Vitest does not report them, so it fails closed: one still in the list when the test ends fails the test. |
| `installCanvas()`, `canvasCalls(canvas)` | `canvas.ts` | A 2D context for jsdom that draws nothing and records each call's name (AvatarCanvas, Minimap); WebGL stays null. In repo, no `canvas` package. |
| `installMediaElements()` | `mediaElements.ts` | `play()` that resolves, `pause()`, `paused` for `<audio>`/`<video>` (web/src/audioOut.ts plays on the first key press). |
| `stubMediaDevices(devices, { display? })`, `fakeDevice`, `fakeTrack`, `fakeStream` | `navigator.ts` | `navigator.mediaDevices`: `enumerateDevices` lists `devices`, `getUserMedia` answers a fake track per kind on the asked device, `getDisplayMedia` a video track (absent with `display: false`); all spies (`mockRejectedValueOnce(new DOMException("", "NotAllowedError"))` for errors); `change()` fires `devicechange`. Tracks' `stop` is a spy. |
| `stubIdleDetector(permission)` | `navigator.ts` | `IdleDetector` answering `permission`; `set("idle")`, `set("active", "locked")` fire `change` on running detectors; `started` lists their options. |
| `stubKeyboardLayout(map)` | `navigator.ts` | `navigator.keyboard.getLayoutMap` answering `map` (`{ KeyW: "z" }`). web/src/keys.ts reads it once per module: another layout needs its own test file (`vi.resetModules()` would also reload the store, and `renderUI` would keep resetting the old one). |
| `onCleanup(f)`, `afterEveryTest(f)` | `cleanup.ts` | Undo something after this test, or after every test of the file. |

**Toasts.** `toast()` (web/src/store.ts) is drawn by OfficeScreen; a dialog's test reads `getState().toast`. Its 4 s timer is real: use `vi.useFakeTimers()` in a test that waits for a toast to go.

**Accessibility.** Use `web/test/axe.ts` (from #63): `await expectNoAxeViolations(container)` after rendering, or `axeViolations()` to read the rule ids. It runs the browser suite's tags with colour contrast off (jsdom paints nothing) and frames not entered; contrast and full screens stay in the browser `a11y` scenario. Do not write a second axe helper.
