// @vitest-environment jsdom
// Component test of the people list of SidePanel (web/src/ui/SidePanel.tsx): a person's row and its "More actions"
// menu, with the session faked. The real controls stay in the browser suite: e2e/scenarios/features.ts opens the
// menu, requests to lead and follows through it, with the server answering.
import { canvasCalls, person, renderUI, roster } from "./support"; // first: its canvas is in place before PixiJS loads
import { mockSession } from "./support/session";
import { screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SidePanel } from "../src/ui/SidePanel";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());

const ADMIN = person(2, "Admin", { r: "admin" });

function show() {
  const ui = renderUI(<SidePanel />, { roster: roster(ADMIN) });
  const row = screen.getByText("Admin").closest("li")!;
  const more = within(row).getByRole("button", { name: "More actions for Admin" });
  return { ...ui, row, more, menu: () => document.querySelector(".more-menu") };
}

it("a person's row has four buttons: walk to, wave, message and more; my own row has none", () => {
  const { row } = show();
  expect(within(row).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Walk to Admin", "Wave at Admin", "Message Admin", "More actions for Admin"]);
  const mine = screen.getByText("(you)").closest("li")!;
  expect(within(mine).queryAllByRole("button")).toEqual([]);
});

it("draws each person's avatar", () => {
  const { row } = show();
  expect(canvasCalls(row.querySelector("canvas")!)).not.toEqual([]);
});

it("Walk to and Wave at ask the server about that person", async () => {
  const { user, row } = show();
  const s = mockSession();
  await user.click(within(row).getByRole("button", { name: "Walk to Admin" }));
  await user.click(within(row).getByRole("button", { name: "Wave at Admin" }));
  expect(s.goToPerson).toHaveBeenCalledWith(2);
  expect(s.wave).toHaveBeenCalledWith(2);
});

it("More actions opens a menu with its first item focused, and Escape closes it, giving the focus back", async () => {
  const { user, more, menu } = show();
  await user.click(more);
  expect(more.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Follow Admin" }));
  await user.keyboard("{Escape}");
  expect(menu()).toBeNull();
  expect(more.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(more);
});

it("choosing an action closes the menu and does it", async () => {
  const { user, more, menu } = show();
  const s = mockSession();
  for (const [label, spy] of [["Follow Admin", s.follow], ["Request to lead Admin", s.lead], ["Locate Admin", s.locate]] as const) {
    await user.click(more);
    await user.click(screen.getByRole("button", { name: label }));
    expect(menu(), label).toBeNull();
    expect(spy, label).toHaveBeenCalledWith(2);
  }
});

it("a press elsewhere closes the menu without doing anything", async () => {
  const { user, more, menu } = show();
  const s = mockSession();
  await user.click(more);
  await user.click(screen.getByText("Admin"));
  expect(menu()).toBeNull();
  expect([s.follow, s.lead, s.locate].every((f) => f.mock.calls.length === 0)).toBe(true);
});
