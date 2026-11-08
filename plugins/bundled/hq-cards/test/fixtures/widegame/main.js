// Test plugin: a deck whose wide names pass in parts is refused at its last part: chosen, it would not fit a message.
const names = (n) => Array.from({ length: n }, () => ({ name: "漢".repeat(24) }));
const reply = (p, t) => (r) => hq.send(p.id, { t, r });
export function onMessage(p, m) {
  if (m.t === "a") hq.plugins.call("hq-cards", "register", { title: "Wide", seats: [2, 4], deck: { sheet: "shared/c.png", cell: [20, 28], back: 0, total: 100, cards: names(40) } }).then(reply(p, "ra"), reply(p, "ra"));
  if (m.t === "b") hq.plugins.call("hq-cards", "registerCards", { from: 40, cards: names(40) }).then(reply(p, "rb"), reply(p, "rb"));
  if (m.t === "c") hq.plugins.call("hq-cards", "registerCards", { from: 80, cards: names(20) }).then(reply(p, "rc"), reply(p, "rc"));
}
