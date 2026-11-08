// @vitest-environment jsdom
// Component test of the shared whiteboard's dialog (web/src/ui/WhiteboardDialog.tsx): axe finds no violation for a
// member, with the text tool, and for an administrator asked to confirm a clear; and its controls: who gets Clear
// board, what Undo, Clear and Place text send, Escape. The board's drawing is a canvas (jsdom has no 2D context:
// nothing is drawn, and axe only checks that the canvas has a name). Contrast stays in the browser
// (e2e/scenarios/a11y.ts: the administration dialog has the same chips, buttons and muted text on the same dialog
// skin); the `features` scenario keeps text and a pen stroke drawn on one page and seen on the other's canvas.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardModel } from "../src/game/boardModel";
import { t } from "../src/i18n";
import { setState } from "../src/store";
import { WhiteboardDialog } from "../src/ui/WhiteboardDialog";
import { expectNoAxeViolations } from "./axe";

const board = vi.hoisted(() => vi.fn());
vi.mock("../src/session", () => ({ session: { board } }));

afterEach(() => {
  cleanup();
  setState({ role: "member" });
});

// axe on jsdom takes seconds on a loaded machine (the gauntlet runs everything at once): more than the default 5 s
describe("whiteboard dialog", { timeout: 20000 }, () => {
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

describe("whiteboard dialog controls", { timeout: 20000 }, () => {
  // what the features scenario checked in two browsers; the server's half (only an administrator clears, and the
  // clear reaches everybody at the board) is world TestWhiteboardAuthorityFanoutUndoAndClear

  it("a member gets no Clear board button; Undo asks the server to take back my last stroke", async () => {
    board.mockClear();
    render(<WhiteboardDialog onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: t("board.clear") })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: t("board.undo") }));
    expect(board.mock.calls).toEqual([[{ bk: boardModel.key, op: "undo" }]]);
  });

  it("an administrator clears the board only once they confirm", async () => {
    board.mockClear();
    setState({ role: "admin" });
    render(<WhiteboardDialog onClose={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: t("board.clear") }));
    expect(board).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: t("board.confirmClear") }));
    expect(board.mock.calls).toEqual([[{ bk: boardModel.key, op: "clear" }]]);
    screen.getByRole("button", { name: t("board.clear") }); // and asks again next time
  });

  it("text placed in the centre goes to the server as one text stroke", async () => {
    board.mockClear();
    render(<WhiteboardDialog onClose={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: t("board.text") }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Shared test text " } });
    await user.click(screen.getByRole("button", { name: t("board.placeText") }));
    expect(board.mock.calls).toEqual([[expect.objectContaining({ bk: boardModel.key, op: "draw", k: 1, p: [400, 300], tx: "Shared test text" })]]);
  });

  it("Escape closes the board", async () => {
    const onClose = vi.fn();
    render(<WhiteboardDialog onClose={onClose} />);
    await userEvent.setup().keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
