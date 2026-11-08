// @vitest-environment jsdom
// Component test of the chat panel's conversation scope (web/src/ui/SidePanel.tsx) and of the phone's reactions menu
// (web/src/ui/SocialControls.tsx), with the session faked: the conversation composer is off until there is a
// conversation, and a reaction chosen on a phone closes the menu. The browser keeps, in e2e/scenarios/social.ts, what
// only it shows: a message sent through the real composer, nothing covering the chat panel's controls at 800x450 and on
// a 390x844 phone, and every expanded reaction fitting the phone's screen.
import { onCleanup, renderUI } from "./support"; // first: canvas before PixiJS
import { mockSession } from "./support/session";
import { screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SidePanel } from "../src/ui/SidePanel";
import { SocialControls } from "../src/ui/SocialControls";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());

/** matchMedia answering as a phone (every "max-width" query matches, no "min-width" one). */
function phone() {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener: () => {}, removeEventListener: () => {} }));
}

async function conversationScope(patch = {}) {
  // jsdom has no scrollIntoView, which the message list calls to show the newest message
  const had = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Element.prototype.scrollIntoView = () => {};
  onCleanup(() => { if (had) Object.defineProperty(Element.prototype, "scrollIntoView", had); else delete (Element.prototype as Partial<Element>).scrollIntoView; });
  const ui = renderUI(<SidePanel />, patch);
  await ui.user.click(screen.getByRole("tab", { name: "Chat" }));
  await ui.user.click(screen.getByRole("button", { name: "Conversation" }));
  return ui;
}

it("without a conversation the conversation composer is off, and says how to start one", async () => {
  await conversationScope();
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Write a message…" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(true);
  expect(screen.getAllByText("Walk up to someone to talk.").length).toBeGreaterThan(0);
});

it("in a conversation the conversation composer is on", async () => {
  await conversationScope({ conv: { kind: "p", name: "", members: [1, 2], state: "live" } });
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Write a message…" }).disabled).toBe(false);
});

it("on a phone the reactions sit behind one button, and choosing one sends it and closes the menu", async () => {
  phone();
  const { user } = renderUI(<SocialControls />);
  const toggle = screen.getByRole("button", { name: "Reactions" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Dance (Z)" })).toBeNull();
  await user.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await user.click(within(screen.getByRole("region", { name: "Reactions" })).getByRole("button", { name: "Dance (Z)" }));
  expect(mockSession().emote).toHaveBeenCalledWith(8);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Dance (Z)" })).toBeNull();
});
