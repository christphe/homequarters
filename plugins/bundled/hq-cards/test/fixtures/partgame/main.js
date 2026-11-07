// Test plugin: registers a two-part game with hq-cards on request, and tells the member the answer.
const def = (title) => ({ title, seats: [2, 4], deck: { sheet: "shared/c.png", cell: [20, 28], back: 4, total: 4, cards: [{ name: "One" }, { name: "Two" }] } });
export function onMessage(p, m) {
  if (m.t === "part1") hq.plugins.call("hq-cards", "register", def(m.title)).then((r) => hq.send(p.id, { t: "r1", r }));
  if (m.t === "part2") hq.plugins.call("hq-cards", "registerCards", { from: 2, cards: [{ name: "Three" }, { name: "Four" }] }).then((r) => hq.send(p.id, { t: "r2", r }));
}
