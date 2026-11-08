// @vitest-environment jsdom
// Component test of SettingsDialog (web/src/ui/SettingsDialog.tsx): its profile (with a look from the appearance
// dialog) and sign-in link requests, answered or failing on the network, and what it offers with sign-in on or off
// (Sign out, the personal link), with the session and the media managers faked. The toast itself is drawn by
// OfficeScreen; here it is the store's `toast`. The browser suite keeps one real round trip of each: the profile save
// through the settings and appearance dialogs (e2e/scenarios/social.ts), the sign-in round trip
// (e2e/scenarios/auth.ts), and a request failing on the network through the real page (the map editor's Save,
// e2e/scenarios/offline.ts).
import { offlineFetch, renderUI, stubFetch, unhandledRejections, type StubRequest } from "./support"; // first: canvas before PixiJS
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { getState } from "../src/store";
import { SettingsDialog } from "../src/ui/SettingsDialog";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());
vi.mock("../src/media/MediaManager", async (original) => (await import("./support/media")).mediaModule(await original<typeof import("../src/media/MediaManager")>()));

const show = () => renderUI(<SettingsDialog onClose={() => {}} />);
const tick = () => new Promise((r) => setTimeout(r, 0));

it("Save profile with no network says it could not, and leaves no unhandled rejection", async () => {
  const rejections = unhandledRejections();
  const net = offlineFetch();
  const { user } = show();
  await user.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(getState().toast).toBe("Could not save the profile"));
  await tick();
  expect(net.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /api/profile"]);
  expect(rejections).toEqual([]);
  expect(localStorage.getItem("hq.name")).toBeNull(); // nothing kept as if it were saved
});

it("Create a sign-in link with no network says it could not, and leaves no unhandled rejection", async () => {
  const rejections = unhandledRejections();
  offlineFetch();
  const { user } = show();
  await user.click(screen.getByRole("button", { name: "Create a sign-in link" }));
  await waitFor(() => expect(getState().toast).toBe("Could not create a link."));
  await tick();
  expect(rejections).toEqual([]);
  screen.getByRole("button", { name: "Create a sign-in link" }); // still offered, to try again
});

it("Save profile sends the name typed and the look, and keeps the name once the server took it", async () => {
  let sent: StubRequest | undefined;
  stubFetch({ "PUT /api/profile": (req) => { sent = req; return { status: 200 }; } });
  const { user } = show();
  const name = screen.getByRole("textbox", { name: "Your name" });
  await user.clear(name);
  await user.type(name, "  Ada  ");
  await user.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(getState().toast).toBe("Profile updated"));
  expect(sent?.body).toEqual({ name: "Ada", avatar: getState().myAvatar });
  expect(localStorage.getItem("hq.name")).toBe("Ada");
});

it("a sign-in link the server made is shown whole, with this page's origin", async () => {
  stubFetch({ "POST /api/account-link": { json: { url: "/link/abc" } } });
  const { user } = show();
  await user.click(screen.getByRole("button", { name: "Create a sign-in link" }));
  const field = await screen.findByRole<HTMLInputElement>("textbox", { name: "Use this account on another machine" });
  expect(field.value).toBe(location.origin + "/link/abc");
});

it("a look chosen in the appearance dialog is saved with the profile when the dialog's Save is pressed, and not before", async () => {
  const net = stubFetch({ "PUT /api/profile": { status: 200 } });
  const { user } = show();
  await user.click(screen.getByRole("button", { name: "Change appearance" }));
  const dialog = screen.getByRole("dialog", { name: "Appearance" });
  await user.click(within(within(dialog).getByRole("radiogroup", { name: "Hair" })).getByRole("radio", { name: "Afro" }));
  expect(net.requests).toEqual([]); // a draft until Save
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(getState().toast).toBe("Profile updated"));
  expect(net.requests.map((r) => r.body)).toEqual([{ name: "Me", avatar: { ...getState().myAvatar, hs: 7 } }]);
  expect(getState().myAvatar.hs).toBe(7);
  expect(screen.queryByRole("dialog", { name: "Appearance" })).toBeNull();
});

// Sign-in (auth.providers set): the browser keeps the sign-in round trip and a successful Sign out, whose reload is what
// takes the person out of the office (e2e/scenarios/auth.ts); what signing out does on the server is
// TestSigningOutOfALinkedAccountEndsTheSession and TestSignOutForgetsThisBrowser (server/internal/httpapi/auth_test.go).
const SIGNS_IN = { auth: { providers: ["fake-oidc"], signup: null, link: null } };

it("without sign-in the cookie is the account: a sign-in link for another machine, and nothing to sign out of", () => {
  show();
  screen.getByRole("button", { name: "Create a sign-in link" });
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
});

it("with sign-in on, the settings offer to sign out and no personal link", () => {
  renderUI(<SettingsDialog onClose={() => {}} />, SIGNS_IN);
  screen.getByRole("button", { name: "Sign out" });
  expect(screen.queryByRole("button", { name: "Create a sign-in link" })).toBeNull();
  expect(screen.queryByText("Use this account on another machine")).toBeNull();
});

it("Sign out asks the server to end the session; when it cannot, it says so and stays", async () => {
  const net = stubFetch({ "POST /api/signout": { status: 500 } });
  const { user } = renderUI(<SettingsDialog onClose={() => {}} />, SIGNS_IN);
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(getState().toast).toBe("Could not sign out. Try again."));
  expect(net.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/signout"]);
  screen.getByRole("button", { name: "Sign out" });
});
