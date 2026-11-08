// Splits the browser suite into shards that run in parallel: one CI job per shard, or
// E2E_PARALLELISM=N shards on one machine (see parallel.ts). Pure: no dependency, no I/O.

// The whole suite of run.ts (the e2e project's items), in the order a single run executes it.
export const ALL = ["proximity", "consent", "rooms", "editor", "social", "admin", "plugins", "a11y", "security", "resilience", "features", "spotlight", "mute", "movement", "presence", "offices", "idle", "update", "auth", "autooff", "devices", "templates", "depth", "offline", "sounds"];

// The plugins' e2e projects (plugins/e2e/*, each run by plugin-run.ts against the testbed, without LiveKit).
// CI balances them with the scenarios above (plan): each runs whole in the shard it lands in.
export const PROJECTS = ["hq-chess-e2e", "hq-cards-e2e", "hq-card-pouilleux-e2e", "hq-card-lastcard-e2e"];

// Seconds per scenario, as each CI shard prints them ("# <scenario> took N s"), measured in CI run 42523235972 (GitHub
// ubuntu-latest, 2026-11-08, after wave 1 of the test pyramid moved browser checks down: #69 to #72). Refresh them when a scenario grows or checks
// move out; a scenario missing here counts as UNKNOWN seconds.
export const DURATIONS: Record<string, number> = {
  proximity: 38, consent: 22, rooms: 75, editor: 23, social: 24, admin: 19, plugins: 52, a11y: 36,
  security: 36, resilience: 38, features: 26, spotlight: 49, mute: 55, movement: 24, presence: 38, offices: 42, idle: 41,
  update: 12, auth: 3, autooff: 44, devices: 25, templates: 28, depth: 48, offline: 12, sounds: 17,
  "hq-chess-e2e": 30, // its test:e2e alone on a Windows 11 desktop (2026-11-07, the testbed without LiveKit; 34 s as run.ts's chess), not in CI
  // the three card projects' test:e2e one after the other on the same desktop (2026-11-07, the testbed; 32 s as run.ts's cards), not in CI
  "hq-cards-e2e": 26, "hq-card-pouilleux-e2e": 9, "hq-card-lastcard-e2e": 10,
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
