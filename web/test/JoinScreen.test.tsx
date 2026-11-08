// @vitest-environment jsdom
// Component test of the join screen (web/src/ui/JoinScreen.tsx) and of the app's return from linking an account
// (web/src/ui/App.tsx): what each sign-in state shows (the provider's button, an invite carried through the sign-in, a
// refusal and its reason, a member from before sign-in asked to link, "Not <name>?"), the name form after the
// provider and a sign-in that expired before it was sent, with the server's answers stubbed and the address set per
// test. Axe audits of the sign-in and link screens are here too (contrast stays in the browser: the a11y scenario
// audits the join screen, whose card and footer links these share). The rules are Go tests in
// server/internal/httpapi/auth_test.go (TestSignInIsRequiredToJoin, TestOutsiderNeedsAnInvite, TestJoinRefusalsSayWhy,
// TestExistingMembersLinkTheirAccount, TestAFailedSignInKeepsTheInvite, TestSignOutForgetsThisBrowser...). The browser
// keeps the one sign-in round trip through the real screens and the fake provider: e2e/scenarios/auth.ts.
import { renderUI, resetStore, stubFetch } from "./support"; // first: canvas before PixiJS
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getState } from "../src/store";
import { App } from "../src/ui/App";
import { JoinScreen } from "../src/ui/JoinScreen";
import { expectNoAxeViolations } from "./axe";

vi.mock("../src/session", async () => (await import("./support/session")).sessionModule());

const SIGN_IN = { phase: "join" as const, meId: 0, auth: { providers: ["fake-oidc"], signup: null, link: null } };
const BUTTON = "Continue with fake sign-in (development)";

/** The address the screen reads (an invite, a login hint, a sign-in error), then the screen. */
function at(search: string, patch = {}) {
  history.replaceState(null, "", "/" + search);
  return renderUI(<JoinScreen />, { ...SIGN_IN, ...patch });
}
const provider = () => screen.getByRole<HTMLAnchorElement>("link", { name: BUTTON });

afterEach(() => history.replaceState(null, "", "/"));

it("with sign-in on, the join screen offers the provider and no name field, and links the office's public pages", async () => {
  at("");
  expect(provider().getAttribute("href")).toBe("/auth/fake-oidc/start");
  screen.getByText("Sign in to enter the office.");
  expect(screen.queryByRole("textbox")).toBeNull();
  const about = screen.getByRole<HTMLAnchorElement>("link", { name: "About this office" });
  const privacy = screen.getByRole<HTMLAnchorElement>("link", { name: "Privacy policy" });
  expect([about.getAttribute("href"), about.target, privacy.getAttribute("href"), privacy.target]).toEqual(["/about", "_blank", "/privacy", "_blank"]);
  await expectNoAxeViolations();
});

it("an invite is announced, and travels through the sign-in with the account hint", () => {
  at("?invite=abc&login_hint=bob@gmail.com");
  screen.getByText("You have an invite: sign in with any account to use it.");
  expect(provider().getAttribute("href")).toBe("/auth/fake-oidc/start?invite=abc&login_hint=bob%40gmail.com");
});

it("after a cancelled sign-in the reason shows and the invite is still there", () => {
  at("?invite=abc&auth=cancelled");
  expect(screen.getByRole("alert").textContent).toBe("Sign-in was cancelled.");
  screen.getByText("You have an invite: sign in with any account to use it.");
  expect(provider().getAttribute("href")).toBe("/auth/fake-oidc/start?invite=abc");
});

it.each([
  ["denied", "This account cannot enter this office. Use an account of the organisation, or ask an administrator for an invite."],
  ["taken", "This account is already used by another member. Choose another account."],
  ["invite", "This invite has been used up meanwhile. Ask an administrator for a new one."],
])("a refused sign-in (auth=%s) says why", (code, why) => {
  at("?auth=" + code);
  expect(screen.getByRole("alert").textContent).toBe(why);
  provider(); // and offers to sign in again
});

it("an unknown sign-in error shows nothing made up", () => {
  at("?auth=<script>");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("a member from before sign-in is asked, by name, to link an account, with a way out: no axe violation", async () => {
  at("", { auth: { providers: ["fake-oidc"], signup: null, link: { name: "Olga" } } });
  screen.getByRole("heading", { name: "Welcome back, Olga" });
  screen.getByText(/Connect an account once to keep your name, desk and history/);
  provider();
  screen.getByRole("button", { name: "Not Olga? Use this browser as someone else" });
  await expectNoAxeViolations();
});

it("\"Not Olga?\" signs this browser out without linking, and starts fresh: no earlier error or account hint, the invite kept", async () => {
  const net = stubFetch({
    "POST /api/signout": { status: 200 },
    "GET /api/me": { json: { authenticated: false, auth: ["fake-oidc"] } },
  });
  const { user } = at("?invite=abc&login_hint=bob@gmail.com&auth=taken", { auth: { providers: ["fake-oidc"], signup: null, link: { name: "Olga" } } });
  screen.getByRole("alert");
  await user.click(screen.getByRole("button", { name: "Not Olga? Use this browser as someone else" }));
  await screen.findByRole("heading", { name: "Join Home Quarters" });
  expect(net.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/signout", "GET /api/me"]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(location.search).toBe("?invite=abc");
  expect(provider().getAttribute("href")).toBe("/auth/fake-oidc/start?invite=abc");
});

it("back from the provider, the new member picks a name and enters", async () => {
  const net = stubFetch({ "POST /api/join": { json: { id: 5, role: "member" } } });
  const { user } = at("?invite=abc", { auth: { providers: ["fake-oidc"], signup: { email: "ana@acme.test" }, link: null } });
  screen.getByText("Signed in as ana@acme.test. Choose how you appear in the office.");
  await user.type(screen.getByRole("textbox", { name: "Your name" }), "Ana");
  await user.click(screen.getByRole("button", { name: "Enter" }));
  await waitFor(() => expect(getState().phase).toBe("play"));
  expect(net.requests[0]?.body).toEqual({ name: "Ana", avatar: getState().myAvatar, invite: "abc" });
  expect(location.search).toBe(""); // the invite does not stay in the address bar
  expect(localStorage.getItem("hq.name")).toBe("Ana");
});

it("a sign-in that expired before the name was sent goes back to the sign-in screen, saying why", async () => {
  stubFetch({
    "POST /api/join": { status: 403, json: { code: "expired" } },
    "GET /api/me": { json: { authenticated: false, auth: ["fake-oidc"] } },
  });
  const { user } = at("", { auth: { providers: ["fake-oidc"], signup: { email: "bob@gmail.com" }, link: null } });
  await user.type(screen.getByRole("textbox", { name: "Your name" }), "Bob");
  await user.click(screen.getByRole("button", { name: "Enter" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Your sign-in has expired. Please sign in again.");
  provider();
  expect(getState().phase).toBe("join");
});

it("without sign-in, the name field shows the name this browser saved", () => {
  resetStore({ phase: "join", meId: 0 }); // what renderUI does first, storage emptied: then the saved name
  localStorage.setItem("hq.name", "Legacy");
  render(<JoinScreen />);
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Your name" }).value).toBe("Legacy");
});

it("back from linking an account, the app says so once and cleans the address", async () => {
  stubFetch({ "GET /api/me": { json: { authenticated: false, auth: ["fake-oidc"] } } });
  history.replaceState(null, "", "/?auth=linked");
  renderUI(<App />, { phase: "boot", meId: 0 });
  await waitFor(() => expect(getState().toast).toBe("Your account is connected. Sign in with it from any machine."));
  expect(location.search).toBe("");
  await screen.findByRole("link", { name: BUTTON });
  expect(within(document.body).queryByRole("alert")).toBeNull();
});
