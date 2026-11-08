// Sign-in with a provider (HQ_AUTH_PROVIDERS=fake-oidc) through the real screens: the one round trip of the join
// screen's button, the fake provider's consent page, the name form and the office; and axe on the two pages the server
// renders itself (the privacy policy and the page about the office), whole pages with their real colours. It runs its
// own server with sign-in on (another port, its own database).
// What moved below the browser (decision 0037), and where it lives now:
// - the join screen: the provider's button and no name field, the about and privacy links, an invite announced and
//   carried through the sign-in (kept after a cancelled one), refusals saying why (an outsider, an account already used
//   by another member), a member from before sign-in asked by name to link, "Not Pat?" starting fresh, a sign-in that
//   expired before the name was sent, the confirmation after linking with a clean address, and the axe audits of the
//   sign-in and link screens: web/test/JoinScreen.test.tsx. Their contrast: the a11y scenario's join screen, same card.
// - settings: no personal link while sign-in is on, Sign out offered (and none without sign-in):
//   web/test/SettingsDialog.test.tsx; admins seeing who has linked: web/test/AdminMembers.test.tsx.
// - the server's rules, in server/internal/httpapi/auth_test.go: nobody joins without signing in
//   (TestSignInIsRequiredToJoin), a reload keeps the session and signing in again lands in the same member
//   (TestDomainMemberSignsUpThenComesBack), signing out ends the session even for a copy of its cookie
//   (TestSignOutForgetsThisBrowser, TestSigningOutOfALinkedAccountEndsTheSession), outsiders need an invite and invited
//   ones get in (TestOutsiderNeedsAnInvite, TestJoinRefusalsSayWhy), old members reach no API until linked and link into
//   their own account (TestExistingMembersLinkTheirAccount), an account linked to another member is refused
//   (TestLinkIdentityRules), a failed sign-in keeps the invite (TestAFailedSignInKeepsTheInvite), personal links stop at
//   linked accounts (TestPersonalLinksStopAtLinkedAccounts; the CLI's refusal: TestCLIAccountLinkStopsAtLinkedAccounts
//   in server/cmd/homequarters/cli_test.go); the policy and about pages' text: privacy_test.go.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import type { Page } from "puppeteer-core";
import { check, summary, resetChecks, launch, waitFor, type RunContext } from "../lib.ts";

const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];
const WIN = process.platform === "win32";
const PORT = Number(process.env.HQ_TEST_PORT ?? "18080") + 10;
const BASE = `http://127.0.0.1:${PORT}`;
const portOpen = (p: number) => new Promise<boolean>((res) => { const s = net.connect(p, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });

async function audit(page: Page, label: string) {
  await page.evaluate(AXE);
  const res = await page.evaluate(async (tags: string[]) => (await (window as unknown as { axe: typeof import("axe-core") }).axe.run(document, { runOnly: { type: "tag", values: tags } })).violations.map((v) => v.id + " " + v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")), TAGS);
  check("axe: no violations on " + label, res.length === 0, res.join(", "));
}

const click = (page: Page, selector: string, text: string) => page.evaluate((selector, text) => {
  const b = [...document.querySelectorAll<HTMLElement>(selector)].find((x) => x.textContent.trim() === text);
  b?.click();
  return !!b;
}, selector, text);
const text = (page: Page) => page.evaluate(() => document.body.innerText);
const inOffice = (page: Page) => page.evaluate(() => window.__hq?.state?.meId > 0 && window.__hq.state.conn === "open");

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const root = path.resolve(path.dirname(ctx.bin), "..");
  const db = path.join(ctx.dir, "auth.db");
  const env = (extra: Record<string, string>) => ({ ...process.env, HQ_ENV: "dev", HQ_ADDR: `127.0.0.1:${PORT}`, HQ_DB: db, HQ_STATIC_DIR: path.join(root, "web/dist"),
    HQ_ALLOWED_ORIGINS: `127.0.0.1:${PORT}`, LIVEKIT_URL: process.env.HQ_TEST_LK_URL ?? "ws://127.0.0.1:7880", LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret", HQ_JOIN_RATE: "5000",
    HQ_AUTH_PROVIDERS: "", HQ_AUTH_DOMAINS: "", ...(WIN ? { HQ_STOP_ON_STDIN_CLOSE: "1" } : {}), ...extra });
  let server: ChildProcess | null = null;
  const start = async (extra: Record<string, string>) => {
    server = spawn(ctx.bin, [], { env: env(extra), stdio: [WIN ? "pipe" : "ignore", fs.openSync(path.join(ctx.dir, "auth-server.log"), "a"), fs.openSync(path.join(ctx.dir, "auth-server.log"), "a")] });
    await waitFor(() => portOpen(PORT), { timeout: 10000, what: "auth server" });
  };
  const stop = async () => {
    if (!server) return;
    const c = server; server = null;
    const done = new Promise((r) => c.once("exit", r));
    if (WIN) c.stdin!.end(); else c.kill("SIGTERM");
    const timer = setTimeout(() => c.kill("SIGKILL"), 15000);
    await done;
    clearTimeout(timer);
  };
  const browser = await launch([], { waitEmpty: false });
  try {
    await start({ HQ_AUTH_PROVIDERS: "fake-oidc", HQ_AUTH_DOMAINS: "acme.test" });

    // A colleague of the domain: button, consent page, name form, office.
    const ana = await (await browser.createBrowserContext()).newPage();
    await ana.setViewport({ width: 1280, height: 720 });
    await ana.goto(BASE, { waitUntil: "domcontentloaded" });
    await ana.waitForSelector(".join-card .signin a");
    await Promise.all([ana.waitForNavigation(), click(ana, ".signin a", "Continue with fake sign-in (development)")]);
    check("the join screen's button leads to the provider's consent page", ana.url().includes("/auth/fake-oidc/authorize") && (await text(ana)).includes("Authorize"), ana.url());
    const anaEmail = await ana.$eval("#fake-email", (e) => e.textContent);
    await Promise.all([ana.waitForNavigation(), click(ana, "button", "Authorize")]);
    await ana.waitForSelector(".join-card input");
    const signedInAs = (await text(ana)).includes("Signed in as " + anaEmail);
    await ana.type(".join-card input", "Ana");
    await click(ana, "button.primary", "Enter");
    await waitFor(() => inOffice(ana), { timeout: 30000, what: "Ana in the office" });
    const anaName = await ana.evaluate(() => window.__hq.state.roster.get(window.__hq.state.meId)?.n);
    check("back from the provider, the new member picks a name and is in the office under it", signedInAs && anaName === "Ana", JSON.stringify({ anaEmail, signedInAs, anaName }));

    // The two pages the server renders itself, open without signing in: axe on the whole page, contrast included.
    const page = await (await browser.createBrowserContext()).newPage();
    await page.goto(BASE + "/privacy", { waitUntil: "domcontentloaded" });
    await audit(page, "the privacy policy");
    await page.goto(BASE + "/about", { waitUntil: "domcontentloaded" });
    await audit(page, "the page about the office");
  } finally {
    await browser.close();
    await stop();
  }
  return summary();
}
