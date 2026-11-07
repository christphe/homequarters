// fdash's config: commands, groups, inputs and items, and every refusal. Run: node --test tools/fdash/test/config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, expand, type Command, type Group } from "../config.ts";

const cfg = (tasks: unknown) => JSON.stringify({ tasks });

test("parseConfig: defaults and order", () => {
  const c = parseConfig(cfg({
    b: { run: [["x"]] },
    g: { tasks: ["b", "a"], jobs: 2 },
    h: { tasks: ["b"] },
    a: { cwd: "w", run: [["y", "1"], ["z"]], env: { K: "v" }, failOnOutput: true, args: true },
  }));
  assert.deepEqual([...c.keys()], ["b", "g", "h", "a"]);
  assert.deepEqual(c.get("b"), { kind: "command", name: "b", cwd: ".", run: [["x"]], env: {}, failOnOutput: false, args: false, cache: true, inputs: undefined, envKeys: [], tools: [], items: undefined });
  assert.deepEqual(c.get("g"), { kind: "group", name: "g", tasks: ["b", "a"], jobs: 2 });
  assert.equal((c.get("h") as Group).jobs, undefined);
  const a = c.get("a") as Command;
  assert.deepEqual([a.cwd, a.run, a.env, a.failOnOutput, a.args], ["w", [["y", "1"], ["z"]], { K: "v" }, true, true]);
});

test("parseConfig: inputs, envKeys, tools and items", () => {
  const c = parseConfig(cfg({
    e: {
      run: [["node", "run.mjs"]], args: true,
      inputs: ["src/**", "!src/dist/**", { go: "./cmd/x", cwd: "server" }, { go: "./...", cwd: "server", tests: true }],
      envKeys: ["V"], tools: [["go", "version"]],
      items: { one: { inputs: ["s/one.mjs"] }, two: {} },
    },
  }));
  const e = c.get("e") as Command;
  assert.deepEqual(e.inputs, ["src/**", "!src/dist/**", { go: "./cmd/x", cwd: "server", tests: false }, { go: "./...", cwd: "server", tests: true }]);
  assert.deepEqual(e.envKeys, ["V"]);
  assert.deepEqual(e.tools, [["go", "version"]]);
  assert.deepEqual([...e.items!.entries()], [["one", { inputs: ["s/one.mjs"] }], ["two", { inputs: [] }]]);
});

test("parseConfig: every refusal names the task", () => {
  const bad: [unknown, RegExp][] = [
    [{ t: {} }, /t: .*run.*tasks/],
    [{ t: { run: [["x"]], tasks: [] } }, /t: .*both/],
    [{ t: { run: [] } }, /t: run/],
    [{ t: { run: [[]] } }, /t: run/],
    [{ t: { run: [["x", 1]] } }, /t: run/],
    [{ t: { run: [["x"]], cwd: 1 } }, /t: cwd/],
    [{ t: { run: [["x"]], env: { K: 1 } } }, /t: env/],
    [{ t: { run: [["x"]], failOnOutput: "yes" } }, /t: failOnOutput/],
    [{ t: { run: [["x"]], foo: 1 } }, /t: unknown key foo/],
    [{ t: { tasks: ["nope"] } }, /t: .*nope/],
    [{ t: { tasks: [] , jobs: 0 } }, /t: jobs/],
    [{ t: { tasks: [], jobs: -1 } }, /t: jobs/],
    [{ t: { tasks: [], jobs: 1.5 } }, /t: jobs/],
    [{ t: { tasks: [], jobs: "2" } }, /t: jobs/],
    [{ t: { tasks: [], foo: 1 } }, /t: unknown key foo/],
    [{ g1: { tasks: ["g2"] }, g2: { tasks: ["g1"] } }, /cycle.*g1.*g2|cycle.*g2.*g1/],
    [{ t: { run: [["x"]], inputs: [1] } }, /t: inputs/],
    [{ t: { run: [["x"]], inputs: [{ go: "./x" }] } }, /t: inputs/],
    [{ t: { run: [["x"]], inputs: [{ go: "./x", cwd: "s", foo: 1 }] } }, /t: inputs/],
    [{ t: { run: [["x"]], envKeys: [1] } }, /t: envKeys/],
    [{ t: { run: [["x"]], tools: [[]] } }, /t: tools/],
    [{ t: { run: [["x"]], items: { a: { foo: 1 } } } }, /t: items/],
    [{ t: { run: [["x"]], items: [] } }, /t: items/],
  ];
  for (const [tasks, re] of bad) assert.throws(() => parseConfig(cfg(tasks)), re, JSON.stringify(tasks));
  assert.throws(() => parseConfig("{"), /fdash\.json/);
  assert.throws(() => parseConfig("{}"), /fdash\.json.*tasks/);
});

test("expand: depth first, each command once, skip a command or a group, unknown name refused", () => {
  const c = parseConfig(cfg({
    all: { tasks: ["s", "e"] },
    s: { tasks: ["a", "b", "inner"] },
    inner: { tasks: ["c", "a"] },
    a: { run: [["a"]] }, b: { run: [["b"]] }, c: { run: [["c"]] }, e: { run: [["e"]] },
  }));
  const names = (n: string[], skip: string[] = []) => expand(c, n, skip).map((x) => x.name);
  assert.deepEqual(names(["all"]), ["a", "b", "c", "e"]);
  assert.deepEqual(names(["all"], ["b"]), ["a", "c", "e"]);
  assert.deepEqual(names(["all"], ["inner"]), ["a", "b", "e"]);
  assert.deepEqual(names(["e", "a"]), ["e", "a"]);
  assert.throws(() => names(["nope"]), /nope/);
  assert.throws(() => names(["all"], ["nope"]), /nope/);
});
