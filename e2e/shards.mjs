// Splits the browser suite into shards that run in parallel: one CI job per shard, or
// E2E_PARALLELISM=N shards on one machine (see parallel.mjs). Pure: no dependency, no I/O.

// The whole suite, in the order a single run executes it.
export const ALL = ["proximity", "consent", "rooms", "access", "editor", "social", "admin", "plugins", "chess", "cards", "a11y", "security", "resilience", "features", "spotlight", "mute", "movement", "presence", "offices", "idle", "update", "auth", "autooff", "devices", "templates", "depth"];

// Seconds per scenario, measured in CI run 40192645010 (GitHub ubuntu-latest). Refresh them when a
// scenario grows; a scenario missing here counts as UNKNOWN seconds.
export const DURATIONS = {
  proximity: 39, consent: 43, rooms: 110, access: 1, editor: 56, social: 71, admin: 32, plugins: 76, chess: 67, a11y: 72,
  security: 37, resilience: 79, features: 101, spotlight: 58, mute: 56, movement: 80, presence: 80, offices: 187, idle: 41,
  update: 14, auth: 12, autooff: 49, devices: 40, templates: 30,
  cards: 150, // an estimate (about 2.5 min on a Windows desktop) until a CI run measures it
  depth: 60, // an estimate (two layout switches and an editor save) until a CI run measures it
};
export const UNKNOWN = 60;

/**
 * Scenarios of shard i of n (1-based): greedy balancing, longest scenario first into the least loaded
 * shard (lowest index on a tie). Every scenario of `all` lands in exactly one shard, and each shard keeps
 * the order of `all`. The deferred checks a scenario registers run in the shard that runs it.
 */
export function shard(all, i, n) {
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(i) || i < 1 || i > n) throw new Error(`bad shard ${i}/${n}`);
  const load = new Array(n).fill(0);
  const owner = new Map();
  const longestFirst = all.map((name, at) => ({ name, at, s: DURATIONS[name] ?? UNKNOWN })).sort((a, b) => b.s - a.s || a.at - b.at);
  for (const { name, s } of longestFirst) {
    let k = 0;
    for (let j = 1; j < n; j++) if (load[j] < load[k]) k = j;
    load[k] += s;
    owner.set(name, k);
  }
  return all.filter((name) => owner.get(name) === i - 1);
}

/** Parses "i/n" (1-based); throws on anything else. */
export function parseShard(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(spec ?? "");
  if (!m) throw new Error(`--shard wants i/n, got ${spec}`);
  const i = Number(m[1]), n = Number(m[2]);
  if (i < 1 || n < 1 || i > n) throw new Error(`bad shard ${spec}`);
  return { i, n };
}
