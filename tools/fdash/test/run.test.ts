// fdash running commands and groups. Run: node --test tools/fdash/test/run.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../config.ts";
import { run, runCommand, spawnSpec } from "../run.ts";

const NODE = process.execPath;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fdash-test-"));
const node = (code: string, ...rest: string[]) => [NODE, "-e", code, ...rest];
const cfg = (tasks: unknown) => parseConfig(JSON.stringify({ tasks }));

// a command that records when it started and ended in <root>/times/<name>, after `ms` of work
const timed = (name: string, ms = 300, exit = 0) => ({
  run: [node(`const fs=require("fs");fs.mkdirSync("times",{recursive:true});const s=Date.now();setTimeout(()=>{fs.writeFileSync("times/${name}",s+" "+Date.now());process.exit(${exit})},${ms})`)],
});
function spans(root: string) {
  return Object.fromEntries(fs.readdirSync(path.join(root, "times")).map((f) => [f, fs.readFileSync(path.join(root, "times", f), "utf8").split(" ").map(Number)]));
}
function maxOverlap(s: Record<string, number[]>) {
  const ev = Object.values(s).flatMap(([a, b]) => [[a, 1], [b, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, max = 0;
  for (const [, d] of ev) max = Math.max(max, (cur += d));
  return max;
}

test("runCommand: pass, non-zero exit, missing command, output under failOnOutput, no second step after a failure", async () => {
  const root = tmp();
  const c = (t: object) => cfg({ t }).get("t") as Parameters<typeof runCommand>[0];
  const log = (n: string) => path.join(root, n + ".log");
  assert.equal(await runCommand(c({ run: [node("console.log('hi')")] }), { root, log: log("pass") }), true);
  assert.match(fs.readFileSync(log("pass"), "utf8"), /hi/);
  assert.equal(await runCommand(c({ run: [node("process.exit(3)")] }), { root, log: log("exit") }), false);
  assert.equal(await runCommand(c({ run: [["fdash-no-such-command"]] }), { root, log: log("missing") }), false);
  assert.match(fs.readFileSync(log("missing"), "utf8"), /ENOENT/);
  assert.equal(await runCommand(c({ run: [node("console.log('x')")], failOnOutput: true }), { root, log: log("out") }), false);
  assert.equal(await runCommand(c({ run: [node("console.error('only stderr')")], failOnOutput: true }), { root, log: log("err") }), true);
  assert.equal(await runCommand(c({ run: [node("process.exit(1)"), node("require('fs').writeFileSync('second','')")] }), { root, log: log("two") }), false);
  assert.equal(fs.existsSync(path.join(root, "second")), false);
});

test("run: a group runs at most its jobs at once, the global value when it has none", async () => {
  for (const [jobs, global, lo, hi] of [[2, 8, 2, 2], [1, 8, 1, 1], [undefined, 3, 2, 3]] as const) {
    const root = tmp();
    const config = cfg({ g: jobs ? { tasks: ["a", "b", "c", "d"], jobs } : { tasks: ["a", "b", "c", "d"] }, a: timed("a"), b: timed("b"), c: timed("c"), d: timed("d") });
    const r = await run({ root, config, names: ["g"], jobs: global });
    assert.deepEqual(r.results.map((x) => [x.name, x.ok]), [["a", true], ["b", true], ["c", true], ["d", true]]);
    const m = maxOverlap(spans(root));
    assert.ok(m >= lo && m <= hi, `jobs ${jobs} global ${global}: overlap ${m}`);
  }
});

test("run: default { jobs: 1, tasks: [static, e2e] } starts e2e after every static command ended", async () => {
  const root = tmp();
  const config = cfg({ default: { jobs: 1, tasks: ["static", "e2e"] }, static: { tasks: ["a", "b", "c"] }, a: timed("a", 200), b: timed("b", 400), c: timed("c", 100), e2e: timed("e2e", 50) });
  const seen: string[] = [];
  const r = await run({ root, config, names: ["default"], jobs: 4, onResult: (x) => seen.push(x.name) });
  assert.deepEqual(r.results.map((x) => x.name), ["a", "b", "c", "e2e"]);
  assert.equal(seen.at(-1), "e2e");
  const s = spans(root);
  assert.ok(s.e2e[0] >= Math.max(s.a[1], s.b[1], s.c[1]), JSON.stringify(s));
  assert.ok(maxOverlap({ a: s.a, b: s.b, c: s.c }) >= 2, "static gates ran in parallel");
});

test("run: a failing member does not stop its group, and a command in two groups runs once", async () => {
  const root = tmp();
  const config = cfg({
    all: { tasks: ["g1", "g2"] }, g1: { tasks: ["bad", "shared"] }, g2: { tasks: ["shared", "ok"] },
    bad: timed("bad", 10, 1), ok: timed("ok", 10),
    shared: { run: [node("require('fs').appendFileSync('count','x')")] },
  });
  const r = await run({ root, config, names: ["all"], jobs: 4 });
  assert.deepEqual(r.results.map((x) => [x.name, x.ok]), [["bad", false], ["shared", true], ["ok", true]]);
  assert.equal(fs.readFileSync(path.join(root, "count"), "utf8"), "x");
});

test("run: extra arguments reach only the command with args", async () => {
  const root = tmp();
  const show = (n: string) => ({ run: [node(`require('fs').writeFileSync('${n}', JSON.stringify(process.argv.slice(1)))`)] });
  const config = cfg({ g: { tasks: ["a", "b"] }, a: { ...show("a"), args: true }, b: show("b") });
  await run({ root, config, names: ["g"], jobs: 2, extraArgs: ["x", "y"] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "a"), "utf8")), ["x", "y"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "b"), "utf8")), []);
});

test("run: an aborted signal starts nothing more and reports interrupted", async () => {
  const root = tmp();
  const config = cfg({ g: { tasks: ["a", "b", "c"], jobs: 1 }, a: timed("a", 200), b: timed("b", 10), c: timed("c", 10) });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const r = await run({ root, config, names: ["g"], jobs: 1, signal: ac.signal });
  assert.equal(r.interrupted, true);
  assert.deepEqual(r.results.map((x) => x.name), ["a"], "a finished, b and c never started");
  assert.deepEqual(Object.keys(spans(root)), ["a"]);
});

test("spawnSpec: a shell only for a .cmd or .bat found on PATH on Windows", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "t.cmd"), "@echo t");
  fs.writeFileSync(path.join(dir, "u.exe"), "");
  const ext = ".COM;.EXE;.BAT;.CMD";
  assert.equal(spawnSpec("t", "win32", dir, ext).shell, true);
  assert.equal(spawnSpec("u", "win32", dir, ext).shell, false);
  assert.equal(spawnSpec("t", "linux", dir, ext).shell, false);
  assert.equal(spawnSpec("missing", "win32", dir, ext).shell, false);
});

test("a .cmd gets an argument with a space as one argument", { skip: process.platform !== "win32" }, async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "echo1.cmd"), "@echo [%~1]\r\n");
  const old = process.env.PATH;
  process.env.PATH = dir + path.delimiter + old;
  try {
    const c = cfg({ t: { run: [["echo1", "a b"]] } }).get("t") as Parameters<typeof runCommand>[0];
    const log = path.join(dir, "log");
    assert.equal(await runCommand(c, { root: dir, log }), true);
    assert.match(fs.readFileSync(log, "utf8"), /\[a b\]/);
  } finally {
    process.env.PATH = old;
  }
});

test("a % in an argument of a .cmd is refused (cmd.exe would expand it), the task fails with why", { skip: process.platform !== "win32" }, async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "echo1.cmd"), "@echo [%~1]\r\n");
  const old = process.env.PATH;
  process.env.PATH = dir + path.delimiter + old;
  try {
    const c = cfg({ t: { run: [["echo1", "e%PATH%f"]] } }).get("t") as Parameters<typeof runCommand>[0];
    const log = path.join(dir, "log");
    assert.equal(await runCommand(c, { root: dir, log }), false);
    assert.match(fs.readFileSync(log, "utf8"), /cmd\.exe, which would expand the %/);
  } finally {
    process.env.PATH = old;
  }
});
