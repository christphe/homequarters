// @vitest-environment jsdom
// Component test of two parts of SocialControls (web/src/ui/SocialControls.tsx), with the session faked: the card a
// wave brings (Walk to them, Wave back, dismiss) and the on-screen hand button. The browser keeps a wave through the
// people panel's real button, seen by the person waved at, who answers with the card's real Walk to them, and the H
// key raising a hand others see (e2e/scenarios/presence.ts).
import { ME, person, renderUI, roster } from "./support"; // first: canvas before PixiJS
import { mockSession } from "./support/session";
import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { getState } from "../src/store";
import { SocialControls } from "../src/ui/SocialControls";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());

const waved = () => ({ wave: { id: 2, name: "Bruno" }, roster: roster(person(2, "Bruno")) });

it("a wave shows who waved, and Walk to them runs to that person and closes the card", async () => {
  const { user } = renderUI(<SocialControls />, waved());
  expect(screen.getByRole("alert").textContent).toContain("Bruno waved at you");
  await user.click(screen.getByRole("button", { name: "Walk to them" }));
  expect(mockSession().goToPerson.mock.calls).toEqual([[2]]);
  expect(getState().wave).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("Wave back waves at that person and closes the card", async () => {
  const { user } = renderUI(<SocialControls />, waved());
  await user.click(screen.getByRole("button", { name: "Wave back" }));
  expect(mockSession().wave.mock.calls).toEqual([[2]]);
  expect(getState().wave).toBeNull();
});

it("the dismiss button only closes the card", async () => {
  const { user } = renderUI(<SocialControls />, waved());
  await user.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(getState().wave).toBeNull();
  expect(mockSession().goToPerson).not.toHaveBeenCalled();
  expect(mockSession().wave).not.toHaveBeenCalled();
});

it("the hand button raises the hand", async () => {
  const { user } = renderUI(<SocialControls />);
  const raise = screen.getByRole("button", { name: "Raise hand (H)" });
  expect(raise.getAttribute("aria-pressed")).toBe("false");
  await user.click(raise);
  expect(mockSession().toggleHand).toHaveBeenCalledTimes(1);
});

it("once the server says my hand is up, the button shows it (pressed, Lower hand) and lowers it", async () => {
  const { user } = renderUI(<SocialControls />, { roster: new Map([[ME.id, { ...ME, h: 1 as const }]]) });
  const lower = screen.getByRole("button", { name: "Lower hand (H)" });
  expect(lower.getAttribute("aria-pressed")).toBe("true");
  await user.click(lower);
  expect(mockSession().toggleHand).toHaveBeenCalledTimes(1);
});
