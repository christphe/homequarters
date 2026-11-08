// @vitest-environment jsdom
// Component test of the shared whiteboard's dialog (web/src/ui/WhiteboardDialog.tsx): axe finds no violation for a
// member, with the text tool, and for an administrator asked to confirm a clear. The board's drawing is a canvas
// (jsdom has no 2D context: nothing is drawn, and axe only checks that the canvas has a name). Contrast stays in the
// browser (e2e/scenarios/a11y.ts: the administration dialog has the same chips, buttons and muted text on the same
// dialog skin); drawing and its persistence are the `features` scenario.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, vi } from "vitest";
import { t } from "../src/i18n";
import { setState } from "../src/store";
import { WhiteboardDialog } from "../src/ui/WhiteboardDialog";
import { expectNoAxeViolations } from "./axe";

vi.mock("../src/session", () => ({ session: { board: vi.fn() } }));

afterEach(() => {
  cleanup();
  setState({ role: "member" });
});

describe("whiteboard dialog", () => {
  it("a member, with the pen: no axe violation", async () => {
    render(<WhiteboardDialog onClose={() => {}} />);
    screen.getByRole("dialog", { name: t("board.title") });
    await expectNoAxeViolations();
  });

  it("a member, with the text tool: no axe violation", async () => {
    render(<WhiteboardDialog onClose={() => {}} />);
    await userEvent.setup().click(screen.getByRole("button", { name: t("board.text") }));
    screen.getByRole("button", { name: t("board.placeText") });
    await expectNoAxeViolations();
  });

  it("an administrator confirming a clear: no axe violation", async () => {
    setState({ role: "admin" });
    render(<WhiteboardDialog onClose={() => {}} />);
    await userEvent.setup().click(screen.getByRole("button", { name: t("board.clear") }));
    screen.getByRole("button", { name: t("board.confirmClear") });
    await expectNoAxeViolations();
  });
});
