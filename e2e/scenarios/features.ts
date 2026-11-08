// Real UI and authoritative world between two pages, through real controls: a reaction key, an interactive note,
// the people panel's "More actions" menu with a request to lead, and the shared whiteboard.
//
// Browser checks kept, one or more per feature:
// - reactions: a number key sends an emote that the other page renders
// - interactive objects: X next to the welcome note opens it in a dialog
// - people panel menu, lead requests: More actions > Request to lead reaches the other page, which asks first
// - following: More actions > Follow, the server steers my page until Stop following
// - whiteboard: text and a pen stroke drawn on one page appear on the other's canvas
// - no browser runtime errors
//
// Moved down (decision 0037), where each former check lives now:
// - a person's row has four buttons; Escape closes the More actions menu; choosing an action closes it:
//   web/test/SidePanel.test.tsx
// - request to lead asks before moving anybody, Not now and Follow them: web/test/SocialControls.movement.test.tsx,
//   world TestRequestToLeadReachesTheOtherPlayerWithACooldown
// - Follow walks to the leader at server speed around objects: world TestFollowWalksAroundWallsAndStopsOnInput (the
//   browser keeps the Follow / Stop following wiring above)
// - a follower runs with a leader who runs and keeps close: world TestFollowerKeepsTheLeadersPace (gap, run bit, the
//   follower's own "r"), web/test/localPlayer.test.ts (its own page predicts the run), web/test/remoteMotion.test.ts
//   (others see the run bit)
// - a portal teleports once and stops movement: world TestPortalsTeleportOncePerArrivalAndNotIntoLockedRooms,
//   web/test/localPlayer.test.ts (a teleport stops me). No browser check is left for portals: walking onto one has no
//   control of its own, and what it draws is an ordinary move
// - a locked door blocks, Let in admits only the visitor: world TestLockingKnockingAndAnswering; the person who locked
//   a room steps out with no Knock or Enter anyway and walks back in: world TestWhoeverLockedARoomStepsOutAndWalksBackIn,
//   web/test/doors.test.ts. Knock and Let in through the real buttons stay in e2e/scenarios/offices.ts
// - the editor restores a note's hidden content, and the saved edit is delivered: web/test/MapEditorContent.test.tsx,
//   httpapi TestBoardStrokesAndNoteEditsSurviveAGracefulRestart, world
//   TestObjectContentIsHiddenFromTheMapAndServedOnlyNextToTheObject
// - an administrator's clear reaches both, members get no Clear board, Escape closes the board:
//   world TestWhiteboardAuthorityFanoutUndoAndClear, web/test/WhiteboardDialog.test.tsx
import { check, resetChecks, summary, launch, joinAs, waitFor, walkTo, pos, sleep, type User, type RunContext } from "../lib.ts";
import type { EvaluateFunc } from "puppeteer-core";
import os from "node:os";
import path from "node:path";

const click = (u: User, text: string, selector = "button") => u.page.evaluate((text, selector) => {
  const b = [...document.querySelectorAll<HTMLElement>(selector)].find((x) => x.textContent.trim() === text || x.getAttribute("aria-label") === text);
  b?.click(); return !!b;
}, text, selector);
const read = <Params extends unknown[], Func extends EvaluateFunc<Params>>(u: User, fn: Func, ...args: Params) => u.page.evaluate(fn, ...args);
const close = (u: User) => u.page.keyboard.press("Escape");

/** Setup: the server runs me to a tile (a walk-to, twice walking speed) and I arrive. */
async function runTo(u: User, tx: number, ty: number) {
  await read(u, (tx, ty) => window.__hq.view.goTo(tx, ty), tx, ty);
  await waitFor(async () => {
    const p = await pos(u);
    return Math.floor(p.x / 16) === tx && Math.floor(p.y / 16) === ty && !(await read(u, () => window.__hq.view.guided));
  }, { timeout: 30000, what: `${u.name} runs to (${tx}, ${ty})` });
}

export async function run(ctx: RunContext): Promise<boolean> {
  resetChecks();
  const browser = await launch();
  try {
    const a = await joinAs(browser, "Admin", { cookie: ctx.adminCookie });
    const b = await joinAs(browser, "Explorer" + Date.now() % 10000);
    await Promise.all([walkTo(a, 4 * 16 + 8, 6 * 16 + 8), walkTo(b, 6 * 16 + 8, 6 * 16 + 8)]); // each page walks its own avatar
    await waitFor(() => read(a, () => window.__hq.state.nearby?.t === "note"), { what: "nearby note hint" });
    await a.page.keyboard.press("1");
    await waitFor(() => read(b, (id) => window.__hq.view.emotes.has(id), a.id), { what: "remote wave bubble" });
    check("number key sends an emote that the other avatar renders", true);
    await waitFor(async () => { await a.page.keyboard.press("x"); return a.page.$(".object-note"); }, { timeout: 20000, every: 700, what: "welcome note opens" });
    check("X opens the nearby note in a dialog", await read(a, () => document.querySelector(".object-note")!.textContent.includes("Welcome to Home Quarters!")));
    await close(a);

    // the people panel's menu, for real, and the request it sends: the other page asks first
    await click(b, "More actions for Admin", ".people button");
    await waitFor(() => b.page.$(".more-menu"), { what: "more actions menu" });
    await click(b, "Request to lead Admin", ".more-menu button");
    await waitFor(() => read(a, () => [...document.querySelectorAll(".modal button")].some((x) => x.textContent === "Not now")), { what: "lead request asked" });
    const asked = await read(a, () => ({ request: window.__hq.state.leadRequest?.name ?? "", following: !!window.__hq.state.following }));
    await click(a, "Not now");
    check("Request to lead from the people panel reaches the other page, which asks before anybody moves", asked.request.startsWith("Explorer") && !asked.following && await read(a, () => !document.querySelector(".modal")), JSON.stringify(asked));
    // Follow through the same menu: the server steers the follower (its page is guided) until Stop following
    await click(b, "More actions for Admin", ".people button");
    await waitFor(() => b.page.$(".more-menu"), { what: "more actions menu" });
    await click(b, "Follow Admin", ".more-menu button");
    await waitFor(() => read(b, () => window.__hq.state.following?.name === "Admin" && window.__hq.view.guided && [...document.querySelectorAll("button")].some((x) => x.textContent === "Stop following")), { what: "following Admin" });
    await click(b, "Stop following");
    await waitFor(() => read(b, () => !window.__hq.state.following && !window.__hq.view.guided), { what: "follow stops" });
    check("Follow from the people panel has the server steer me until Stop following", true);

    await Promise.all([runTo(a, 49, 16), runTo(b, 50, 16)]);
    for (const u of [a, b]) {
      await waitFor(() => read(u, () => window.__hq.state.nearby?.t === "whiteboard"), { what: "nearby whiteboard" });
      await u.page.keyboard.press("x");
      await waitFor(() => u.page.$("canvas.whiteboard"), { what: "whiteboard dialog" });
    }
    await click(a, "Text", ".board-tools button");
    await a.page.type('.modal input[maxlength="80"]', "Shared test text");
    await click(a, "Place text in centre");
    await waitFor(() => b.page.evaluate(() => document.querySelector<HTMLCanvasElement>("canvas.whiteboard")!.getContext("2d")!.getImageData(400, 270, 220, 40).data.some((v) => v < 200)), { what: "text appears on collaborator canvas" });
    check("whiteboard text appears on the other person's canvas", true);
    await a.page.screenshot({ path: path.join(os.tmpdir(), "homequarters-whiteboard-qa.png") });
    await click(a, "Pen", ".board-tools button");
    const rect = await read(a, () => { const r = document.querySelector("canvas.whiteboard")!.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await a.page.mouse.move(rect.x + 50, rect.y + 50); await a.page.mouse.down();
    await a.page.mouse.move(rect.x + 150, rect.y + 80, { steps: 12 }); await a.page.mouse.up();
    await sleep(250);
    check("pen drawing is rendered by the collaborator", await read(b, () => document.querySelector<HTMLCanvasElement>("canvas.whiteboard")!.getContext("2d")!.getImageData(30, 30, 220, 160).data.some((v) => v < 200)));
    // a stroke drawn just before a graceful restart and the note's edit survive it:
    // httpapi TestBoardStrokesAndNoteEditsSurviveAGracefulRestart
    const errors = [...a.logs, ...b.logs];
    check("new flows have no browser runtime errors", errors.length === 0, errors.join(" | "));
    return summary();
  } finally { await browser.close(); }
}
