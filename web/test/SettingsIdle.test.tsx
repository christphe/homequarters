// @vitest-environment jsdom
// Component test of the settings dialog's idle-detection setting (web/src/ui/SettingsDialog.tsx, web/src/osIdle.ts),
// with the session faked and Idle Detection stubbed: a browser that blocks it gets an explanation and the address to
// allow it, and the setting stays off; a granted permission turns it on. What idle and locked then do to the status:
// web/test/osIdle.test.ts. The browser keeps the real checkbox with a granted permission and an idle computer
// setting me away for others (e2e/scenarios/presence.ts).
import { renderUI, stubIdleDetector, onCleanup } from "./support"; // first: canvas before PixiJS
import { mockSession } from "./support/session";
import { screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { getState } from "../src/store";
import { SettingsDialog } from "../src/ui/SettingsDialog";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());
vi.mock("../src/media/MediaManager", async (original) => (await import("./support/media")).mediaModule(await original<typeof import("../src/media/MediaManager")>()));

const NAME = /Go away when my computer is idle or locked/;
const show = () => renderUI(<SettingsDialog onClose={() => {}} />);

/** navigator.permissions answering `state` for idle-detection (jsdom has no Permissions API). */
function permissionState(state: PermissionState) {
  const before = Object.getOwnPropertyDescriptor(navigator, "permissions");
  Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: vi.fn(async () => ({ state })) } });
  onCleanup(() => { if (before) Object.defineProperty(navigator, "permissions", before); else delete (navigator as { permissions?: unknown }).permissions; });
}

it("a browser that blocks idle detection gets an explanation next to the setting, which stays off", async () => {
  stubIdleDetector("denied");
  const { user } = show();
  await user.click(screen.getByRole("checkbox", { name: NAME }));
  const note = await screen.findByRole("alert");
  expect(note.textContent).toContain("Your browser blocks idle detection for this site");
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Browser setting for idle detection" }).value).toBe("chrome://settings/content/idleDetection");
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: NAME }).checked).toBe(false);
  expect(getState().settings.osIdle).toBe(false);
  expect(mockSession().setOsIdle).not.toHaveBeenCalled();
});

it("a permission the browser already blocks is reported without asking (Chrome's request would never answer)", async () => {
  const idle = stubIdleDetector("granted");
  idle.requestPermission.mockImplementation(() => new Promise(() => {}));
  permissionState("denied");
  const { user } = show();
  await user.click(screen.getByRole("checkbox", { name: NAME }));
  await screen.findByRole("alert");
  expect(idle.requestPermission).not.toHaveBeenCalled();
  expect(getState().settings.osIdle).toBe(false);
});

it("with the permission granted, ticking the box turns the setting on and starts watching", async () => {
  stubIdleDetector("granted");
  const { user } = show();
  await user.click(screen.getByRole("checkbox", { name: NAME }));
  await waitFor(() => expect(getState().settings.osIdle).toBe(true));
  expect(mockSession().setOsIdle.mock.calls).toEqual([[true]]);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("without Idle Detection (Firefox, Safari) the setting is disabled and says why", () => {
  show();
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: NAME }).disabled).toBe(true);
  expect(screen.getByText(/not available in this browser/)).toBeTruthy();
});
