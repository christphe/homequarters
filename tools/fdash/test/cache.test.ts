// fdash's cache: what reruns and what does not, Go packages as inputs, and items. Run: node --test tools/fdash/test/cache.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../config.ts";
import { run, type Result } from "../run.ts";
import { cacheKey, resolveInputs, resolveOutputs } from "../cache.ts";
import { printResult } from "../cli.ts";

const NODE = process.execPath;
const node = (code: string) => [NODE, "-e", code];

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fdash-cache-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "core.autocrlf", "false");
  for (const [f, text] of Object.entries(files)) write(root, f, text);
  g("add", "-A");
  g("commit", "-qm", "init");
  return root;
}
function write(root: string, f: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
  fs.writeFileSync(path.join(root, f), text);
}
// a command that counts its runs in <root>/count-<name>
const counting = (name: string, extra: object = {}) => ({ run: [node(`require("fs").appendFileSync("count-${name}","x")`)], ...extra });
const runs = (root: string, name: string) => { try { return fs.readFileSync(path.join(root, `count-${name}`), "utf8").length; } catch { return 0; } };
const lines = (rs: Result[]) => rs.map((r) => `${r.cached ? "CACHED" : r.ok ? "PASS" : "FAIL"} ${r.name}`);

async function go(root: string, tasks: object, more: Partial<Parameters<typeof run>[0]> = {}) {
  const config = parseConfig(JSON.stringify({ tasks }));
  return run({ root, config, names: [...config.keys()].slice(0, 1), jobs: 2, cacheDir: path.join(root, ".fdash", "cache"), ...more });
}

test("a second run with nothing changed runs nothing; each kind of change reruns only its command", async () => {
  const root = repo({ "a/x.txt": "1", "b/y.txt": "1", ".gitignore": ".fdash/\ncount-*\nignored/\n" });
  const tasks = {
    all: { tasks: ["a", "b", "nocache"] },
    a: counting("a", { inputs: ["a/**"], envKeys: ["FDASH_TEST_V"] }),
    b: counting("b", { inputs: ["b/**", "!b/skip/**"], args: true }),
    nocache: counting("nocache"),
  };
  assert.deepEqual(lines((await go(root, tasks)).results), ["PASS a", "PASS b", "PASS nocache"]);
  assert.deepEqual(lines((await go(root, tasks)).results), ["CACHED a", "CACHED b", "PASS nocache"]);
  assert.deepEqual([runs(root, "a"), runs(root, "b"), runs(root, "nocache")], [1, 1, 2]);

  write(root, "a/x.txt", "2");
  assert.deepEqual(lines((await go(root, tasks)).results).slice(0, 2), ["PASS a", "CACHED b"], "an edited input");
  write(root, "a/new.txt", "untracked");
  assert.deepEqual(lines((await go(root, tasks)).results).slice(0, 2), ["PASS a", "CACHED b"], "a new untracked file");
  write(root, "ignored/z.txt", "1");
  write(root, "b/skip/z.txt", "1");
  write(root, "c.txt", "1");
  assert.deepEqual(lines((await go(root, tasks)).results).slice(0, 2), ["CACHED a", "CACHED b"], "ignored, excluded and unrelated files");
  process.env.FDASH_TEST_V = "1";
  try {
    assert.deepEqual(lines((await go(root, tasks)).results).slice(0, 2), ["PASS a", "CACHED b"], "an envKeys value");
  } finally {
    delete process.env.FDASH_TEST_V;
  }
  assert.deepEqual(lines((await go(root, tasks, { extraArgs: ["z"] })).results).slice(0, 2), ["CACHED a", "PASS b"], "other extra arguments");
  assert.deepEqual(lines((await go(root, { ...tasks, a: { ...tasks.a, env: { K: "v" } } })).results).slice(0, 2), ["PASS a", "CACHED b"], "a changed definition");
  fs.rmSync(path.join(root, "b/y.txt"));
  assert.deepEqual(lines((await go(root, tasks)).results).slice(0, 2), ["CACHED a", "PASS b"], "a deleted input");
  assert.deepEqual(lines((await go(root, tasks, { force: true })).results).slice(0, 2), ["PASS a", "PASS b"], "--force");
});

test("a failure is not recorded", async () => {
  const root = repo({ "a.txt": "1", ".gitignore": ".fdash/\ncount-*\n" });
  const tasks = { bad: { run: [node(`require("fs").appendFileSync("count-bad","x");process.exit(1)`)], inputs: ["a.txt"] } };
  assert.deepEqual(lines((await go(root, tasks)).results), ["FAIL bad"]);
  assert.deepEqual(lines((await go(root, tasks)).results), ["FAIL bad"]);
  assert.equal(runs(root, "bad"), 2);
});

const hasGo = spawnSync("go", ["version"]).status === 0;
test("a Go provider follows the packages a pattern reaches, and their tests when asked", { skip: !hasGo && "go is not installed" }, () => {
  const root = repo({
    "m/go.mod": "module example.com/m\n\ngo 1.22\n",
    "m/cmd/main.go": 'package main\n\nimport "example.com/m/a"\n\nfunc main() { a.A() }\n',
    "m/a/a.go": "package a\n\nfunc A() {}\n",
    "m/a/a_test.go": 'package a\n\nimport "testing"\n\nfunc TestA(t *testing.T) {}\n',
    "m/a/testdata/x.txt": "x",
    "m/b/b.go": "package b\n",
  });
  assert.deepEqual(resolveInputs(root, [{ go: "./cmd", cwd: "m", tests: false }]), ["m/a/a.go", "m/cmd/main.go", "m/go.mod", "m/go.sum"]);
  assert.deepEqual(resolveInputs(root, [{ go: "./...", cwd: "m", tests: true }]), ["m/a/a.go", "m/a/a_test.go", "m/a/testdata/x.txt", "m/b/b.go", "m/cmd/main.go", "m/go.mod", "m/go.sum"]);
});

// items: a command that reads its arguments and writes FDASH_REPORT, failing the items named in fail.txt
const itemsCmd = node(`
  const fs = require("fs");
  const fail = fs.existsSync("fail.txt") ? fs.readFileSync("fail.txt", "utf8").split(",") : [];
  const items = process.argv.slice(1);
  fs.appendFileSync("calls", JSON.stringify(items) + "\\n");
  for (const i of items) if (i !== "silent") fs.appendFileSync(process.env.FDASH_REPORT, JSON.stringify({ item: i, ok: !fail.includes(i) }) + "\\n");
  process.exit(fail.length && fail.some((f) => items.includes(f)) ? 1 : 0);
`);
const calls = (root: string) => fs.readFileSync(path.join(root, "calls"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("items are cached one by one; the command runs with those that have not passed", async () => {
  const root = repo({ "s/x": "1", "s/y": "1", "s/z": "1", ".gitignore": ".fdash/\ncalls\nfail.txt\n" });
  const tasks = { e: { run: [itemsCmd], args: true, inputs: [], items: { x: { inputs: ["s/x"] }, y: { inputs: ["s/y"] }, z: { inputs: ["s/z"] } } } };
  write(root, "fail.txt", "y");
  assert.deepEqual(lines((await go(root, tasks)).results), ["PASS e:x", "FAIL e:y", "PASS e:z"]);
  fs.rmSync(path.join(root, "fail.txt"));
  assert.deepEqual(lines((await go(root, tasks)).results), ["CACHED e:x", "PASS e:y", "CACHED e:z"]);
  assert.deepEqual(lines((await go(root, tasks)).results), ["CACHED e:x", "CACHED e:y", "CACHED e:z"]);
  assert.deepEqual(calls(root), [["x", "y", "z"], ["y"]], "not run when every item is cached");
  write(root, "s/z", "2");
  assert.deepEqual(lines((await go(root, tasks)).results), ["CACHED e:x", "CACHED e:y", "PASS e:z"]);
  assert.deepEqual(lines((await go(root, tasks, { extraArgs: ["x"] })).results), ["CACHED e:x"], "extra arguments pick items");
  assert.deepEqual(lines((await go(root, tasks, { extraArgs: ["nope"] })).results), ["PASS e"], "an argument that is no item: uncached");
  assert.deepEqual(calls(root).at(-1), ["nope"]);
});

test("an item missing from the report takes the command's exit status", async () => {
  const root = repo({ ".gitignore": ".fdash/\ncalls\nfail.txt\n" });
  const tasks = { e: { run: [itemsCmd], args: true, inputs: [], items: { silent: {}, x: {} } } };
  write(root, "fail.txt", "x");
  assert.deepEqual(lines((await go(root, tasks)).results), ["FAIL e:silent", "FAIL e:x"]);
  fs.rmSync(path.join(root, "fail.txt"));
  assert.deepEqual(lines((await go(root, tasks)).results), ["PASS e:silent", "PASS e:x"]);
});

test("a record found is touched, so a cache can keep only what a run used", async () => {
  const root = repo({ "a.txt": "1", "b.txt": "1", ".gitignore": ".fdash/\ncount-*\n" });
  const tasks = { all: { tasks: ["a", "b"] }, a: counting("a", { inputs: ["a.txt"] }), b: counting("b", { inputs: ["b.txt"] }) };
  await go(root, tasks);
  const dir = path.join(root, ".fdash", "cache");
  const old = new Date(Date.now() - 3600_000);
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), old, old);
  const start = Date.now() - 1000;
  write(root, "b.txt", "2");
  await go(root, tasks); // a is found (touched), b reruns (a new record); b's old record is left untouched
  const fresh = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).mtimeMs >= start);
  assert.equal(fs.readdirSync(dir).length, 3);
  assert.deepEqual(fresh.map((f) => f.split("-")[0]).sort(), ["a", "b"]);
});

test("an input changed during the run: the pass is not recorded under the key from before", async () => {
  const root = repo({ "a.txt": "before", ".gitignore": ".fdash/\ncount-*\n" });
  // the command changes its own input while it runs (as another person editing the tree would)
  const tasks = { t: { run: [node(`require("fs").appendFileSync("count-t","x");require("fs").writeFileSync("a.txt","during")`)], inputs: ["a.txt"] } };
  assert.deepEqual(lines((await go(root, tasks)).results), ["PASS t"]);
  write(root, "a.txt", "before");
  assert.deepEqual(lines((await go(root, tasks)).results), ["PASS t"], "the content it started from was not what it ended with: no record");
  assert.equal(runs(root, "t"), 2);
});

test("items: an item's input changed during the run is not recorded", async () => {
  const root = repo({ "s/x": "1", "s/y": "1", ".gitignore": ".fdash/\ncalls\nfail.txt\n" });
  const cmd = node(`const fs=require("fs");for (const i of process.argv.slice(1)) fs.appendFileSync(process.env.FDASH_REPORT, JSON.stringify({item:i,ok:true})+"\\n");fs.writeFileSync("s/y","2")`);
  const tasks = { e: { run: [cmd], args: true, inputs: [], items: { x: { inputs: ["s/x"] }, y: { inputs: ["s/y"] } } } };
  assert.deepEqual(lines((await go(root, tasks)).results), ["PASS e:x", "PASS e:y"]);
  write(root, "s/y", "1");
  assert.deepEqual(lines((await go(root, tasks)).results), ["CACHED e:x", "PASS e:y"]);
});

test("an input changed and changed back during the run: no record (same content, but not what it read)", async () => {
  const root = repo({ "a.txt": "before", ".gitignore": ".fdash/\ncount-*\n" });
  const tasks = { t: { run: [node(`const fs=require("fs");fs.appendFileSync("count-t","x");fs.writeFileSync("a.txt","during");setTimeout(()=>fs.writeFileSync("a.txt","before"),50)`)], inputs: ["a.txt"] } };
  assert.deepEqual(lines((await go(root, tasks)).results), ["PASS t"]);
  assert.deepEqual(lines((await go(root, tasks)).results), ["PASS t"]);
});

test("items: a report line {nocache: true} records nothing (a run on a stale build, for one)", async () => {
  const root = repo({ ".gitignore": ".fdash/\ncalls\n" });
  const cmd = node(`const fs=require("fs");fs.appendFileSync("calls","x");for (const i of process.argv.slice(1)) fs.appendFileSync(process.env.FDASH_REPORT, JSON.stringify({item:i,ok:true})+"\\n");fs.appendFileSync(process.env.FDASH_REPORT, JSON.stringify({nocache:true})+"\\n")`);
  const tasks = { e: { run: [cmd], args: true, inputs: [], items: { x: {} } } };
  assert.deepEqual(lines((await go(root, tasks)).results), ["PASS e:x"]);
  assert.deepEqual(lines((await go(root, tasks)).results), ["PASS e:x"]);
});

test("items: inputs that cannot be resolved after the run give results, not a crash, and record nothing", async () => {
  const root = repo({ "s/x": "1", ".gitignore": ".fdash/\n" });
  // the command leaves the folder without its repository: git ls-files fails once it is done
  const cmd = node(`const fs=require("fs");for (const i of process.argv.slice(1)) fs.appendFileSync(process.env.FDASH_REPORT, JSON.stringify({item:i,ok:true})+"\\n");fs.renameSync(".git",".git-off")`);
  const tasks = { e: { run: [cmd], args: true, inputs: ["s/**"], items: { x: { inputs: ["s/x"] } } } };
  assert.deepEqual(lines((await go(root, tasks)).results), ["PASS e:x"]);
  fs.renameSync(path.join(root, ".git-off"), path.join(root, ".git"));
  assert.deepEqual(lines((await go(root, tasks)).results), ["PASS e:x"], "not recorded");
});

// a command that writes out/a.txt (and out/sub/b.txt) with what <root>/src.txt holds, counting its runs
const producing = (extra: object = {}) => ({
  ...counting("build"),
  run: [node(`const fs=require("fs");fs.appendFileSync("count-build","x");fs.mkdirSync("out/sub",{recursive:true});const s=fs.readFileSync("src.txt","utf8");fs.writeFileSync("out/a.txt","a"+s);fs.writeFileSync("out/sub/b.txt","b"+s)`)],
  inputs: ["src.txt"], outputs: ["out/**"], ...extra,
});
const read = (root: string, f: string) => fs.readFileSync(path.join(root, f), "utf8");

test("outputs: stored with a pass, restored on a hit (a fresh folder, or over a stale file)", async () => {
  // out/ is ignored by git, as a build's output is: the outputs are read from the disk, not from git
  const root = repo({ "src.txt": "1", ".gitignore": ".fdash/\ncount-*\nout/\n" });
  const tasks = { build: producing() };
  assert.deepEqual(lines((await go(root, tasks)).results), ["PASS build"]);
  assert.equal(read(root, "out/a.txt"), "a1");
  fs.rmSync(path.join(root, "out"), { recursive: true });
  assert.deepEqual(lines((await go(root, tasks)).results), ["CACHED build"]);
  assert.deepEqual([read(root, "out/a.txt"), read(root, "out/sub/b.txt"), runs(root, "build")], ["a1", "b1", 1]);
  write(root, "out/a.txt", "stale");
  assert.deepEqual(lines((await go(root, tasks)).results), ["CACHED build"]);
  assert.equal(read(root, "out/a.txt"), "a1", "a hit overwrites what is on disk");
  // another key, another set of outputs; going back restores the first one's
  write(root, "src.txt", "2");
  assert.deepEqual(lines((await go(root, tasks)).results), ["PASS build"]);
  assert.equal(read(root, "out/a.txt"), "a2");
  write(root, "src.txt", "1");
  assert.deepEqual(lines((await go(root, tasks)).results), ["CACHED build"]);
  assert.deepEqual([read(root, "out/a.txt"), runs(root, "build")], ["a1", 2]);
});

test("outputs: a record whose outputs are not in the cache is a miss, with a warning", async () => {
  const root = repo({ "src.txt": "1", ".gitignore": ".fdash/\ncount-*\nout/\n" });
  const tasks = { build: producing() };
  await go(root, tasks);
  const cacheDir = path.join(root, ".fdash", "cache");
  const stored = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".out"));
  assert.equal(stored.length, 1, fs.readdirSync(cacheDir).join(", "));
  // as a record made before outputs existed: the record is there, the outputs are not
  fs.rmSync(path.join(cacheDir, stored[0]), { recursive: true });
  fs.rmSync(path.join(root, "out"), { recursive: true });
  const r = (await go(root, tasks)).results;
  assert.deepEqual(lines(r), ["PASS build"]);
  assert.equal(r[0].warn, "outputs not in the cache");
  assert.deepEqual([read(root, "out/a.txt"), runs(root, "build")], ["a1", 2]);
  const printed: string[] = [];
  const log = console.log;
  console.log = (s: string) => printed.push(s);
  try {
    printResult(r[0]);
  } finally {
    console.log = log;
  }
  assert.deepEqual(printed, ["WARN cache miss build: outputs not in the cache", "PASS build"]);
  // and the run stored them again
  assert.deepEqual(lines((await go(root, tasks)).results), ["CACHED build"]);
  assert.equal((await go(root, tasks)).results[0].warn, undefined);
});

test("outputs: a hit touches the stored copies (a cache pruned of what a run did not use keeps them); one pruned is a miss", async () => {
  const root = repo({ "src.txt": "1", ".gitignore": ".fdash/\ncount-*\nout/\n" });
  const tasks = { build: producing() };
  await go(root, tasks);
  const cacheDir = path.join(root, ".fdash", "cache");
  const out = path.join(cacheDir, fs.readdirSync(cacheDir).find((f) => f.endsWith(".out"))!);
  const old = new Date(Date.now() - 3600_000);
  for (const f of ["out/a.txt", "out/sub/b.txt"]) fs.utimesSync(path.join(out, f), old, old);
  fs.utimesSync(out + ".json", old, old);
  const start = Date.now() - 1000;
  assert.deepEqual(lines((await go(root, tasks)).results), ["CACHED build"]);
  for (const f of [path.join(out, "out/a.txt"), path.join(out, "out/sub/b.txt"), out + ".json"]) assert.ok(fs.statSync(f).mtimeMs >= start, f);
  // what CI's pruning would leave of a store no run touched: the list, not all the files
  fs.rmSync(path.join(out, "out/sub/b.txt"));
  const r = (await go(root, tasks)).results;
  assert.deepEqual([lines(r), r[0].warn, runs(root, "build")], [["PASS build"], "outputs not in the cache", 2]);
});

test("outputs: part of the key; a command without them keeps its key; resolved from the disk, ignored files included", () => {
  const root = repo({ "src.txt": "1", ".gitignore": "out/\n" });
  const key = (outputs?: string[]) => {
    const c = parseConfig(JSON.stringify({ tasks: { t: { run: [["x"]], inputs: ["src.txt"], ...(outputs ? { outputs } : {}) } } })).get("t") as Parameters<typeof cacheKey>[1];
    return cacheKey(root, c, [], ["src.txt"], {});
  };
  assert.notEqual(key(["out/**"]), key(["dist/**"]));
  assert.notEqual(key(["out/**"]), key());
  assert.equal(key([]), key());
  write(root, "out/x.txt", "1");
  write(root, "out/deep/y.txt", "1");
  write(root, "out/skip.map", "1");
  write(root, "out/.vite/manifest.json", "1");
  write(root, "bin/app", "1");
  assert.deepEqual(resolveOutputs(root, ["out/**", "!out/*.map"]), ["out/.vite/manifest.json", "out/deep/y.txt", "out/x.txt"]);
  assert.deepEqual(resolveOutputs(root, ["bin/app", "out/*.txt"]), ["bin/app", "out/x.txt"]);
  assert.deepEqual(resolveOutputs(root, ["nothing/**", "bin/none"]), []);
});
