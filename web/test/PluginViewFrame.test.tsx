// @vitest-environment jsdom
// Component test of a plugin view's frame in its modal (web/src/ui/PluginViewFrame.tsx): a view the plugin's host
// cannot run (not declared in the manifest, or it did not start) goes, and the rest of the modal stays. Why the host
// refuses it, and that the plugin goes on: web/test/pluginHost.test.ts.
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const attach = vi.fn<(plugin: string, view: string, frame: HTMLIFrameElement, fail: (reason: string) => void) => () => void>();
vi.mock("../src/session", () => ({ session: { plugins: { attachView: (...a: Parameters<typeof attach>) => attach(...a) } } }));
const { PluginViewFrame } = await import("../src/ui/PluginViewFrame");

afterEach(() => {
  cleanup();
  attach.mockReset();
});

const node = (view: string) => ({ type: "view" as const, view, label: view === "echo" ? "Echo view" : "Missing", height: "medium" as const });

function modal(view: string) {
  return render(
    <div role="dialog" aria-label="UI demo">
      <p>No view here</p>
      <PluginViewFrame plugin="ui-demo" node={node(view)} />
    </div>,
  );
}

it("a view the host runs is an iframe with sandbox=allow-scripts only, titled by its label", () => {
  attach.mockImplementation(() => () => {});
  const { container } = modal("echo");
  const f = container.querySelector("iframe")!;
  expect(f.getAttribute("sandbox")).toBe("allow-scripts");
  expect(f.title).toBe("Echo view");
  expect(attach).toHaveBeenCalledWith("ui-demo", "echo", f, expect.any(Function));
});

it("a view the host refuses is left out; the modal and its other content stay", () => {
  attach.mockImplementation((_p, _v, _f, fail) => { fail("not declared"); return () => {}; });
  const { container, getByRole, getByText } = modal("missing");
  expect(container.querySelector("iframe")).toBeNull();
  getByRole("dialog", { name: "UI demo" });
  getByText("No view here");
});
