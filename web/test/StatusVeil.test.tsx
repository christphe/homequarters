// @vitest-environment jsdom
// Component test of the status veil (web/src/ui/StatusVeil.tsx), with the session faked: busy and away grey the map
// out under a big button that makes you available again; the other statuses show nothing. And what Ctrl+U makes of
// each status (busyToggle in web/src/game/home.ts, which Session.toggleBusy follows). The browser keeps Ctrl+U for
// real, seen by somebody else, and a click on the veil's button (e2e/scenarios/presence.ts).
import { renderUI } from "./support"; // first: canvas before PixiJS
import { mockSession } from "./support/session";
import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { busyToggle } from "../src/game/home";
import type { Status } from "../src/net/protocol";
import { StatusVeil } from "../src/ui/StatusVeil";
import { expectNoAxeViolations } from "./axe";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());

it("busy greys the map out under a big button, which makes you available again", async () => {
  const { user, container } = renderUI(<StatusVeil />, { status: "busy" });
  const veil = screen.getByRole("region", { name: "You are busy" });
  expect(veil.dataset.status).toBe("busy");
  expect(veil.textContent).toContain("Ctrl+U");
  await expectNoAxeViolations(container);
  await user.click(screen.getByRole("button", { name: "You are busy" }));
  expect(mockSession().backToAvailable).toHaveBeenCalledTimes(1);
  expect(mockSession().setStatus).not.toHaveBeenCalled();
});

it("away shows the veil too", async () => {
  const { user } = renderUI(<StatusVeil />, { status: "away" });
  expect(screen.getByRole("region", { name: "You are away" }).dataset.status).toBe("away");
  await user.click(screen.getByRole("button", { name: "You are away" }));
  expect(mockSession().backToAvailable).toHaveBeenCalledTimes(1);
});

it.each<Status>(["available", "invisible"])("%s: no veil", (status) => {
  const { container } = renderUI(<StatusVeil />, { status });
  expect(container.querySelector(".status-veil")).toBeNull();
});

it("Ctrl+U makes you busy, and brings you back from busy or away", () => {
  expect(busyToggle("available")).toBe("busy");
  expect(busyToggle("invisible")).toBe("busy");
  expect(busyToggle("busy")).toBe("available");
  expect(busyToggle("away")).toBe("available");
});
