// @vitest-environment jsdom
// Component test of the status menu (web/src/ui/StatusMenu.tsx): axe finds no violation with the menu closed, open,
// and open with a note set (its Clear button), inside the banner landmark that holds it in the office. The browser
// still audits the open menu once for its contrast (e2e/scenarios/a11y.ts); typing a note through it is the
// `presence` scenario.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, vi } from "vitest";
import { t } from "../src/i18n";
import type { Person } from "../src/net/protocol";
import { setState } from "../src/store";
import { StatusMenu } from "../src/ui/StatusMenu";
import { expectNoAxeViolations } from "./axe";

vi.mock("../src/session", () => ({ session: { setStatus: vi.fn(), note: vi.fn() } }));

afterEach(cleanup);

/** The menu where OfficeScreen puts it (the top bar, a banner landmark), for a busy member with this note. */
function show(note: string) {
  setState({ meId: 1, status: "busy", roster: new Map([[1, { id: 1, n: "Ada", m: note } as unknown as Person]]) });
  render(<header className="topbar"><StatusMenu /></header>);
  return () => userEvent.setup().click(screen.getByRole("button", { name: t("status.busy") }));
}

describe("status menu", () => {
  it("closed: no axe violation", async () => {
    show("");
    await expectNoAxeViolations();
  });

  it("open, without a note: no axe violation", async () => {
    await show("")();
    screen.getByRole("textbox", { name: t("note.label") });
    await expectNoAxeViolations();
  });

  it("open, with a note (its Clear button): no axe violation", async () => {
    await show("At lunch")();
    screen.getByRole("button", { name: t("note.clear") });
    await expectNoAxeViolations();
  });
});
