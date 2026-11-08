// @vitest-environment jsdom
// Component test of the keyboard shortcuts dialog (web/src/ui/ShortcutsDialog.tsx) on a French AZERTY keyboard, as
// Chrome reports it through navigator.keyboard: letter shortcuts are named as printed at their key position (ZQSD,
// W for dance, "," for the minimap) while the reactions stay 1-7. web/src/keys.ts reads the layout once per module,
// so this file holds the AZERTY case only (QWERTY names without the Keyboard API: web/test/keys.test.ts). The browser
// keeps ? opening the dialog and Escape closing it (e2e/scenarios/presence.ts).
import { renderUI, stubKeyboardLayout } from "./support"; // first: canvas before PixiJS
import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ShortcutsDialog } from "../src/ui/ShortcutsDialog";
import { expectNoAxeViolations } from "./axe";

const AZERTY = { KeyW: "z", KeyA: "q", KeyS: "s", KeyD: "d", KeyZ: "w", KeyQ: "a", KeyM: ",", Digit1: "&", KeyX: "x", KeyH: "h", KeyU: "u", KeyR: "r" };

it("names the keys as printed on an AZERTY keyboard, keeps 1-7, and closes from its button", async () => {
  stubKeyboardLayout(AZERTY);
  const onClose = vi.fn();
  const { user, container } = renderUI(<ShortcutsDialog onClose={onClose} />);
  await screen.findByText("Z Q S D"); // once the layout is known
  const rows = [...container.querySelectorAll("table.keys tr")].map((r) => r.textContent);
  const row = (action: string) => rows.find((r) => r.endsWith(action));
  expect(row("Move")).toBe("Z Q S D / ↑ ← ↓ →Move");
  expect(row("Reactions")).toBe("1-7Reactions");
  expect(row("Dance")).toBe("WDance");
  expect(row("Show or hide the minimap")).toBe(",Show or hide the minimap");
  expect(row("Go back to your desk")).toBe("Ctrl+DGo back to your desk");
  expect(row("Zoom the map out or in")).toMatch(/^Ctrl \+ mouse wheel/);
  expect(row("This list")).toBe("?This list");
  await expectNoAxeViolations(container);
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalled();
});
