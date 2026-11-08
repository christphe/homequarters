// @vitest-environment jsdom
// Component test of an interactive object's dialog (web/src/ui/ObjectDialog.tsx): axe finds no violation for a note,
// a website or an image before its content is loaded, once loaded, an image that failed, and a link the dialog refuses.
// Contrast stays in the browser (e2e/scenarios/a11y.ts: the settings dialog has the same text and buttons on the same
// dialog skin; the "Open in a new tab" link, in the browser's default link colour, is on no audited screen);
// opening a note with X next to it is the `features` scenario.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "../src/i18n";
import type { ObjectReply } from "../src/net/protocol";
import { ObjectDialog } from "../src/ui/ObjectDialog";
import { expectNoAxeViolations } from "./axe";

afterEach(cleanup);

const obj = (k: ObjectReply["k"], d: string, l = ""): ObjectReply => ({ t: "obj", k, l, d });
const load = () => userEvent.setup().click(screen.getByRole("button", { name: t("object.load") }));

describe("object dialog", () => {
  it("a note: no axe violation", async () => {
    render(<ObjectDialog object={obj("note", "Lunch at noon.\nBring a plate.", "Kitchen rules")} onClose={() => {}} />);
    screen.getByRole("dialog", { name: "Kitchen rules" });
    await expectNoAxeViolations();
  });

  it("a website, not loaded yet: no axe violation", async () => {
    render(<ObjectDialog object={obj("embed", "https://example.org/board", "Team board")} onClose={() => {}} />);
    screen.getByRole("link", { name: t("object.openLink") });
    await expectNoAxeViolations();
  });

  it("a website, loaded, without a label: no axe violation", async () => {
    render(<ObjectDialog object={obj("embed", "https://example.org/board")} onClose={() => {}} />);
    await load();
    expect(document.querySelector("iframe.object-embed")).not.toBeNull(); // its name is axe's to check
    await expectNoAxeViolations();
  });

  it("an image, loaded: no axe violation", async () => {
    render(<ObjectDialog object={obj("image", "https://example.org/team.png", "The team")} onClose={() => {}} />);
    await load();
    expect(document.querySelector("img.object-image")).not.toBeNull(); // its text alternative is axe's to check
    await expectNoAxeViolations();
  });

  it("an image that failed to load: no axe violation", async () => {
    render(<ObjectDialog object={obj("image", "https://example.org/team.png", "The team")} onClose={() => {}} />);
    await load();
    fireEvent.error(document.querySelector("img.object-image")!);
    screen.getByRole("alert");
    await expectNoAxeViolations();
  });

  it("a link it refuses (not https): no axe violation", async () => {
    render(<ObjectDialog object={obj("embed", "javascript:alert(1)", "Bad")} onClose={() => {}} />);
    screen.getByRole("dialog", { name: "Bad" });
    await expectNoAxeViolations();
  });
});
