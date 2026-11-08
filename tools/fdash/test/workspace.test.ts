// fdash workspaces: projects, qualified names, dependsOn, default inputs, names across projects, --pkg, and what reruns. Run: node --test tools/fdash/test/workspace.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadWorkspace, select } from "../workspace.ts";
import { expand, type Command, type Group } from "../config.ts";
import { run, type Result } from "../run.ts";

function tree(files: Record<string, unknown>, git = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fdash-ws-"));
  for (const [f, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), typeof v === "string" ? v : JSON.stringify(v));
  }
  if (git) {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
    g("init", "-q");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    g("add", "-A");
    g("commit", "-qm", "init");
  }
  return root;
}
const NODE = process.execPath;
const counting = (n: string) => ({ run: [[NODE, "-e", `require("fs").appendFileSync(require("path").join(${JSON.stringify("")}||process.cwd(),"ran-${n}"),"x")`]] });

test("projects: qualified names, cwd, default inputs with dependsOn, bare names across projects, and the workspace's own tasks", () => {
  const root = tree({
    "fdash-workspace.json": { projects: ["lib", "addons/*"], tasks: { default: { jobs: 1, tasks: ["static", "e2e"] }, static: { tasks: ["test", "docs"] }, docs: { run: [["node", "d.mjs"]], inputs: ["docs/**"] } } },
    "lib/fdash.json": { name: "core", files: ["src/**"], tasks: { test: { run: [["node", "t"]] } } },
    "addons/app/fdash.json": { dependsOn: ["core"], tasks: {
      test: { run: [["node", "t"]], cwd: "sub", inputs: ["/shared/x.txt", "!src/gen/**", { go: "./cmd", cwd: "srv" }, { disk: "/bin/core*" }, { disk: "dist/**" }], outputs: ["bin/app", "/dist/**", "!bin/*.tmp"] },
      all: { tasks: ["test", "e2e"] },
      e2e: { run: [["node", "e"]], args: true, inputs: ["!scenarios/**"], items: { one: { inputs: ["scenarios/one.mjs"] } } },
      dev: { run: [["node", "dev"]], cache: false },
    } },
    "addons/notaproject/readme.md": "no fdash.json here",
  });
  const c = loadWorkspace(root);
  assert.deepEqual([...c.keys()], ["default", "static", "docs", "core:test", "app:test", "app:all", "app:e2e", "app:dev"]);
  assert.deepEqual((c.get("static") as Group).tasks, ["core:test", "app:test", "docs"]);
  assert.deepEqual((c.get("app:all") as Group).tasks, ["app:test", "app:e2e"]);
  const t = c.get("app:test") as Command;
  assert.equal(t.cwd, "addons/app/sub");
  assert.deepEqual(t.outputs, ["addons/app/bin/app", "dist/**", "!addons/app/bin/*.tmp"]);
  assert.deepEqual(t.inputs, ["addons/app/**", "lib/src/**", "shared/x.txt", "!addons/app/src/gen/**", { go: "./cmd", cwd: "addons/app/srv", tests: false }, { disk: "bin/core*" }, { disk: "addons/app/dist/**" }]);
  assert.deepEqual((c.get("core:test") as Command).inputs, ["lib/**"]);
  assert.equal((c.get("core:test") as Command).cwd, "lib");
  const e = c.get("app:e2e") as Command;
  assert.deepEqual(e.inputs, ["addons/app/**", "lib/src/**", "!addons/app/scenarios/**"]);
  assert.deepEqual(e.items!.get("one"), { inputs: ["addons/app/scenarios/one.mjs"] });
  assert.equal((c.get("app:dev") as Command).cache, false);
  assert.deepEqual((c.get("docs") as Command).inputs, ["docs/**"]);
  assert.deepEqual(expand(c, ["default"], []).map((x) => x.name), ["core:test", "app:test", "docs", "app:e2e"]);
});

test("dependsOn is transitive; refusals name the file", () => {
  const ws = (projects: string[]) => ({ projects });
  const ok = tree({
    "fdash-workspace.json": ws(["a", "b", "c"]),
    "a/fdash.json": { tasks: { t: { run: [["x"]] } } },
    "b/fdash.json": { dependsOn: ["a"], files: ["lib/**"] },
    "c/fdash.json": { dependsOn: ["b"], tasks: { t: { run: [["x"]] } } },
  });
  assert.deepEqual((loadWorkspace(ok).get("c:t") as Command).inputs, ["c/**", "b/lib/**", "a/**"]);
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ "fdash-workspace.json": { projects: "a" } }, /fdash-workspace\.json: projects/],
    [{ "fdash-workspace.json": { projects: [], foo: 1 } }, /fdash-workspace\.json: unknown key foo/],
    [{ "fdash-workspace.json": ws(["missing"]) }, /missing.*fdash\.json/],
    [{ "fdash-workspace.json": ws(["a", "b"]), "a/fdash.json": {}, "b/x/fdash.json": {}, "b/fdash.json": { name: "a" } }, /two projects named a/],
    [{ "fdash-workspace.json": ws(["a"]), "a/fdash.json": { dependsOn: ["nope"] } }, /a\/fdash\.json: .*nope/],
    [{ "fdash-workspace.json": ws(["a"]), "a/fdash.json": { foo: 1 } }, /a\/fdash\.json: unknown key foo/],
    [{ "fdash-workspace.json": ws(["a"]), "a/fdash.json": { tasks: { g: { tasks: ["zz"] } } } }, /a:g: no task named zz/],
    [{ "fdash-workspace.json": { projects: ["a"], tasks: { s: { tasks: ["nothing"] } } }, "a/fdash.json": {} }, /s: no task named nothing/],
    [{ "fdash-workspace.json": { projects: ["a"], tasks: { s: { tasks: ["a:t"] } } }, "a/fdash.json": { tasks: { t: { run: [["x"]] } } } }, /s: no task named a:t/],
    [{ "fdash-workspace.json": ws(["a", "b"]), "a/fdash.json": { dependsOn: ["b"] }, "b/fdash.json": { dependsOn: ["a"] } }, /dependsOn.*cycle/],
  ];
  for (const [files, re] of bad) assert.throws(() => loadWorkspace(tree(files)), re);
});

test("dependsOn from a go.mod: the projects its replace directives point at, with the names written beside it", () => {
  const goMod = (requires: string[], replaces: string) => `module m\n\ngo 1.22\n\nrequire (\n${requires.map((r) => `\t${r} v0.0.0\n`).join("")})\n\n${replaces}\n`;
  const root = tree({
    "fdash-workspace.json": { projects: ["libs/*", "cmd/app", "site"] },
    "libs/core/fdash.json": { dependsOn: [{ goMod: "go.mod" }], tasks: { t: { run: [["x"]] } } }, "libs/core/go.mod": "module core\n",
    "libs/net/fdash.json": { dependsOn: [{ goMod: "go.mod" }], tasks: { t: { run: [["x"]] } } },
    "libs/net/go.mod": goMod(["core", "example.com/remote"], "replace core => ../core\nreplace example.com/remote => example.com/fork v1.0.0"),
    "cmd/app/fdash.json": { dependsOn: ["site", { goMod: "go.mod" }], tasks: { t: { run: [["x"]] }, build: { run: [["x"]] } } },
    "cmd/app/go.mod": goMod(["core", "net"], "replace (\n\tcore => ../../libs/core\n\tnet => ../../libs/net/\n)"),
    "site/fdash.json": { tasks: { build: { run: [["x"]] } } },
  });
  const c = loadWorkspace(root);
  assert.deepEqual((c.get("net:t") as Command).inputs, ["libs/net/**", "libs/core/**"]);
  assert.deepEqual((c.get("app:t") as Command).inputs, ["cmd/app/**", "site/**", "libs/core/**", "libs/net/**"]);
  // order follows them as it follows dependsOn
  assert.deepEqual(c.get("app:t")!.after, ["core:t", "net:t"]);
  assert.deepEqual(c.get("app:build")!.after, ["site:build"]);
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ "fdash-workspace.json": { projects: ["a"] }, "a/fdash.json": { dependsOn: [{ goMod: "go.mod" }] } }, /a\/fdash\.json: dependsOn reads a\/go\.mod, which does not exist/],
    [{ "fdash-workspace.json": { projects: ["a"] }, "a/fdash.json": { dependsOn: [{ goMod: "go.mod" }] }, "a/go.mod": goMod(["b"], "replace b => ../b") }, /a\/go\.mod: b is replaced by \.\.\/b, which is no project \(list b in fdash-workspace\.json\)/],
    [{ "fdash-workspace.json": { projects: ["a"] }, "a/fdash.json": { dependsOn: [{ go: "." }] } }, /a\/fdash\.json: dependsOn must be/],
  ];
  for (const [files, re] of bad) assert.throws(() => loadWorkspace(tree(files)), re);
});

test("what reruns: a project's change reruns its tasks and its dependents', not the others'", async () => {
  const root = tree({
    ".gitignore": ".fdash/\nran-*\n",
    "fdash-workspace.json": { projects: ["core", "p1", "p2", "ui"], tasks: { all: { tasks: ["test"] } } },
    "core/fdash.json": { tasks: { test: counting("core") } }, "core/a.ts": "1",
    "p1/fdash.json": { dependsOn: ["core"], tasks: { test: counting("p1") } }, "p1/a.ts": "1",
    "p2/fdash.json": { tasks: { test: counting("p2") } }, "p2/a.ts": "1",
    "ui/fdash.json": { files: ["src/**"], tasks: { test: counting("ui") } }, "ui/src/a.ts": "1", "ui/test/a.test.ts": "1",
  }, true);
  const config = loadWorkspace(root);
  const lines = async () => (await run({ root, config, names: ["all"], jobs: 2 })).results.map((r: Result) => `${r.cached ? "CACHED" : r.ok ? "PASS" : "FAIL"} ${r.name}`);
  assert.deepEqual(await lines(), ["PASS core:test", "PASS p1:test", "PASS p2:test", "PASS ui:test"]);
  fs.writeFileSync(path.join(root, "p2/a.ts"), "2");
  assert.deepEqual(await lines(), ["CACHED core:test", "CACHED p1:test", "PASS p2:test", "CACHED ui:test"]);
  fs.writeFileSync(path.join(root, "core/a.ts"), "2");
  assert.deepEqual(await lines(), ["PASS core:test", "PASS p1:test", "CACHED p2:test", "CACHED ui:test"]);
  fs.writeFileSync(path.join(root, "ui/test/a.test.ts"), "2");
  assert.deepEqual(await lines(), ["CACHED core:test", "CACHED p1:test", "CACHED p2:test", "PASS ui:test"]);
});

test("select: a name in every project defining it, --pkg restricts, colons in names, refusals", () => {
  const root = tree({
    "fdash-workspace.json": { projects: ["a", "b"], tasks: { default: { tasks: ["test:unit", "lint"] }, docs: { run: [["x"]] } } },
    "a/fdash.json": { tasks: { "test:unit": { run: [["x"]] }, lint: { run: [["x"]] }, all: { tasks: ["test:unit", "lint"] } } },
    "b/fdash.json": { dependsOn: ["a"], tasks: { "test:unit": { run: [["x"]] } } },
  });
  const cfg = loadWorkspace(root);
  assert.deepEqual(select(cfg, ["test:unit"], []), ["a:test:unit", "b:test:unit"]);
  assert.deepEqual(select(cfg, ["test:unit"], ["b"]), ["b:test:unit"]);
  assert.deepEqual(select(cfg, ["test:unit", "lint"], ["a"]), ["a:test:unit", "a:lint"]);
  assert.deepEqual(select(cfg, ["default", "docs"], []), ["default", "docs"]);
  assert.throws(() => select(cfg, ["lint"], ["b"]), /b has no task lint/);
  assert.throws(() => select(cfg, ["lint"], ["nope"]), /no project named nope/);
  assert.throws(() => select(cfg, ["nope"], []), /no task named nope/);
  assert.throws(() => select(cfg, ["a:lint"], []), /no task named a:lint.*lint --pkg a/);
  assert.throws(() => select(cfg, ["docs"], ["a"]), /docs is a workspace task/);
  // a workspace group's bare member: that task in every project defining it
  assert.deepEqual((cfg.get("default") as Group).tasks, ["a:test:unit", "b:test:unit", "a:lint"]);
  // a project group's member: first its own project's task
  assert.deepEqual((cfg.get("a:all") as Group).tasks, ["a:test:unit", "a:lint"]);
  assert.deepEqual(expand(cfg, select(cfg, ["all"], []), []).map((c) => c.name), ["a:test:unit", "a:lint"]);
  // a workspace task named like a project task would make a bare name mean two things
  const clash = tree({
    "fdash-workspace.json": { projects: ["a"], tasks: { "test:unit": { run: [["x"]] } } },
    "a/fdash.json": { tasks: { "test:unit": { run: [["x"]] } } },
  });
  assert.throws(() => loadWorkspace(clash), /test:unit: both a workspace task and a project task/);
});
