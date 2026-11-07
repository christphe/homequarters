// fdash's command line, and its isolation from the repository that hosts it. Run: node --test tools/fdash/test/cli.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, resultLine, tail, listLines } from "../cli.ts";
import { parseConfig } from "../config.ts";

const here = import.meta.dirname;
const cli = path.join(here, "..", "cli.ts");

test("parseArgs: default task, flags, jobs from the CPUs or FDASH_JOBS, refusals", () => {
  assert.deepEqual(parseArgs(["run"], {}, 12), { cmd: "run", tasks: ["default"], skip: [], jobs: 6, force: false, extra: [] });
  assert.equal(parseArgs(["run"], {}, 1).jobs, 1);
  assert.deepEqual(parseArgs(["run", "a", "--skip", "b", "--jobs", "3", "--force", "--", "x", "--y"], {}, 8), { cmd: "run", tasks: ["a"], skip: ["b"], jobs: 3, force: true, extra: ["x", "--y"] });
  assert.equal(parseArgs(["run", "--jobs=4"], { FDASH_JOBS: "2" }, 8).jobs, 4);
  assert.equal(parseArgs(["run"], { FDASH_JOBS: "2" }, 8).jobs, 2);
  assert.equal(parseArgs(["list"], {}, 8).cmd, "list");
  assert.equal(parseArgs(["--help"], {}, 8).cmd, "help");
  for (const bad of ["0", "-1", "abc", "1.5", ""]) assert.throws(() => parseArgs(["run"], { FDASH_JOBS: bad }, 8), /FDASH_JOBS/);
  assert.throws(() => parseArgs(["run", "--jobs"], {}, 8), /--jobs/);
  assert.throws(() => parseArgs(["run", "--jobs", "0"], {}, 8), /--jobs/);
  assert.throws(() => parseArgs(["build"], {}, 8), /build/);
  assert.throws(() => parseArgs([], {}, 8), /usage/i);
  assert.throws(() => parseArgs(["run", "--nope"], {}, 8), /--nope/);
});

test("resultLine, tail and listLines", () => {
  assert.equal(resultLine({ name: "tsc", ok: true, cached: false, log: "/l", ms: 1 }), "PASS tsc");
  assert.equal(resultLine({ name: "tsc", ok: false, cached: false, log: "/l/tsc.log", ms: 1 }), "FAIL tsc (log: /l/tsc.log)");
  assert.equal(resultLine({ name: "tsc", ok: true, cached: true, log: "", ms: 0 }), "CACHED tsc");
  assert.equal(tail("a\nb\nc\n", 2), "     b\n     c");
  assert.equal(tail("a\r\nb", 15), "     a\n     b");
  const c = parseConfig(JSON.stringify({ tasks: { default: { tasks: ["ok", "bad"], jobs: 1 }, s: { tasks: ["ok"] }, ok: { run: [["x"]] }, bad: { run: [["y"]] } } }));
  assert.deepEqual(listLines(c), ["default: ok, bad (jobs 1)", "s: ok", "ok", "bad"]);
});

test("the command line end to end", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fdash-cli-"));
  const node = process.execPath;
  fs.writeFileSync(path.join(root, "fdash.json"), JSON.stringify({ tasks: {
    default: { tasks: ["ok", "bad"] },
    ok: { run: [[node, "-e", "console.log('fine')"]] },
    bad: { run: [[node, "-e", "console.log('first');console.log('last words');process.exit(1)"]] },
  } }));
  fs.mkdirSync(path.join(root, "sub"));
  const r = spawnSync(node, [cli, "run"], { cwd: path.join(root, "sub"), encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS ok$/m);
  assert.match(r.stdout, /^FAIL bad \(log: .+bad\.log\)$/m);
  assert.match(r.stdout, /^ {5}last words$/m);
  const nope = spawnSync(node, [cli, "run", "nope"], { cwd: root, encoding: "utf8" });
  assert.equal(nope.status, 2);
  assert.match(nope.stderr, /no task named nope \(fdash list/);
  const help = spawnSync(node, [cli, "--help"], { cwd: root, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: fdash run/);
  const list = spawnSync(node, [cli, "list"], { cwd: root, encoding: "utf8" });
  assert.deepEqual(list.stdout.trim().split(/\r?\n/), ["default: ok, bad", "ok", "bad"]);
  const none = spawnSync(node, [cli, "list"], { cwd: os.tmpdir(), encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /fdash\.json/);
});

test("fdash imports only node: modules and its own files, and names nothing of the repository hosting it", () => {
  const self = path.resolve(import.meta.filename);
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|md)$/.test(e.name) && files.push(path.join(d, e.name)); };
  const top = path.resolve(here, "..");
  walk(top);
  // the words are built so that this file does not hold them
  const forbidden = [["home", "quarters"], ["Home", " Quarters"], ["gaunt", "let"], ["server", "/"], ["web", "/"], ["e2", "e/"], ["plugins", "/"]].map((p) => p.join(""));
  for (const f of files) {
    if (path.resolve(f) === self) continue;
    const text = fs.readFileSync(f, "utf8");
    for (const w of forbidden) assert.ok(!text.includes(w), `${path.relative(top, f)} names "${w}"`);
    if (!f.endsWith(".ts")) continue;
    for (const m of text.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (spec.startsWith("node:")) continue;
      assert.ok(spec.startsWith("."), `${path.relative(top, f)} imports ${spec}`);
      const target = path.resolve(path.dirname(f), spec);
      assert.ok(target.startsWith(top + path.sep), `${path.relative(top, f)} imports ${spec}, outside fdash`);
    }
  }
});

test("a command missing from PATH fails its task without crashing the run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fdash-cli-"));
  fs.writeFileSync(path.join(root, "fdash.json"), JSON.stringify({ tasks: {
    default: { tasks: ["missing", "ok"] },
    missing: { run: [["fdash-no-such-command-xyz"]] },
    ok: { run: [[process.execPath, "-e", "setTimeout(() => {}, 300)"]] },
  } }));
  const r = spawnSync(process.execPath, [cli, "run"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^FAIL missing /m);
  assert.match(r.stdout, /^PASS ok$/m);
  assert.doesNotMatch(r.stderr, /EBADF|Error/, r.stderr);
});
