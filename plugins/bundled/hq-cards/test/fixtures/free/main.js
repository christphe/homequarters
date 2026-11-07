// Test plugin named "free": it cannot register as a game, and calling a game's count hook is refused without throwing.
export function onMessage(p, m) {
  if (m.t === "a") hq.plugins.call("hq-cards", "register", { title: "Free table", seats: [2, 8], deck: { standard: ["AS", "KS"] } }).then((r) => hq.send(p.id, { t: "ra", r }), (e) => hq.send(p.id, { t: "ra", r: { err: String(e) } }));
  if (m.t === "b") {
    // it answers once both calls are settled, so a test needs no sleep
    const call = (g) => hq.plugins.call(g, "count", { seats: [], hands: [], piles: [], loose: [] }).then(() => {}, () => {});
    Promise.all(["hq-card-pouilleux", "hq-card-lastcard"].map(call)).then(() => hq.send(p.id, { t: "rb" }));
  }
}
