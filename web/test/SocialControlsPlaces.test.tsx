// @vitest-environment jsdom
// Component test of the door and desk buttons of web/src/ui/SocialControls.tsx on a fake session: Release desk in my
// desk room asks first, then asks the session; an administrator at a closed door gets Enter anyway, which asks the
// session to force it. Which buttons show where is web/test/doors.test.ts; the server's side is
// TestReleaseMyDesk (world/desk_test.go), the release through the API in TestClaimDeskThroughTheAPI
// (httpapi/desk_test.go), the forced door in TestAssignedOfficeOwnerKnockAndAdmit (world/office_test.go) and
// TestAForcedDoorIsInTheActivityLog (httpapi/doors_test.go). The browser keeps the same panel's real controls
// against the server: Knock and Let in, and Take this desk, in e2e/scenarios/offices.ts.
import { person, renderUI, roster } from "./support";
import { mockSession } from "./support/session";
import { screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Area, MapData } from "../src/net/protocol";
import { SocialControls } from "../src/ui/SocialControls";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());

const room = (o: Partial<Area>): Area => ({ id: "r", name: "Room", kind: "room", x: 0, y: 0, w: 4, h: 4, floor: "wood", access: { mode: "open" }, ...o });
// a hall (0), Office 2 owned by 7 (1), the desk room of my desk at (20,2) (2), as the server's Compile makes them
const myDesk = { t: "desk", x: 20, y: 2, w: 2, h: 1, label: "Desk 4", assign: 1 };
const MAP = {
  version: 1, tile: 16, w: 30, h: 12, walls: [], solid: [],
  props: [myDesk],
  areas: [
    { id: "hall", name: "Offices hall", kind: "zone", x: 0, y: 0, w: 14, h: 2, floor: "wood", access: { mode: "open" } },
    room({ id: "office-2", name: "Office 2", x: 0, y: 3, w: 6, h: 6, access: { mode: "office", users: [7] } }),
    room({ id: "desk-20-2", name: "Desk", x: 20, y: 2, w: 2, h: 3, auto: true, access: { mode: "open", users: [1] } }),
  ],
} as unknown as MapData;

beforeEach(() => {
  mockSession().view!.currentMap.mockReturnValue(MAP);
});

it("Release desk in my desk room asks first, then releases that desk", async () => {
  mockSession().view!.position.mockReturnValue({ x: 20 * 16 + 8, y: 3 * 16 + 8 });
  const { user } = renderUI(<SocialControls />, { areaIndex: 2 });
  expect(screen.getByRole("button", { name: "Lock desk" })).toBeTruthy(); // next to it
  await user.click(screen.getByRole("button", { name: "Release desk" }));
  const dialog = screen.getByRole("dialog", { name: "Release Me's desk?" });
  expect(mockSession().releaseDesk).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Release it" }));
  expect(mockSession().releaseDesk).toHaveBeenCalledExactlyOnceWith(myDesk);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("an administrator at a closed office door gets Enter anyway, which forces that door", async () => {
  mockSession().view!.position.mockReturnValue({ x: 3 * 16, y: 24 }); // in the hall, 24 px above Office 2
  const { user } = renderUI(<SocialControls />, { areaIndex: 0, denied: [1], role: "admin", owners: new Map([[7, "Ana"]]), roster: roster(person(7, "Ana")) });
  expect(screen.getByRole("button", { name: "Knock · Office 2 · Ana" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Enter anyway (admin)" }));
  expect(mockSession().force).toHaveBeenCalledExactlyOnceWith(1);
  expect(mockSession().knock).not.toHaveBeenCalled();
});

it("a member at the same door gets Knock only", () => {
  mockSession().view!.position.mockReturnValue({ x: 3 * 16, y: 24 });
  renderUI(<SocialControls />, { areaIndex: 0, denied: [1], role: "member", owners: new Map([[7, "Ana"]]) });
  expect(screen.getByRole("button", { name: "Knock · Office 2 · Ana" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Enter anyway (admin)" })).toBeNull();
});
