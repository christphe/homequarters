// @vitest-environment jsdom
// Component test of SocialControls' movement controls (web/src/ui/SocialControls.tsx), with the session faked: the
// "Always run" button shows whether I run, a request to lead asks before anybody moves, and "Stop following" ends a
// follow. It replaces the browser checks "the HUD shows the run toggle state" (movement) and "request to lead asks the
// other person before moving them" (features). The browser keeps the run button pressed for real before the jitter
// checks (movement) and a request to lead sent through the people panel's menu and declined with "Not now" (features).
import { renderUI } from "./support"; // first: its canvas is in place before PixiJS loads
import { mockSession } from "./support/session";
import { screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { t } from "../src/i18n";
import { getState } from "../src/store";
import { SocialControls } from "../src/ui/SocialControls";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());

const runButton = () => screen.getByRole("button", { name: t("run.toggle") });

it("the run button shows whether I run, and asks the session to toggle it", async () => {
  const { user, unmount } = renderUI(<SocialControls />, { running: true });
  expect(runButton().getAttribute("aria-pressed")).toBe("true");
  await user.click(runButton());
  expect(mockSession().toggleRun).toHaveBeenCalledTimes(1);
  unmount();
  renderUI(<SocialControls />, { running: false });
  expect(runButton().getAttribute("aria-pressed")).toBe("false");
});

it("a request to lead asks me first: Not now moves nobody", async () => {
  const { user } = renderUI(<SocialControls />, { leadRequest: { id: 2, name: "Admin" } });
  const dialog = screen.getByRole("dialog", { name: t("follow.lead") });
  expect(dialog.textContent).toContain(t("follow.request", { name: "Admin" }));
  expect(mockSession().follow).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: t("follow.decline") }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(getState().leadRequest).toBeNull();
  expect(mockSession().follow).not.toHaveBeenCalled();
});

it("accepting a request to lead follows that person", async () => {
  const { user } = renderUI(<SocialControls />, { leadRequest: { id: 2, name: "Admin" } });
  await user.click(screen.getByRole("button", { name: t("follow.accept") }));
  expect(mockSession().follow).toHaveBeenCalledWith(2);
  expect(getState().leadRequest).toBeNull();
});

it("while I follow somebody, Stop following ends it", async () => {
  const { user } = renderUI(<SocialControls />, { following: { id: 2, name: "Admin" } });
  screen.getByText(t("follow.active", { name: "Admin" }));
  await user.click(screen.getByRole("button", { name: t("follow.stop") }));
  expect(mockSession().follow).toHaveBeenCalledWith(0);
});
