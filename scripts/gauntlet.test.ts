// The gauntlet on fdash: its gates in the workspace, the tree fingerprint, the record. Run: pnpm exec vitest run gauntlet.test.ts  (scripts' test:unit)
import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expand, type Command } from "../tools/fdash/config.ts";
import { loadWorkspace } from "../tools/fdash/workspace.ts";
import { fingerprint } from "./gauntlet-fingerprint.ts";
import { BROWSER, closing, header, plan, recordLines } from "./gauntlet.ts";
import { ALL } from "../e2e/shards.ts";

const root = path.resolve(import.meta.dirname, "..");
/** The plugins' e2e projects (plugins/e2e/*), each run by e2e/plugin-run.ts against the testbed, in the workspace's order. */
const PLUGIN_E2E = ["hq-card-lastcard-e2e", "hq-card-pouilleux-e2e", "hq-cards-e2e", "hq-chess-e2e"];
const PLUGIN_SUITES = PLUGIN_E2E.map((p) => `${p}:test:e2e`);
/** The projects with integration tests (*.ispec.ts against the testbed), in the workspace's order. */
const INTEGRATION = ["sdk", "hq-card-lastcard", "hq-card-pouilleux", "hq-cards", "hq-chess", "hq-pets"].map((p) => `${p}:test:integration`);

test("the workspace holds the gauntlet's gates, as the conventional tasks of each project, with their commands", () => {
  const config = loadWorkspace(root);
  const gates = expand(config, ["default"], []);
  const row = (c: Command) => [c.name, c.cwd, c.run.map((s) => s.join(" ")).join(" && "), c.failOnOutput, c.args, JSON.stringify(c.env)];
  const ox = (up: string, folders = ".") => `node ${up}scripts/oxlint.ts ${folders}`;
  const tsc = (p: string) => `pnpm exec tsc -p ${p}`;
  const plugin = (p: string, configs: string[]) => [`${p}:lint`, `plugins/bundled/${p}`, [...configs.map((c) => tsc(c)), ox("../../../")].join(" && "), false, false, "{}"];
  const unit = (name: string, cwd: string) => [name, cwd, "node --test test/*.test.ts", false, false, "{}"];
  const fixtures = ["critters/tsconfig.json", "drawn-pet/tsconfig.json", "drawn-pet/public/tsconfig.json", "drawn-sheet/public/tsconfig.json", "ui-demo/tsconfig.json", "ui-demo/public/tsconfig.json", "ui-demo/public/views/tsconfig.json"];
  assert.deepEqual(gates.map(row), [
    ["server:lint", "server", "gofmt -l . && go vet ./... && go tool staticcheck ./...", true, false, "{}"],
    ["web:lint", "web", ["pnpm exec tsc --noEmit", "pnpm exec tsc -p tsconfig.test.json --noEmit", "pnpm exec tsc -p tsconfig.sdk.json", ox("../", "src test")].join(" && "), false, false, "{}"],
    ["site:lint", "site", `pnpm exec tsc --noEmit && ${ox("../")}`, false, false, "{}"],
    ["e2e:lint", "e2e", ["pnpm exec tsc --noEmit", ...fixtures.map((f) => tsc("fixtures/plugins/installed/" + f)), ox("../")].join(" && "), false, false, "{}"],
    ["docs:lint", "docs", "node ../scripts/check-protocol-docs.ts", false, false, "{}"],
    ["desktop:lint", "desktop", `${tsc(".")} && ${ox("../", "ui src-tauri/src")}`, false, false, "{}"],
    ["scripts:lint", "scripts", `${tsc("tsconfig.test.json")} && ${ox("../")}`, false, false, "{}"],
    ["fdash:lint", "tools/fdash", `${tsc("tsconfig.test.json")} && ${ox("../../")}`, false, false, "{}"],
    ["sdk:lint", "plugins/sdk", `${tsc("tsconfig.test.json")} && ${ox("../../")}`, false, false, "{}"],
    plugin("hq-card-lastcard", ["tsconfig.json", "tsconfig.test.json"]),
    plugin("hq-card-pouilleux", ["tsconfig.json", "tsconfig.test.json"]),
    plugin("hq-cards", ["tsconfig.json", "public/tsconfig.json", "tsconfig.test.json"]),
    plugin("hq-chess", ["tsconfig.json", "public/tsconfig.json", "tsconfig.test.json"]),
    plugin("hq-pets", ["tsconfig.json", "public/tsconfig.json", "tsconfig.test.json"]),
    ...PLUGIN_E2E.map((p) => [`${p}:lint`, `plugins/e2e/${p}`, `${tsc("tsconfig.json")} && ${ox("../../../")}`, false, false, "{}"]),
    ["server:build", "server", "go build -o ../bin/ ./cmd/homequarters", false, false, "{}"],
    ["web:build", "web", "pnpm exec vite build", false, false, "{}"],
    ["site:build", "site", "node build.ts", false, false, "{}"],
    ["server:test:unit", "server", "go test -race -count=1 ./...", false, false, "{}"],
    ["web:test:unit", "web", "pnpm exec vitest run", false, false, "{}"],
    ["site:test:unit", "site", "node check.ts", false, false, "{}"],
    ["e2e:test:unit", "e2e", "pnpm exec vitest run", false, false, "{}"],
    ["scripts:test:unit", "scripts", "pnpm exec vitest run", false, false, "{}"],
    unit("fdash:test:unit", "tools/fdash"),
    unit("hq-card-lastcard:test:unit", "plugins/bundled/hq-card-lastcard"),
    unit("hq-card-pouilleux:test:unit", "plugins/bundled/hq-card-pouilleux"),
    unit("hq-cards:test:unit", "plugins/bundled/hq-cards"),
    unit("hq-chess:test:unit", "plugins/bundled/hq-chess"),
    ...INTEGRATION.map((n) => [n, n.startsWith("sdk:") ? "plugins/sdk" : `plugins/bundled/${n.split(":")[0]}`, "node --test **/*.ispec.ts", false, false, '{"HQ_BIN_REPO_ONLY":"1"}']),
    [BROWSER, "e2e", "node run.ts", false, true, '{"E2E_VIEWPORT":"small","E2E_PREBUILT":"1"}'],
    ...[
      ["hq-card-lastcard-e2e", "--plugin ../../bundled/hq-cards --plugin ../../bundled/hq-card-lastcard lastCard.ts"],
      ["hq-card-pouilleux-e2e", "--plugin ../../bundled/hq-cards --plugin ../../bundled/hq-card-pouilleux oldMaid.ts"],
      ["hq-cards-e2e", "--plugin ../../bundled/hq-cards cards.ts"],
      ["hq-chess-e2e", "--plugin ../../bundled/hq-chess chess.ts"],
    ].map(([p, args]) => [`${p}:test:e2e`, `plugins/e2e/${p}`, `node ../../../e2e/plugin-run.ts ${args}`, false, false, '{"E2E_VIEWPORT":"small","HQ_BIN_REPO_ONLY":"1"}']),
  ]);
  // the integration and browser suites start once the build is done: default runs its tiers one after the
  // other; the integration suites run at once (each testbed has its own port and database), the browser suites
  // one at a time (the suite already shards itself; a plugin suite beside it starved its plugin's 50 ms budget)
  assert.deepEqual(config.get("default"), { kind: "group", name: "default", tasks: ["static", "integration", "browser"], jobs: 1, after: [] });
  assert.deepEqual(config.get("integration"), { kind: "group", name: "integration", tasks: INTEGRATION, after: [] });
  assert.deepEqual(config.get("browser"), { kind: "group", name: "browser", tasks: [BROWSER, ...PLUGIN_SUITES], jobs: 1, after: [] });
  assert.equal((config.get("static") as { jobs?: number }).jobs, undefined);
});

test("every plugin has its own tsconfig.json files checked by its lint, the e2e fixtures by e2e's", () => {
  const config = loadWorkspace(root);
  const tracked = execFileSync("git", ["ls-files", "--", "plugins/**/tsconfig.json", "e2e/fixtures/plugins/**/tsconfig.json"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const lints = [...config.values()].filter((t): t is Command => t.kind === "command" && t.name.endsWith(":lint"));
  const checked = lints.flatMap((c) => c.run.filter((s) => s.includes("-p")).map((s) => path.posix.join(c.cwd, s[s.indexOf("-p") + 1])));
  assert.deepEqual(tracked.filter((t) => !checked.includes(t)), []);
});

test("the gauntlet runs default; named scenarios go to the e2e project's suite only", () => {
  const config = loadWorkspace(root);
  assert.deepEqual(plan(config, [], false), { names: ["default"], skip: [], suites: [BROWSER, ...PLUGIN_SUITES] });
  assert.deepEqual(plan(config, [], true).skip, [BROWSER, ...PLUGIN_SUITES]);
  assert.deepEqual(plan(config, ["social"], false).skip, PLUGIN_SUITES);
});

test("build tasks declare what they produce; site checks its build after making it", () => {
  const config = loadWorkspace(root);
  const cmd = (n: string) => config.get(n) as Command;
  assert.deepEqual(cmd("server:build").outputs, ["bin/homequarters*"]);
  assert.deepEqual(cmd("web:build").outputs, ["web/dist/**"]);
  assert.deepEqual(cmd("site:build").outputs, ["site/dist/**"]);
  assert.deepEqual(cmd("site:test:unit").after, ["site:build"]);
  for (const n of ["server:build", "server:test:unit"]) for (const k of ["GOFLAGS", "CGO_ENABLED"]) assert.ok(cmd(n).envKeys.includes(k), `${n} keys on ${k}`);
  // a suite run against what a build wrote reads that artefact as an input: a stale binary or client gives
  // another key, so a pass recorded on it never answers for the rebuilt one
  const disk = (n: string) => (cmd(n).inputs ?? []).flatMap((i) => (typeof i === "object" && "disk" in i ? [i.disk] : []));
  for (const n of INTEGRATION) assert.deepEqual(disk(n), ["bin/homequarters*"], n);
  for (const n of [BROWSER, ...PLUGIN_SUITES]) assert.deepEqual(disk(n), ["bin/homequarters*", "web/dist/**"], n);
});

test("a plugin depends on the server and the SDK, never on the web client; the server on no plugin", () => {
  const bundled = path.join(root, "plugins/bundled");
  for (const p of fs.readdirSync(bundled)) {
    const deps: string[] = JSON.parse(fs.readFileSync(path.join(bundled, p, "fdash.json"), "utf8")).dependsOn ?? [];
    assert.ok(deps.includes("server") && deps.includes("sdk"), `${p} depends on server and sdk`);
    assert.ok(!deps.includes("web"), `${p} does not depend on web`);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "server/fdash.json"), "utf8")).dependsOn, undefined);
});

test("every gate is cached, and every scenario of the suite is an item with its own file", () => {
  const gates = expand(loadWorkspace(root), ["default"], []);
  for (const g of gates) assert.ok(g.inputs && g.inputs.length > 0 && g.cache, `${g.name} is cached`);
  const e2e = gates.find((g) => g.name === BROWSER)!;
  assert.deepEqual([...e2e.items!.keys()], ALL);
  for (const [s, item] of e2e.items!) assert.ok(item.inputs.includes(`e2e/scenarios/${s}.ts`), s);
  assert.ok(e2e.inputs!.includes("!e2e/scenarios/**"), "a scenario's file reruns that scenario only");
  // scenarios that turn a bundled plugin on follow that plugin's code; scenarios that list the plugins' catalog
  // follow every plugin's manifest (the catalog reads plugin.json and checks the files exist, it compiles nothing:
  // load in server/internal/plugin/catalog.go)
  const follows = (s: string, p: string) => e2e.items!.get(s)!.inputs.some((i) => typeof i === "string" && path.posix.matchesGlob(`plugins/bundled/${p}/main.ts`, i));
  const manifests = (s: string) => [...e2e.inputs!, ...e2e.items!.get(s)!.inputs].some((i) => typeof i === "string" && path.posix.matchesGlob("plugins/bundled/hq-any/plugin.json", i));
  for (const s of ALL) {
    const text = fs.readFileSync(path.join(root, "e2e/scenarios", s + ".ts"), "utf8");
    for (const p of fs.readdirSync(path.join(root, "plugins/bundled"))) if (text.includes(p)) assert.ok(follows(s, p), `${s} names ${p}: its folder is an input`);
    if (/\[role=tab\]", "Plugins"|Plugins tab|plugins tab/.test(text)) assert.ok(manifests(s), `${s} lists the plugins: every plugin's plugin.json is an input`);
  }
});

test("each plugin's tests run in its project, and import nothing outside it and what it depends on", () => {
  const config = loadWorkspace(root);
  const bundled = path.join(root, "plugins/bundled");
  for (const p of fs.readdirSync(bundled)) {
    const dir = path.join(bundled, p, "test");
    if (!fs.existsSync(dir)) continue;
    // a plugin may have only integration tests (hq-pets: test/*.ispec.ts)
    const task = (config.get(`${p}:test:unit`) ?? config.get(`${p}:test:integration`)) as Command | undefined;
    assert.ok(task, `${p} has tests, so a project with a test task`);
    const deps: string[] = JSON.parse(fs.readFileSync(path.join(bundled, p, "fdash.json"), "utf8")).dependsOn ?? [];
    const allowed = [path.join(bundled, p), ...deps.map((d) => (d === "sdk" ? path.join(root, "plugins/sdk") : path.join(bundled, d)))];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|new URL\(\s*)["'](\.[^"']+)["']/g)) {
        const target = path.resolve(dir, m[1]);
        assert.ok(allowed.some((a) => target.startsWith(a + path.sep)), `${p}/test/${f} reaches ${m[1]}, outside ${p} and its dependsOn`);
      }
    }
  }
});

test("an e2e project's scenarios import only its folder, its dependsOn and the inputs of its test:e2e", () => {
  const config = loadWorkspace(root);
  const e2e = path.join(root, "plugins/e2e");
  const dirOf = (name: string) => (name === "web" ? path.join(root, "web") : path.join(root, "plugins/bundled", name));
  for (const p of fs.readdirSync(e2e).filter((x) => fs.existsSync(path.join(e2e, x, "fdash.json")))) {
    const deps: string[] = JSON.parse(fs.readFileSync(path.join(e2e, p, "fdash.json"), "utf8")).dependsOn ?? [];
    const inputs = ((config.get(`${p}:test:e2e`) as Command).inputs ?? []).filter((i): i is string => typeof i === "string" && !i.startsWith("!"));
    const allowed = [path.join(e2e, p), ...deps.map(dirOf)];
    for (const f of fs.readdirSync(path.join(e2e, p)).filter((x) => x.endsWith(".ts"))) {
      for (const m of fs.readFileSync(path.join(e2e, p, f), "utf8").matchAll(/(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
        const target = path.resolve(e2e, p, m[1]);
        const rel = path.relative(root, target).split(path.sep).join("/");
        assert.ok(allowed.some((a) => target.startsWith(a + path.sep)) || inputs.some((i) => path.posix.matchesGlob(rel, i)), `${p}/${f} reaches ${m[1]}: not in ${p}, its dependsOn or its test:e2e inputs`);
      }
    }
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

test("no file names a test of web/test, a plugin's test/ or tools/fdash/test that does not exist", () => {
  // docs/status.md and the design notes keep their history; everything else follows the files
  const out = execFileSync("git", ["grep", "-n", "-o", "-E", "([a-z-]+/)*test/[A-Za-z]+\\.test\\.ts", "--", ".", ":!docs/status.md", ":!docs/superpowers", ":!site", ":!tools/fdash/test"], { cwd: root, encoding: "utf8" });
  const missing: string[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [file, , ref] = line.split(":");
    // a path from the root, from the file's folder, or a plugin's own (hq-cards/test/controls.test.ts)
    const candidates = [path.join(root, ref), path.join(root, path.dirname(file), ref), path.join(root, "plugins/bundled", ref)];
    if (!candidates.some((c) => fs.existsSync(c))) missing.push(`${file} names ${ref}`);
  }
  assert.deepEqual(missing, []);
});

test("files a test reads outside its project are inputs of the task that runs it", () => {
  const config = loadWorkspace(root);
  const covered = (task: string, rel: string) => {
    const inputs = ((config.get(task) as Command).inputs ?? []).filter((i): i is string => typeof i === "string" && !i.startsWith("!"));
    // a folder read whole needs a pattern that covers any file in it, not only one of its sub-folders
    return inputs.some((p) => path.posix.matchesGlob(rel, p) || path.posix.matchesGlob(rel + "/any/file", p));
  };
  const missing: string[] = [];
  const files = (dir: string, re: RegExp): string[] => fs.readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && re.test(e.name) && !e.parentPath.includes("node_modules")).map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join("/"));
  // Go tests climbing out of server/internal/<pkg>: filepath.Join("..", "..", "..", "web", "dev", name)
  for (const f of files("server", /_test\.go$/)) {
    for (const m of fs.readFileSync(path.join(root, f), "utf8").matchAll(/filepath\.Join\((?:"\.\.", ){3}((?:"[^"]+"(?:, )?)+)/g)) {
      const rel = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).join("/");
      if (!covered("server:test:unit", rel)) missing.push(`${f} reads ${rel}, not an input of server:test:unit`);
    }
  }
  // tests reading files by URL or from their folder (`${import.meta.dirname}/../x`: under Vitest, Vite rewrites
  // new URL("..", import.meta.url) into a served address)
  const owners: [string, string, string][] = [["web/test", "web:test:unit", "web"], ["scripts", "scripts:test:unit", "scripts"],
    ...fs.readdirSync(path.join(root, "plugins/bundled")).filter((p) => fs.existsSync(path.join(root, "plugins/bundled", p, "test"))).map((p): [string, string, string] => [`plugins/bundled/${p}/test`, `${p}:test:unit`, `plugins/bundled/${p}`])];
  for (const [dir, task, project] of owners) {
    for (const f of files(dir, /\.test\.tsx?$/)) {
      const text = fs.readFileSync(path.join(root, f), "utf8");
      for (const m of text.matchAll(/new URL\("(\.\.?\/[^"]+)", import\.meta\.url\)|`\$\{import\.meta\.dirname\}\/([^`$]+)`/g)) {
        const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1] ?? m[2]));
        if (!rel.startsWith(project + "/") && !covered(task, rel)) missing.push(`${f} reads ${rel}, not an input of ${task}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("one install for the repository: no package reaches into another's node_modules, each declares the tools it runs", () => {
  // a relative path into another package's node_modules borrows that package's install: its
  // dependencies change under it without its own package.json saying so
  const tracked = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", "*.ts", "*.tsx", "*.js", "*.json", "*.yml", "*.yaml", "*.sh", "deploy/Dockerfile"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const reaching: string[] = [];
  for (const f of tracked) {
    if (f.startsWith("docs/superpowers/") || !fs.existsSync(path.join(root, f))) continue;
    for (const m of fs.readFileSync(path.join(root, f), "utf8").matchAll(/\.\.\/[\w./-]*node_modules\//g)) reaching.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(reaching, []);
  assert.ok(!fs.existsSync(path.join(root, "web/pnpm-lock.yaml")), "one lockfile, at the root");
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(rootPkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/, "the root pins pnpm");
  assert.equal(rootPkg.dependencies ?? rootPkg.devDependencies, undefined, "the root declares no dependency: each project declares its own");
  // a project runs the tools its package.json declares (pnpm exec finds only those), and its commands follow the install
  const config = loadWorkspace(root);
  const TOOL: Record<string, string[]> = { tsc: ["typescript"], vitest: ["vitest"], vite: ["vite"] };
  const problems: string[] = [];
  for (const c of [...config.values()].filter((t): t is Command => t.kind === "command")) {
    const needs = c.run.flatMap((s) => (s[0] === "pnpm" && s[1] === "exec" ? TOOL[s[2]] ?? [s[2]] : s.some((a) => a.endsWith("scripts/oxlint.ts")) ? ["oxlint", "oxlint-tsgolint"] : []));
    if (!needs.length) continue;
    const pkgFile = path.join(root, c.cwd, "package.json");
    const pkg = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, "utf8")) : {};
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const n of needs) if (!declared[n]) problems.push(`${c.name} runs ${n}, not declared in ${c.cwd}/package.json`);
    const inputs = (c.inputs ?? []).filter((i): i is string => typeof i === "string");
    for (const f of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) if (!inputs.some((i) => i === "**" || i === f)) problems.push(`${c.name} runs installed tools: /${f} is not an input`);
  }
  assert.deepEqual(problems, []);
});

test("versions shared by several packages are written once, in the workspace's catalog", () => {
  const members = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", "*package.json"], { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f && f !== "package.json");
  const seen = new Map<string, string[]>();
  for (const f of members) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
    for (const [n, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }) as [string, string][]) if (v !== "catalog:") seen.set(n, [...(seen.get(n) ?? []), f]);
  }
  const used = new Map<string, number>();
  for (const f of members) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
    for (const n of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) used.set(n, (used.get(n) ?? 0) + 1);
  }
  const duplicated = [...seen].filter(([n]) => (used.get(n) ?? 0) > 1).map(([n, where]) => `${n} has a version of its own in ${where.join(", ")}: use "catalog:"`);
  assert.deepEqual(duplicated, []);
});

test("no scenario of the suite imports another (each is cached on its own file)", () => {
  for (const s of ALL) {
    const text = fs.readFileSync(path.join(root, "e2e/scenarios", s + ".ts"), "utf8");
    for (const m of text.matchAll(/from\s+["']\.\/([\w-]+)\.ts["']/g)) assert.fail(`${s} imports ./${m[1]}.ts: editing it would not rerun ${s}`);
  }
});

test("the guards above read the whole repository, so scripts:test:unit follows every file", () => {
  assert.ok(((loadWorkspace(root).get("scripts:test:unit") as Command).inputs ?? []).includes("**"), "scripts:test:unit needs /** in its inputs");
});

test("the tooling Node runs as is loads in Node: erasable syntax only, relative imports with their extension", () => {
  // tsc cannot say it for every tree (e2e/ and web/tsconfig.test.json also read the client, which is not run by
  // Node), and several of these files run in no gate (art tools, captures, sprite tools): Node's own stripping
  // throws on what it refuses, and an extensionless relative import would not resolve
  const tracked = execFileSync("git", ["ls-files", "--", "e2e/*.ts", "scripts/*.ts", "site/*.ts", "tools/*.ts", "plugins/bundled/*/tools/*.ts", "plugins/bundled/*/test/*.ts"], { cwd: root, encoding: "utf8" })
    .split("\n").filter((f) => f && !f.startsWith("e2e/fixtures/") && !f.endsWith(".d.ts"));
  assert.ok(tracked.length > 70, `found only ${tracked.length} files`);
  const bad: string[] = [];
  for (const f of tracked) {
    const code = fs.readFileSync(path.join(root, f), "utf8");
    try { stripTypeScriptTypes(code); } catch (e) { bad.push(`${f}: ${(e as Error).message.split("\n")[0]}`); }
    for (const m of code.matchAll(/(?:from|import\()\s*["'](\.\.?\/[^"']+)["']/g)) if (!/\.(ts|js|json|mjs)$/.test(m[1])) bad.push(`${f}: import "${m[1]}" without its extension`);
  }
  assert.deepEqual(bad, []);
});
