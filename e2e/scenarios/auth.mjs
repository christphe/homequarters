// Sign-in with a provider (HQ_AUTH_PROVIDERS=fake-oidc), through the real screens: the fake provider's
// consent page, the name form, an outsider refused then invited, members from before sign-in linking their
// account, personal links refused once linked, and the admin list showing who has signed in.
// It runs its own server (another port, its own database): first without sign-in to create members the old
// way, then with fake-oidc on the same database, as an office that switches on sign-in would.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { check, summary, resetChecks, launch, waitFor, sleep } from "../lib.mjs";

const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];
const WIN = process.platform === "win32";
const PORT = Number(process.env.HQ_TEST_PORT ?? "18080") + 10;
const BASE = `http://127.0.0.1:${PORT}`;
const portOpen = (p) => new Promise((res) => { const s = net.connect(p, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });

async function audit(page, label) {
  await page.evaluate(AXE);
  const res = await page.evaluate(async (tags) => (await window.axe.run(document, { runOnly: { type: "tag", values: tags } })).violations.map((v) => v.id + " " + v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")), TAGS);
  check("axe: no violations on " + label, res.length === 0, res.join(", "));
}

const click = (page, selector, text) => page.evaluate((selector, text) => {
  const b = [...document.querySelectorAll(selector)].find((x) => x.textContent.trim() === text);
  b?.click();
  return !!b;
}, selector, text);
const text = (page) => page.evaluate(() => document.body.innerText);
const inOffice = (page) => page.evaluate(() => window.__hq?.state?.meId > 0 && window.__hq.state.conn === "open");

export async function run(ctx) {
  resetChecks();
  const root = path.resolve(path.dirname(ctx.bin), "..");
  const db = path.join(ctx.dir, "auth.db");
  const env = (extra) => ({ ...process.env, HQ_ENV: "dev", HQ_ADDR: `127.0.0.1:${PORT}`, HQ_DB: db, HQ_STATIC_DIR: path.join(root, "web/dist"),
    HQ_ALLOWED_ORIGINS: `127.0.0.1:${PORT}`, LIVEKIT_URL: process.env.HQ_TEST_LK_URL ?? "ws://127.0.0.1:7880", LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret", HQ_JOIN_RATE: "5000",
    HQ_AUTH_PROVIDERS: "", HQ_AUTH_DOMAINS: "", ...(WIN ? { HQ_STOP_ON_STDIN_CLOSE: "1" } : {}), ...extra });
  let server = null;
  const start = async (extra) => {
    server = spawn(ctx.bin, [], { env: env(extra), stdio: [WIN ? "pipe" : "ignore", fs.openSync(path.join(ctx.dir, "auth-server.log"), "a"), fs.openSync(path.join(ctx.dir, "auth-server.log"), "a")] });
    await waitFor(() => portOpen(PORT), { timeout: 10000, what: "auth server" });
  };
  const stop = async () => {
    if (!server) return;
    const c = server; server = null;
    const done = new Promise((r) => c.once("exit", r));
    if (WIN) c.stdin.end(); else c.kill("SIGTERM");
    const timer = setTimeout(() => c.kill("SIGKILL"), 15000);
    await done;
    clearTimeout(timer);
  };
  const cli = (args) => {
    try { return { ok: true, out: execFileSync(ctx.bin, args, { env: env({ HQ_AUTH_PROVIDERS: "fake-oidc", HQ_AUTH_DOMAINS: "acme.test" }), stdio: ["ignore", "pipe", "pipe"] }).toString().trim() }; }
    catch (e) { return { ok: false, out: String(e.stderr ?? e) }; }
  };
  const browser = await launch([], { waitEmpty: false });
  try {
    // ---- before sign-in: two members join the old way (the session cookie is the account)
    await start({});
    const legacy = {};
    for (const name of ["Olga", "Pat"]) {
      const r = await fetch(BASE + "/api/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      legacy[name] = { cookie: r.headers.get("set-cookie").split(";")[0].split("=")[1], id: (await r.json()).id };
    }
    await stop();

    // ---- the office switches sign-in on
    await start({ HQ_AUTH_PROVIDERS: "fake-oidc", HQ_AUTH_DOMAINS: "acme.test" });
    const r = await fetch(BASE + "/api/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Sneaky" }) });
    check("nobody joins without signing in, even in dev", r.status === 403, String(r.status));

    // A colleague of the domain: button, consent page, name form, office.
    const ana = await (await browser.createBrowserContext()).newPage();
    await ana.setViewport({ width: 1280, height: 720 });
    await ana.goto(BASE, { waitUntil: "domcontentloaded" });
    await ana.waitForSelector(".join-card .signin a");
    check("the join screen offers the provider and no name field", (await ana.$(".join-card input")) === null && (await text(ana)).includes("Continue with fake sign-in (development)"));
    await audit(ana, "the sign-in screen");
    const policy = await (await browser.createBrowserContext()).newPage();
    await policy.goto(BASE, { waitUntil: "domcontentloaded" });
    await policy.waitForSelector('.join-foot a[href="/privacy"]');
    const about = await policy.$eval('.join-foot a[href="/about"]', (a) => ({ target: a.target, text: a.textContent })).catch(() => null);
    check("the sign-in screen links the public page about the office", about?.target === "_blank" && about.text === "About this office", JSON.stringify(about));
    const foot = await policy.$eval('.join-foot a[href="/privacy"]', (a) => {
      const lum = (c) => { const [r, g, b] = c.match(/\d+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const fg = lum(getComputedStyle(a).color), bg = lum(getComputedStyle(a.closest(".join-card")).backgroundColor);
      return { href: a.getAttribute("href"), target: a.target, text: a.textContent, ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) };
    });
    check("the sign-in screen links the privacy policy in a new tab, readable", foot.href === "/privacy" && foot.target === "_blank" && foot.ratio >= 4.5, JSON.stringify(foot));
    await policy.goto(BASE + "/privacy", { waitUntil: "domcontentloaded" });
    check("the policy describes the sign-in account and leads back", (await text(policy)).includes("Your sign-in account") && (await policy.$('a[href="/"]')) !== null);
    await audit(policy, "the privacy policy");
    await policy.goto(BASE + "/about", { waitUntil: "domcontentloaded" });
    const aboutText = await text(policy);
    check("the page about the office says what it is, without signing in", aboutText.includes("virtual office") && aboutText.includes("Walk up to colleagues") && (await policy.$('a[href="/privacy"]')) !== null && (await policy.$('a[href="/"]')) !== null);
    await audit(policy, "the page about the office");
    await Promise.all([ana.waitForNavigation(), click(ana, ".signin a", "Continue with fake sign-in (development)")]);
    check("the button leads to the provider's consent page", ana.url().includes("/auth/fake-oidc/authorize") && (await text(ana)).includes("Authorize"), ana.url());
    const anaEmail = await ana.$eval("#fake-email", (e) => e.textContent);
    await Promise.all([ana.waitForNavigation(), click(ana, "button", "Authorize")]);
    await ana.waitForSelector(".join-card input");
    check("back from the provider, the new member picks a name", (await text(ana)).includes("Signed in as " + anaEmail), anaEmail);
    await ana.type(".join-card input", "Ana");
    await click(ana, "button.primary", "Enter");
    await waitFor(() => inOffice(ana), { timeout: 30000, what: "Ana in the office" });
    const anaName = await ana.evaluate(() => window.__hq.state.roster.get(window.__hq.state.meId)?.n);
    check("Ana is in the office under the name she chose", anaName === "Ana", anaName);
    await ana.reload({ waitUntil: "domcontentloaded" });
    await waitFor(() => inOffice(ana), { timeout: 30000, what: "Ana after reload" });
    check("a reload keeps her in", true);
    await ana.evaluate(() => document.querySelector('button[title="Settings"]').click());
    await waitFor(() => ana.$(".modal"), { what: "settings" });
    check("settings offer no personal link while sign-in is on", !(await text(ana)).includes("Use this account on another machine"));

    // Sign out from the settings: the session ends (a copy of the cookie stops working), the sign-in screen
    // comes back, and signing in again with the same account lands in the same member.
    const anaId = await ana.evaluate(() => window.__hq.state.meId);
    const anaCookie = (await ana.browserContext().cookies()).find((c) => c.name === "hq_session").value;
    check("with sign-in on, the settings offer to sign out", await ana.evaluate(() => [...document.querySelectorAll(".modal button")].some((b) => b.textContent.trim() === "Sign out")));
    await Promise.all([ana.waitForNavigation(), click(ana, ".modal button", "Sign out")]);
    await ana.waitForSelector(".signin a");
    check("signing out leads to the sign-in screen", (await text(ana)).includes("Sign in to enter the office"));
    const copy = await (await fetch(BASE + "/api/me", { headers: { Cookie: "hq_session=" + anaCookie } })).json();
    check("the old session no longer opens the office, even from a copy of its cookie", copy.authenticated === false && !copy.link, JSON.stringify(copy));
    await Promise.all([ana.waitForNavigation(), click(ana, ".signin a", "Continue with fake sign-in (development)")]);
    await Promise.all([ana.waitForNavigation(), click(ana, "button", "Authorize")]);
    await waitFor(() => inOffice(ana), { timeout: 30000, what: "Ana back after signing in again" });
    const back = await ana.evaluate(() => ({ id: window.__hq.state.meId, name: window.__hq.state.roster.get(window.__hq.state.meId)?.n }));
    check("signing in again lands in the same member, without the name form", back.id === anaId && back.name === "Ana", JSON.stringify(back));

    // An outsider without invite is refused, with a message.
    const bob = await (await browser.createBrowserContext()).newPage();
    await bob.goto(BASE + "/?login_hint=bob@gmail.com", { waitUntil: "domcontentloaded" });
    await bob.waitForSelector(".signin a");
    await Promise.all([bob.waitForNavigation(), click(bob, ".signin a", "Continue with fake sign-in (development)")]);
    await Promise.all([bob.waitForNavigation(), click(bob, "button", "Authorize")]);
    await bob.waitForSelector(".join-card [role=alert]");
    check("an outsider without invite is told why", (await text(bob)).includes("cannot enter this office"));

    // Olga, admin from before sign-in, links an account and keeps hers.
    const olgaCtx = await browser.createBrowserContext();
    await olgaCtx.setCookie({ name: "hq_session", value: legacy.Olga.cookie, url: BASE, httpOnly: true, sameSite: "Lax" });
    const olga = await olgaCtx.newPage();
    await olga.setViewport({ width: 1280, height: 720 });
    await olga.goto(BASE, { waitUntil: "domcontentloaded" });
    await olga.waitForSelector(".signin a");
    check("a member from before sign-in is asked to link, by name", (await text(olga)).includes("Welcome back, Olga"));
    await audit(olga, "the link screen");
    const blocked = await olga.evaluate(async () => (await fetch("/api/admin/members")).status);
    check("until linked, the old session reaches no office API", blocked === 401, String(blocked));
    await Promise.all([olga.waitForNavigation(), click(olga, ".signin a", "Continue with fake sign-in (development)")]);
    await Promise.all([olga.waitForNavigation(), click(olga, "button", "Authorize")]);
    await waitFor(() => inOffice(olga), { timeout: 30000, what: "Olga in the office" });
    check("after linking, Olga is back in her own account", (await olga.evaluate(() => window.__hq.state.meId)) === legacy.Olga.id);
    check("linking ends on a confirmation and a clean address", (await text(olga)).includes("Your account is connected") && !olga.url().includes("auth="), olga.url());

    // Olga invites Bob; Bob signs in with the invite through the real screen.
    const inv = await olga.evaluate(async () => (await (await fetch("/api/invites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "member", maxUses: 1, hours: 1 }) })).json()).token);
    await bob.goto(BASE + "/?invite=" + inv + "&login_hint=bob@gmail.com", { waitUntil: "domcontentloaded" });
    await bob.waitForSelector(".signin a");
    check("the invite is announced on the sign-in screen", (await text(bob)).includes("You have an invite"));
    // he cancels at the provider first: the invite must survive the round trip
    await Promise.all([bob.waitForNavigation(), click(bob, ".signin a", "Continue with fake sign-in (development)")]);
    await Promise.all([bob.waitForNavigation(), click(bob, "button", "Cancel")]);
    await bob.waitForSelector(".join-card [role=alert]");
    const kept = await bob.$eval(".signin a", (a) => a.getAttribute("href"));
    check("after a cancelled sign-in the invite is still there", (await text(bob)).includes("You have an invite") && kept.includes("invite=" + inv), kept);
    await Promise.all([bob.waitForNavigation(), click(bob, ".signin a", "Continue with fake sign-in (development)")]);
    await Promise.all([bob.waitForNavigation(), click(bob, "button", "Authorize")]);
    await bob.waitForSelector(".join-card input");
    // a sign-in that expired before the name was sent goes back to the buttons, saying why
    await bob.deleteCookie({ name: "hq_signup", url: BASE });
    await bob.type(".join-card input", "Bob");
    await click(bob, "button.primary", "Enter");
    await bob.waitForSelector(".signin a");
    check("an expired sign-in returns to the sign-in screen with a reason", (await text(bob)).includes("Your sign-in has expired"));
    // he signs in again: the invite was not spent by the failed attempt
    await bob.goto(BASE + "/?invite=" + inv + "&login_hint=bob@gmail.com", { waitUntil: "domcontentloaded" });
    await bob.waitForSelector(".signin a");
    await Promise.all([bob.waitForNavigation(), click(bob, ".signin a", "Continue with fake sign-in (development)")]);
    await Promise.all([bob.waitForNavigation(), click(bob, "button", "Authorize")]);
    await bob.waitForSelector(".join-card input");
    await bob.type(".join-card input", "Bob");
    await click(bob, "button.primary", "Enter");
    await waitFor(() => inOffice(bob), { timeout: 30000, what: "Bob in the office" });
    check("an invited outsider gets in", true);

    // The admin list shows who signs in and who has not yet.
    await waitFor(() => click(olga, ".topbar button", "Admin"), { what: "Admin button" });
    await waitFor(async () => (await text(olga)).includes("Has not signed in yet"), { what: "members list" });
    const adminText = await text(olga);
    const listed = adminText.includes("Signs in as bob@gmail.com") && adminText.includes("Has not signed in yet");
    check("admins see who has linked an account", listed, listed ? "" : adminText.slice(0, 400));

    // Personal links: still a way back for Pat (unlinked), refused for Olga (linked).
    const patLink = cli(["-account-link", "Pat"]);
    check("the personal link of an unlinked member can still be made", patLink.ok && patLink.out.startsWith("/link/"), patLink.out);
    const pat = await (await browser.createBrowserContext()).newPage();
    await pat.goto(BASE + patLink.out, { waitUntil: "domcontentloaded" });
    await pat.waitForSelector(".signin a");
    check("it leads to linking, not into the office", (await text(pat)).includes("Welcome back, Pat"));
    await audit(pat, "the link screen with its way out");
    const olgaLink = cli(["-account-link", "Olga"]);
    check("no personal link for a member who signs in", !olgaLink.ok && olgaLink.out.includes("signs in with a provider"), olgaLink.out);
    // the same identity cannot be linked to a second member
    await pat.goto(BASE + "/?login_hint=bob@gmail.com", { waitUntil: "domcontentloaded" });
    await pat.waitForSelector(".signin a");
    await Promise.all([pat.waitForNavigation(), click(pat, ".signin a", "Continue with fake sign-in (development)")]);
    await Promise.all([pat.waitForNavigation(), click(pat, "button", "Authorize")]);
    await pat.waitForSelector(".join-card [role=alert]");
    check("an account already used by another member is refused for linking", (await text(pat)).includes("already used by another member"));
    // somebody else on Pat's browser: "Not Pat?" forgets the session instead of linking their account to Pat
    await click(pat, ".join-card button", "Not Pat? Use this browser as someone else");
    await waitFor(async () => !(await text(pat)).includes("Welcome back"), { what: "signed out" });
    const after = await pat.evaluate(async () => (await (await fetch("/api/me")).json()));
    check("'Not Pat?' signs the browser out without linking", !after.link && !after.authenticated && (await text(pat)).includes("Sign in to enter the office"), JSON.stringify(after));
    const fresh = await pat.evaluate(() => ({ error: !!document.querySelector(".join-card .error"), href: document.querySelector(".signin a").getAttribute("href") }));
    check("a fresh start shows no earlier error and no earlier account hint", !fresh.error && !fresh.href.includes("login_hint"), JSON.stringify(fresh));
    await sleep(100);
  } finally {
    await browser.close();
    await stop();
  }
  return summary();
}
