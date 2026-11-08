// A go.mod's local requires: the modules it requires and replaces with a folder. Run: node --test tools/fdash/test/gomod.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localRequires } from "../gomod.ts";

const GOMOD = `module example.com/app // the command

go 1.22

require (
	example.com/lib v0.0.0
	"example.com/quoted" v0.0.0 // indirect
	github.com/x/y v1.2.3
	example.com/other v1.0.0
)

require example.com/single v0.0.0

replace (
	example.com/lib => ../lib
	example.com/quoted v0.0.0 => "../with space"
	github.com/x/y => github.com/fork/y v1.2.4
	example.com/unused => ../unused
)

replace example.com/single => ./single // a folder inside the module's
replace example.com/other v1.0.0 => ..\\other
`;

test("the requires a replace points at a folder: block and single forms, quotes, comments, versions on the left", () => {
  assert.deepEqual(localRequires(GOMOD), [
    { module: "example.com/lib", dir: "../lib" },
    { module: "example.com/quoted", dir: "../with space" },
    { module: "example.com/single", dir: "./single" },
    { module: "example.com/other", dir: "..\\other" },
  ]);
  // a replace by another module version, or of a module not required, is no local dependency
  assert.deepEqual(localRequires("module a\n\nrequire b v1.0.0\n\nreplace b => c v1.0.0\nreplace d => ../d\n"), []);
  assert.deepEqual(localRequires("module a\n"), []);
});

test("it agrees with go mod edit -json", { skip: spawnSync("go", ["version"]).status !== 0 && "go is not installed" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdash-gomod-"));
  // (a backslash is a folder separator for Go on Windows only)
  const portable = GOMOD.replace("..\\other", "../other");
  fs.writeFileSync(path.join(dir, "go.mod"), portable);
  type Edit = { Require: { Path: string }[]; Replace: { Old: { Path: string }; New: { Path: string; Version?: string } }[] };
  const json = JSON.parse(execFileSync("go", ["mod", "edit", "-json"], { cwd: dir, encoding: "utf8" })) as Edit;
  const required = new Set(json.Require.map((r) => r.Path));
  const go = json.Replace.filter((r) => !r.New.Version && required.has(r.Old.Path)).map((r) => ({ module: r.Old.Path, dir: r.New.Path }));
  assert.deepEqual(localRequires(portable), go);
});
