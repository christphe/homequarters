// Test plugin (e2e): an app outside the browser, with a member's app token, gives that member a critter
// drawn by this plugin (public/shared/critter.png); the bundled pets plugin makes it follow, wander and
// show its name. The member is never an argument: the pets plugin takes the one this route serves.
export function load(): void {
  hq.route("POST", "/pet", async (req) => {
    const name = String(req.body || "Critter").slice(0, 24);
    const r = await hq.plugins.call("hq-pets", "setPet", { id: "critter", sheet: "shared/critter.png", cell: [24, 24], name });
    return { body: r };
  }, { token: true });
  hq.route("POST", "/unpet", async () => ({ body: await hq.plugins.call("hq-pets", "removePet", { id: "critter" }) }), { token: true });
}
