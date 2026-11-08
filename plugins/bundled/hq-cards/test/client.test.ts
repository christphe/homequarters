// The Cards plugin's browser code (public/client.ts) against a stand-in of the page's `hq`: the Cards window it draws
// from what the server says, without a browser. What the server says (the games listed as game plugins come and
// go, a table whose game is off) is cards.ispec.ts and hq-card-pouilleux's oldMaid.ispec.ts; the browser scenarios
// (plugins/e2e/hq-card*-e2e) keep the window's real buttons and the table view.
import { expect, test, vi } from "vitest";

type Node = { type: string; [k: string]: unknown };

/** The browser code, loaded by path: type-checked by public/tsconfig.json against the browser SDK, whose global hq
 * this test stands in for. */
const CLIENT: string = "../public/client.ts";

async function load() {
  const sent: unknown[] = [];
  let modal: { title: string; content: Node[] } | null = null;
  let onMessage: (m: unknown) => void = () => {};
  const node = (type: string) => (o: unknown) => ({ type, ...(typeof o === "string" ? { text: o } : (o as object)) });
  vi.stubGlobal("hq", {
    onLoad: () => {}, onUpdate: () => {},
    onMessage: (f: (m: unknown) => void) => { onMessage = f; },
    send: (d: unknown) => sent.push(d),
    ui: {
      text: node("text"), button: node("button"), view: node("view"), row: (children: Node[]) => ({ type: "row", children }),
      modal: (o: { title: string }, content: Node[]) => { modal = { title: o.title, content }; },
      post: () => {},
    },
  });
  vi.resetModules();
  await import(CLIENT);
  const flat = (nodes: Node[]): Node[] => nodes.flatMap((n) => (n.type === "row" ? flat(n.children as Node[]) : [n]));
  return {
    sent,
    say: (m: Record<string, unknown>) => onMessage({ x: 13, y: 22, ...m }),
    buttons: () => flat((modal as { content: Node[] } | null)?.content ?? []).filter((n) => n.type === "button").map((n) => n.label as string),
    texts: () => flat((modal as { content: Node[] } | null)?.content ?? []).filter((n) => n.type === "text").map((n) => n.text as string),
  };
}

const tableState = (o: { game: string | null; unavailable?: boolean }) => ({ t: { game: o.game }, here: [], looking: [], unavailable: o.unavailable ?? false });
const FREE = { name: "free", title: "Free table" };
const OLD_MAID = { name: "hq-card-pouilleux", title: "Old Maid" };

test("the window's choice of a game follows the list the server sends: a game turned on is added, turned off taken away", async () => {
  const c = await load();
  c.say({ t: "open", n: 1, s: tableState({ game: null }) });
  c.say({ t: "games", list: [FREE] });
  expect(c.buttons()).toEqual(["Free table"]);
  c.say({ t: "games", list: [FREE, OLD_MAID] });
  expect(c.buttons()).toEqual(["Free table", "Old Maid"]);
  c.say({ t: "games", list: [FREE] });
  expect(c.buttons()).toEqual(["Free table"]);
});

test("a table whose game is turned off offers only Reset, and says why", async () => {
  const c = await load();
  c.say({ t: "open", n: 1, s: tableState({ game: "hq-card-lastcard", unavailable: true }) });
  expect(c.buttons()).toEqual(["Reset"]);
  expect(c.texts().some((t) => t.startsWith("This game is not available"))).toBe(true);
});
