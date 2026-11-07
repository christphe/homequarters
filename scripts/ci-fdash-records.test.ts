// Which run of main CI takes fdash's records from (scripts/ci-fdash-records.ts). Run: node --test scripts/ci-fdash-records.test.ts  (the scripts:test gate)
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRuns } from "./ci-fdash-records.ts";

const run = (id, sha, branch = "main", event = "push") => ({ databaseId: id, headSha: sha, headBranch: branch, event });

test("only push runs of main whose commit is on main, newest first", () => {
  const onMain = new Set(["a", "b"]);
  const runs = [run(5, "x"), run(4, "a"), run(3, "b", "feature"), run(2, "b", "main", "pull_request"), run(1, "b")];
  assert.deepEqual(pickRuns(runs, (sha) => onMain.has(sha)), [4, 1]);
});

test("a pushed tag named main (its run's headBranch is main) is refused: its commit is not on main", () => {
  const runs = [run(9, "forged"), run(8, "a")];
  assert.deepEqual(pickRuns(runs, (sha) => sha === "a"), [8]);
});

test("nothing to pick: an empty list", () => {
  assert.deepEqual(pickRuns([], () => true), []);
});
