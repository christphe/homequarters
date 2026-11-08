// The pets plugin's browser code (public/client.ts) against a stand-in of the page's `hq`: what it asks the page to
// draw, the modal it builds and the wander goals it sends, without a browser. The page's side (following a trail,
// pottering at the feet, walking to a goal) is web/test/petFollow.test.ts and tilePath.test.ts; the browser suite
// keeps the pets drawn and walking on real pages (e2e/scenarios/plugins.ts).
import { beforeEach, expect, test, vi } from "vitest";
import type { Goals, MemberPets, PetsMessage, YouMessage } from "../public/messages.ts";

type Node = { type: string; [k: string]: unknown };

/** The browser code, loaded by path: type-checked by public/tsconfig.json against the browser SDK, whose global hq
 * this test (checked with the server SDK's, tsconfig.test.json) stands in for. */
const CLIENT: string = "../public/client.ts";
type Call = [string, ...unknown[]];

/** A fresh stand-in of the page's hq, and the client loaded against it. */
async function load() {
  const calls: Call[] = [];
  const sent: unknown[] = [];
  const on: { load?: () => void; message?: (m: unknown) => void; update?: (dt: number, w: unknown) => void } = {};
  const slots = new Map<string, { onClick?: () => void; label?: string }>();
  let modal: { title: string; content: Node[] } | null = null;
  const rec = (name: string) => (...a: unknown[]) => { calls.push([name, ...a]); };
  const node = (type: string) => (o: unknown) => ({ type, ...(typeof o === "string" ? { text: o } : (o as object)) });
  const hq = {
    onLoad: (f: () => void) => { on.load = f; },
    onMessage: (f: (m: unknown) => void) => { on.message = f; },
    onUpdate: (f: (dt: number, w: unknown) => void) => { on.update = f; },
    send: (d: unknown) => sent.push(d),
    loadSprite: rec("loadSprite"), spawn: rec("spawn"), remove: rec("remove"), setTint: rec("setTint"), follow: rec("follow"),
    stop: rec("stop"), setLabel: rec("setLabel"), walkTo: rec("walkTo"), moveTo: rec("moveTo"),
    ui: {
      text: node("text"), button: node("button"), sprite: node("sprite"), field: node("field"), color: node("color"), number: node("number"),
      row: (children: Node[]) => ({ type: "row", children }),
      slot: (id: string, _anchor: string, o: { onClick?: () => void; label?: string }) => slots.set(id, o),
      unslot: (id: string) => slots.delete(id),
      modal: (o: { title: string }, content: Node[]) => { modal = { title: o.title, content }; },
    },
  };
  vi.stubGlobal("hq", hq);
  vi.resetModules();
  await import(CLIENT);
  const world = (me: number, avatars: { id: number; x: number; y: number }[] = []) => ({ me, avatars });
  return {
    calls, sent, slots, on,
    get modal() { return modal; },
    world,
    you: (limit: number) => on.message!({ t: "you", limit } satisfies YouMessage),
    pets: (set: MemberPets[], extra: Partial<PetsMessage> = {}) => on.message!({ t: "pets", set, del: [], go: [], ...extra } satisfies PetsMessage),
  };
}

/** Every node of a modal's tree, rows opened. */
const flat = (nodes: Node[]): Node[] => nodes.flatMap((n) => (n.type === "row" ? flat(n.children as Node[]) : [n]));

beforeEach(() => {
  vi.unstubAllGlobals();
});

test("walking, the first pet keeps 20 px behind its owner and the next one 36 px; at rest they potter 8 to 14 px plus 14 at the feet", async () => {
  const c = await load();
  c.on.update!(0.1, c.world(7));
  c.pets([{ id: 7, pets: [[0, "", "a", ""], [8, "", "b", ""]], guests: [], mode: "follow" }]);
  const follows = c.calls.filter((x) => x[0] === "follow");
  expect(follows).toEqual([
    ["follow", "7:a", 7, { gap: 20, beside: 10, roam: 14 }],
    ["follow", "7:b", 7, { gap: 36, beside: 8, roam: 14 }],
  ]);
  // a removed first pet moves the next one up the line, the same sprite
  c.calls.length = 0;
  c.pets([{ id: 7, pets: [[8, "", "b", ""]], guests: [], mode: "follow" }]);
  expect(c.calls).toContainEqual(["remove", "7:a"]);
  expect(c.calls).toContainEqual(["follow", "7:b", 7, { gap: 20, beside: 10, roam: 14 }]);
  expect(c.calls.some((x) => x[0] === "spawn" && x[1] === "7:b")).toBe(false);
});

test("the Pets modal has no office setting (it is in the administration)", async () => {
  const c = await load();
  c.on.update!(0.1, c.world(7));
  c.you(3);
  c.pets([{ id: 7, pets: [[0, "", "a", "Biscuit"]], guests: [], mode: "follow" }]);
  c.slots.get("config")!.onClick!();
  expect(c.modal!.title).toBe("Pets");
  const nodes = flat(c.modal!.content);
  expect(nodes.some((n) => n.type === "number")).toBe(false);
  expect(nodes.some((n) => n.type === "field" && n.label === "Name of Cat 1")).toBe(true); // the modal is the one with the pets
});

test("another plugin's pet is drawn with its member, but it is not in the Pets modal and does not count in the limit", async () => {
  const c = await load();
  c.on.update!(0.1, c.world(7));
  c.you(3);
  c.pets([{ id: 7, pets: [[0, "", "a", "Biscuit"]], guests: [{ from: "critters", id: "c1", sheet: "shared/critter.png", cell: [24, 24], name: "Bramble" }], mode: "follow" }]);
  expect(c.calls).toContainEqual(["follow", "7:x:critters:c1", 7, { gap: 36, beside: 8, roam: 14 }]);
  c.slots.get("config")!.onClick!();
  const nodes = flat(c.modal!.content);
  expect(nodes.some((n) => JSON.stringify(n).includes("Bramble"))).toBe(false);
  expect(nodes.some((n) => n.type === "text" && n.text === "Add a pet (1 of 3)")).toBe(true);
});

test("let wander, the owner's page sends a goal for each pet within 2 s, all within the moods' reach, and never makes them follow", async () => {
  const c = await load();
  const me = 7, home = { x: 400, y: 300 };
  c.on.update!(0.1, c.world(me, [{ id: me, ...home }]));
  c.pets([{ id: me, pets: [[0, "", "a", ""], [1, "", "b", ""]], guests: [], mode: "follow" }]);
  c.pets([{ id: me, pets: [[0, "", "a", ""], [1, "", "b", ""]], guests: [], mode: "wander" }]);
  expect(c.calls.filter((x) => x[0] === "stop").map((x) => x[1])).toEqual(["7:a", "7:b"]); // it stays where it is
  c.calls.length = 0;
  const firstGoal: (number | null)[] = [null, null];
  // half an hour of updates (the moods change about every 5 minutes), the owner standing still
  for (let i = 1; i <= 18_000; i++) {
    const before = c.sent.length;
    c.on.update!(0.1, c.world(me, [{ id: me, ...home }]));
    for (const m of c.sent.slice(before) as { t: string; g: Goals }[]) {
      expect(m.t).toBe("wander");
      m.g.forEach((g, k) => {
        if (g === null) return;
        firstGoal[k] ??= i * 0.1;
        // a socializing pet goes along with another wandering pet: here its sibling, never itself
        if (typeof g === "string") return expect(g).toBe(["7:b", "7:a"][k]);
        const [x, y, speed] = g;
        expect(Math.hypot(x - home.x, y - home.y)).toBeLessThanOrEqual(241);
        expect(speed).toBeGreaterThanOrEqual(28);
        expect(speed).toBeLessThanOrEqual(40);
      });
      // the server relays the goals to every page, this one included, with the member's entry now and then
      const walks = c.calls.length;
      const set = i % 50 === 0 ? [{ id: me, pets: [[0, "", "a", ""], [1, "", "b", ""]], guests: [], mode: "wander" } as MemberPets] : [];
      c.pets(set, { go: [{ id: me, g: m.g }] });
      m.g.forEach((g, k) => {
        if (Array.isArray(g)) expect(c.calls.slice(walks)).toContainEqual(["walkTo", ["7:a", "7:b"][k], g[0], g[1], { speed: g[2] }]);
      });
    }
  }
  expect(firstGoal.every((t) => t !== null && t <= 2.1)).toBe(true);
  expect(c.calls.filter((x) => x[0] === "follow" && typeof x[2] === "number")).toEqual([]); // never back behind the owner
});
