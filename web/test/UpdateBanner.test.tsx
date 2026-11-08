// @vitest-environment jsdom
// Component test of the update dialog (web/src/ui/UpdateBanner.tsx): shown once the store says this page is older than
// the server (`outdated`, set from the hello's version: version.test.ts), with Reload as the only way on: Escape and a
// click outside leave it open. The page naming its version is TestThePageCarriesTheServerVersion. The browser keeps
// the deploy itself, in e2e/scenarios/update.ts: the server restarts with another version, the page asks, and Reload
// brings the new version.
import { renderUI } from "./support"; // first: canvas before PixiJS
import { fireEvent, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { setState } from "../src/store";
import { UpdateBanner } from "../src/ui/UpdateBanner";

it("nothing shows while the page is up to date, the dialog as soon as it is not", () => {
  renderUI(<UpdateBanner />);
  expect(screen.queryByRole("dialog")).toBeNull();
  setState({ outdated: true });
  return screen.findByRole("dialog", { name: "New version" });
});

it("asks to reload, and neither Escape nor a click outside closes it", async () => {
  const { user } = renderUI(<UpdateBanner />, { outdated: true });
  const dialog = screen.getByRole("dialog", { name: "New version" });
  screen.getByText("A new version of Home Quarters is ready. Reload to keep going.");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reload" })); // the only way on, focused
  await user.keyboard("{Escape}");
  fireEvent.mouseDown(dialog.parentElement!); // the scrim around it
  expect(screen.getByRole("dialog", { name: "New version" })).toBe(dialog);
});
