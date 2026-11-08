// Test fixture for pets.ispec.ts: a member's message {n, hook, args} makes this plugin call that hook of
// hq-pets and broadcast {n, hook, r: the answer}. Once, as soon as somebody is online, it also calls
// setPet on its own (no member's action behind it) and broadcasts {hook: "alone", r}.
export async function onMessage(_p: HQ.Player, m: { n: number; hook: string; args: unknown }) {
  hq.broadcast({ n: m.n, hook: m.hook, r: await hq.plugins.call("hq-pets", m.hook, m.args) });
}

let alone = false;
export async function update() {
  if (alone || !hq.players().length) return;
  alone = true;
  hq.broadcast({ hook: "alone", r: await hq.plugins.call("hq-pets", "setPet", { id: "a", sheet: "shared/a.png", cell: [24, 24] }) });
}
