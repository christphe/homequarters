// Test plugin of the browser suite (e2e/scenarios/plugins.mjs). An app outside the browser posts a
// member's state with their app token; the plugin shows it on that member's page.
// sent the moment a member connects, before their page has started this plugin: it must still arrive
export function onJoin(p: HQ.Player): void {
  hq.send(p.id, { t: "state", body: "welcome " + p.name });
}

export function load(): void {
  hq.route("POST", "/state", (req) => {
    hq.send(req.player.id, { t: "state", body: req.body });
    return { body: { ok: true, id: req.player.id } };
  }, { token: true });
}
