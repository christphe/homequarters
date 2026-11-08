// @vitest-environment jsdom
// Component test of the status note, with the session faked: typed in the status menu (web/src/ui/StatusMenu.tsx)
// it goes to the server; in the roster (the server echoes it, world TestRaisedHandAndStatusNoteAreInTheRoster) it
// shows under the person in the people panel (web/src/ui/SidePanel.tsx). The browser keeps the status menu's real
// status change through Ctrl+U and its veil (e2e/scenarios/presence.ts) and its contrast (e2e/scenarios/a11y.ts).
import { person, renderUI, roster } from "./support"; // first: canvas before PixiJS
import { mockSession } from "./support/session";
import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SidePanel } from "../src/ui/SidePanel";
import { StatusMenu } from "../src/ui/StatusMenu";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());

it("a note typed in the status menu is sent, trimmed, and the menu closes", async () => {
  const { user } = renderUI(<StatusMenu />);
  await user.click(screen.getByRole("button", { name: "Available" }));
  await user.type(screen.getByRole("textbox", { name: "Status note" }), "  Deep work until 4 ");
  await user.click(screen.getByRole("button", { name: "Set" }));
  expect(mockSession().note.mock.calls).toEqual([["Deep work until 4"]]);
  expect(screen.queryByRole("textbox", { name: "Status note" })).toBeNull();
});

it("a person's note shows under their name in the people panel", () => {
  renderUI(<SidePanel />, { roster: roster(person(2, "Bruno", { m: "Deep work until 4" }), person(3, "Cleo")) });
  const notes = [...document.querySelectorAll(".people .note")].map((n) => n.textContent);
  expect(notes).toEqual(["Deep work until 4"]);
});
