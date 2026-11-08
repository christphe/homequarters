// Component test of Modal (web/src/ui/Modal.tsx) through Testing Library: what a person using a keyboard gets.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../src/ui/Modal";

afterEach(cleanup);

function Page({ onClose }: { onClose?: () => void }) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <button onClick={() => setShown(true)}>Open settings</button>
      {shown && (
        <Modal title="Settings" onClose={() => { onClose?.(); setShown(false); }}>
          <button>First</button>
          <input aria-label="Name" />
          <button>Last</button>
        </Modal>
      )}
    </>
  );
}

async function openIt(onClose?: () => void) {
  const user = userEvent.setup();
  render(<Page onClose={onClose} />);
  const opener = screen.getByRole("button", { name: "Open settings" });
  await user.click(opener);
  return { user, opener };
}

describe("Modal", () => {
  it("is a modal dialog with an accessible name", async () => {
    await openIt();
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("moves focus to its first control", async () => {
    await openIt();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  });

  it("keeps Tab inside, wrapping from the last control to the first", async () => {
    const { user } = await openIt();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  });

  it("keeps Shift+Tab inside, wrapping from the first control to the last", async () => {
    const { user } = await openIt();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    const { user } = await openIt(onClose);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives focus back to what had it before it opened", async () => {
    const { user, opener } = await openIt();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(opener);
  });

  it("only the innermost of two open dialogs answers Escape", async () => {
    const outer = vi.fn(), inner = vi.fn();
    const user = userEvent.setup();
    render(<><Modal title="Outer" onClose={outer}><button>A</button></Modal><Modal title="Inner" onClose={inner}><button>B</button></Modal></>);
    await user.keyboard("{Escape}");
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
