// @vitest-environment jsdom
// Component test of SettingsDialog (web/src/ui/SettingsDialog.tsx): its profile and sign-in link requests, answered
// or failing on the network, with the session and the media managers faked. The toast itself is drawn by
// OfficeScreen; here it is the store's `toast`. The browser suite keeps one real round trip of each: the profile
// save (e2e/scenarios/social.ts) and the failures through the real page (e2e/scenarios/offline.ts).
import { offlineFetch, renderUI, stubFetch, unhandledRejections, type StubRequest } from "./support"; // first: canvas before PixiJS
import { screen, waitFor } from "@testing-library/react";
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
