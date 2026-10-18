export function load(): void {
  hq.route("GET", "/hello", (req) => ({ body: { id: req.player.id, kv: hq.kv.get("k") ?? "" } }));
  hq.route("POST", "/echo", (req) => ({ status: 201, body: req.body }));
  hq.route("GET", "/settings", () => ({ body: hq.settings() }));
  hq.route("POST", "/state", (req) => ({ body: { id: req.player.id, body: req.body } }), { token: true });
}

export function onMessage(p: HQ.Player, m: { v: string }): void {
  hq.kv.set("k", String(m.v));
  hq.send(p.id, { echo: m.v });
}
