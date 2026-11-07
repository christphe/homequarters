// Splits the browser suite into shards that run in parallel: one CI job per shard, or
// E2E_PARALLELISM=N shards on one machine (see parallel.ts). Pure: no dependency, no I/O.

// The whole suite of run.ts (the e2e project's items), in the order a single run executes it.
export const ALL = ["proximity", "consent", "rooms", "access", "editor", "social", "admin", "plugins", "cards", "a11y", "security", "resilience", "features", "spotlight", "mute", "movement", "presence", "offices", "idle", "update", "auth", "autooff", "devices", "templates", "depth", "offline", "sounds"];

// The plugins' e2e projects (plugins/e2e/*, each run by plugin-run.ts against the testbed, without LiveKit).
// CI balances them with the scenarios above (plan): each runs whole in the shard it lands in.
export const PROJECTS = ["hq-chess-e2e"];

// Seconds per scenario (and per e2e project), measured in CI run 40192645010 (GitHub ubuntu-latest). Refresh them when a
// scenario grows; a scenario missing here counts as UNKNOWN seconds.
export const DURATIONS: Record<string, number> = {
  proximity: 39, consent: 43, rooms: 110, access: 1, editor: 56, social: 71, admin: 32, plugins: 76, a11y: 72,
  security: 37, resilience: 79, features: 101, spotlight: 58, mute: 56, movement: 80, presence: 80, offices: 187, idle: 41,
  update: 14, auth: 12, autooff: 49, devices: 40, templates: 30,
  cards: 32, // measured alone on a Windows 11 desktop (2026-10-26, after the rules moved to unit tests; 32 s again on 2026-11-07 after the button rules did), not in CI
  "hq-chess-e2e": 30, // its test:e2e alone on the same desktop (2026-11-07, the testbed without LiveKit; 34 s as run.ts's chess), not in CI
  depth: 60, // an estimate (two layout switches and an editor save) until a CI run measures it
  offline: 50, // an estimate (one page, eight failed requests, each after the previous toast has gone) until a CI run measures it
  sounds: 30, // an estimate (two people, three reloads and three waves) until a CI run measures it
};
export const UNKNOWN = 60;

/**
 * Scenarios of shard i of n (1-based): greedy balancing, longest scenario first into the least loaded
 * shard (lowest index on a tie). Every scenario of `all` lands in exactly one shard, and each shard keeps
 * the order of `all`. The deferred checks a scenario registers run in the shard that runs it.
 */
export function shard(all: readonly string[], i: number, n: number): string[] {
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(i) || i < 1 || i > n) throw new Error(`bad shard ${i}/${n}`);
  // oxlint-disable-next-line unicorn/no-new-array -- n is the length (a positive integer, checked above)
  const load = new Array(n).fill(0);
  const owner = new Map<string, number>();
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
export function parseShard(spec: string | null | undefined) {
  const m = /^(\d+)\/(\d+)$/.exec(spec ?? "");
  if (!m) throw new Error(`--shard wants i/n, got ${spec}`);
  const i = Number(m[1]), n = Number(m[2]);
  if (i < 1 || n < 1 || i > n) throw new Error(`bad shard ${spec}`);
  return { i, n };
}

/** How many shards to run for `count` scenarios when `requested` were asked for: never more than there are
 * scenarios (a shard without one would hold an e2e slot and start a LiveKit for nothing), at least one. */
export function shardsFor(requested: number, count: number) {
  return Math.max(1, Math.min(Number.isInteger(requested) ? requested : 1, count));
}

/** What shard i of n runs on CI: scenarios of run.ts (`test:e2e --pkg e2e -- <scenarios>`) and e2e projects
 * (`test:e2e --pkg <project>`), balanced together by DURATIONS; each list keeps the order of `all` or `projects`. */
export function plan(i: number, n: number, all: readonly string[] = ALL, projects: readonly string[] = PROJECTS): { scenarios: string[]; projects: string[] } {
  const clash = projects.filter((p) => all.includes(p));
  if (clash.length) throw new Error(`a project has a scenario's name: ${clash.join(", ")}`);
  const mine = shard([...all, ...projects], i, n);
  return { scenarios: mine.filter((s) => all.includes(s)), projects: mine.filter((p) => projects.includes(p)) };
}
