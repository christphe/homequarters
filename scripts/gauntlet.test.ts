// The gauntlet on fdash: its gates in fdash.json, the tree fingerprint, the record. Run: node --test scripts/gauntlet.test.ts  (part of the web-unit gate)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expand, loadConfig, type Command } from "../tools/fdash/config.ts";
import { fingerprint } from "./gauntlet-fingerprint.ts";
import { closing, header, recordLines } from "./gauntlet.ts";
// a plain .mjs without types: imported through a variable so the type-checker does not look for them
const shards = "../e2e/shards.mjs";
const { ALL } = (await import(shards)) as { ALL: string[] };

const root = path.resolve(import.meta.dirname, "..");

test("fdash.json holds the gates of gauntlet.sh, in its order, with its commands", () => {
  const config = loadConfig(root);
  const gates = expand(config, ["default"], []);
  const row = (c: Command) => [c.name, c.cwd, c.run.map((s) => s.join(" ")).join(" && "), c.failOnOutput, c.args, JSON.stringify(c.env)];
  assert.deepEqual(gates.map(row), [
    ["gofmt", "server", "gofmt -l .", true, false, "{}"],
    ["go-vet", "server", "go vet ./...", false, false, "{}"],
    ["staticcheck", "server", "go tool staticcheck ./...", false, false, "{}"],
    ["go-test-race", "server", "go test -race -count=1 ./...", false, false, "{}"],
    ["tsc", "web", "pnpm exec tsc --noEmit", false, false, "{}"],
    ["tsc-tests", "web", "pnpm exec tsc -p tsconfig.test.json --noEmit", false, false, "{}"],
    ["vite-build", "web", "pnpm exec vite build", false, false, "{}"],
    ["protocol-docs", ".", "node scripts/check-protocol-docs.mjs", false, false, "{}"],
    ["oxlint", ".", "node scripts/oxlint.mjs", false, false, "{}"],
    ["plugin-types", ".", "node scripts/check-plugin-types.mjs", false, false, "{}"],
    ["web-unit", ".", "node --test web/test/*.test.ts tools/fdash/test/*.test.ts e2e/shards.test.mjs e2e/slots.test.mjs scripts/oxlint-hq.test.mjs scripts/check-protocol-docs.test.mjs scripts/gauntlet.test.ts", false, false, "{}"],
    ["site-build", "site", "node build.mjs && node check.mjs", false, false, "{}"],
    ["e2e", "e2e", "node run.mjs", false, true, '{"E2E_VIEWPORT":"small"}'],
  ]);
  assert.deepEqual(config.get("default"), { kind: "group", name: "default", tasks: ["static", "e2e"], jobs: 1 });
  assert.equal((config.get("static") as { jobs?: number }).jobs, undefined);
});

test("every gate is cached, and every scenario of the suite is an item with its own file", () => {
  const gates = expand(loadConfig(root), ["default"], []);
  for (const g of gates) assert.ok(g.inputs && g.inputs.length > 0, `${g.name} declares inputs`);
  const e2e = gates.find((g) => g.name === "e2e")!;
  assert.deepEqual([...e2e.items!.keys()], ALL);
  for (const [s, item] of e2e.items!) assert.ok(item.inputs.includes(`e2e/scenarios/${s}.mjs`), s);
  // scenarios that turn a bundled plugin on, or list the plugins' catalog, follow that plugin's code
  const follows = (s: string, p: string) => e2e.items!.get(s)!.inputs.some((i) => typeof i === "string" && path.posix.matchesGlob(`plugins/bundled/${p}/main.ts`, i));
  for (const s of ALL) {
    const text = fs.readFileSync(path.join(root, "e2e/scenarios", s + ".mjs"), "utf8");
    for (const p of fs.readdirSync(path.join(root, "plugins/bundled"))) if (text.includes(p)) assert.ok(follows(s, p), `${s} names ${p}: its folder is an input`);
    if (/\[role=tab\]", "Plugins"|Plugins tab|plugins tab/.test(text)) assert.ok(follows(s, "hq-"), `${s} lists the plugins: every plugin is an input`);
  }
});

function repo(): { dir: string; git: (...a: string[]) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-fingerprint-"));
  const git = (...a: string[]) => { execFileSync("git", a, { cwd: dir, stdio: "ignore" }); };
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  for (const [f, t] of Object.entries({ "a.txt": "a", "server/CHANGELOG.md": "c", "docs/superpowers/x.md": "x", ".gitignore": "ignored/\n" })) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), t);
  }
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, git };
}

test("the fingerprint follows tracked, staged, modified and untracked files, and leaves out the changelogs and docs/superpowers", () => {
  const { dir, git } = repo();
  const fp = () => fingerprint(dir);
  let last = fp();
  assert.match(last, /^[0-9a-f]{12}$/);
  assert.equal(fp(), last, "stable");
  const changes = (what: string, act: () => void) => { act(); const now = fp(); assert.notEqual(now, last, what); last = now; };
  const same = (what: string, act: () => void) => { act(); assert.equal(fp(), last, what); };
  changes("an edited file", () => fs.writeFileSync(path.join(dir, "a.txt"), "b"));
  changes("the edit staged", () => git("add", "a.txt"));
  changes("a new untracked file with a space and an accent", () => fs.writeFileSync(path.join(dir, "new file é.txt"), "1"));
  changes("that file edited", () => fs.writeFileSync(path.join(dir, "new file é.txt"), "2"));
  same("a changelog", () => fs.writeFileSync(path.join(dir, "server/CHANGELOG.md"), "d"));
  same("a design note", () => fs.writeFileSync(path.join(dir, "docs/superpowers/y.md"), "y"));
  same("an ignored file", () => { fs.mkdirSync(path.join(dir, "ignored")); fs.writeFileSync(path.join(dir, "ignored/z.txt"), "z"); });
});

test("header and record lines", () => {
  assert.equal(header({ commit: "abc1234", tree: "0123456789ab", started: new Date("2026-11-07T10:00:00.123Z"), scenarios: [] }), "gates for: commit abc1234, tree 0123456789ab, started 2026-11-07T10:00:00Z, scenarios: all");
  assert.match(header({ commit: "c", tree: "t", started: new Date(0), scenarios: ["a", "b"] }), /scenarios: a b$/);
  const r = (name: string, ok: boolean, cached = false) => ({ name, ok, cached, log: `/l/${name}.log`, ms: 1 });
  assert.deepEqual(recordLines([r("tsc", true), r("gofmt", false), r("e2e:cards", true, true)], true), ["PASS tsc", "FAIL gofmt (log: /l/gofmt.log)", "CACHED e2e:cards", "SKIPPED e2e"]);
});

test("closing: green, red, skipped, tree changed, interrupted", () => {
  const c = (o: Partial<Parameters<typeof closing>[0]>) => closing({ fails: 0, skipE2e: false, treeBefore: "t", treeAfter: "t", interrupted: false, ...o });
  assert.deepEqual(c({}), { lines: ["GATES GREEN"], fails: 0 });
  assert.deepEqual(c({ fails: 2 }), { lines: ["GATES RED: 2 failed"], fails: 2 });
  assert.deepEqual(c({ skipE2e: true }), { lines: ["STATIC GATES GREEN; browser verification SKIPPED"], fails: 0 });
  assert.deepEqual(c({ treeAfter: "u" }), { lines: ["FAIL working tree changed during gates; rerun on the final tree", "GATES RED: 1 failed"], fails: 1 });
  assert.deepEqual(c({ interrupted: true }), { lines: ["interrupted", "GATES RED: 1 failed"], fails: 1 });
});
