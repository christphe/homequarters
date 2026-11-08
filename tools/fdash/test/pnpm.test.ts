// fdash's pnpm input: a member's share of the lockfile in the key, not the whole file. Run: node --test tools/fdash/test/pnpm.test.ts
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../config.ts";
import { cacheKey, resolveInputs, signature } from "../cache.ts";
import { parseYaml } from "../pnpm.ts";
import { run } from "../run.ts";

// a workspace of three members: a uses left-pad (and through it a transitive dep), b uses right-pad, c links
// to a (link:../a) and has no package of its own
const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  a:
    dependencies:
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0
    devDependencies:
      '@scope/tool':
        specifier: 'catalog:'
        version: 2.0.0(peer@1.0.0)

  b:
    dependencies:
      right-pad:
        specifier: ^1.0.1
        version: 1.0.1

  c:
    dependencies:
      a:
        specifier: workspace:*
        version: link:../a

packages:

  '@scope/tool@2.0.0':
    resolution: {integrity: sha512-tool}
    peerDependencies:
      peer: '*'

  left-pad@1.3.0:
    resolution: {integrity: sha512-left}
    engines: {node: '>=14, <30', npm: '*'}

  peer@1.0.0:
    resolution: {integrity: sha512-peer}

  right-pad@1.0.1:
    resolution: {integrity: sha512-right}

  deep@4.0.0:
    resolution: {integrity: sha512-deep}
    cpu: [x64, arm64]

snapshots:

  '@scope/tool@2.0.0(peer@1.0.0)':
    dependencies:
      peer: 1.0.0

  left-pad@1.3.0:
    dependencies:
      deep: 4.0.0
    transitivePeerDependencies:
      - supports-color

  peer@1.0.0: {}

  right-pad@1.0.1: {}

  deep@4.0.0:
    optional: true
`;

const temps: string[] = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
function workspace(lock = LOCK): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fdash-pnpm-"));
  temps.push(root);
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), lock);
  return root;
}
const COMMAND = parseConfig(JSON.stringify({ tasks: { t: { run: [["x"]], inputs: [] } } })).get("t") as Parameters<typeof cacheKey>[1];
const key = (root: string, member: string) => cacheKey(root, COMMAND, [], resolveInputs(root, [{ pnpm: member }]), {});
/** The keys of a, b and c, before and after `edit` is applied to the lockfile. */
function keys(edit: (lock: string) => string, lock = LOCK) {
  const root = workspace(lock);
  const before = ["a", "b", "c"].map((m) => key(root, m));
  const changed = edit(lock);
  assert.notEqual(changed, lock, "the edit changes the lockfile");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), changed);
  const after = ["a", "b", "c"].map((m) => key(root, m));
  return { a: before[0] !== after[0], b: before[1] !== after[1], c: before[2] !== after[2] };
}

test("pnpm input: a package only a uses changes a's key (and c's, which links to a), not b's", () => {
  const bump = (l: string) => l.replace("specifier: ^1.3.0\n        version: 1.3.0", "specifier: ^1.3.1\n        version: 1.3.1")
    .replace("left-pad@1.3.0:\n    resolution: {integrity: sha512-left}", "left-pad@1.3.1:\n    resolution: {integrity: sha512-left2}")
    .replace("left-pad@1.3.0:\n    dependencies", "left-pad@1.3.1:\n    dependencies");
  assert.deepEqual(keys(bump), { a: true, b: false, c: true });
  // the same version with another integrity (a republished tarball) is a change too
  assert.deepEqual(keys((l) => l.replace("sha512-right", "sha512-right2")), { a: false, b: true, c: false });
});

test("pnpm input: a transitive package (reached through snapshots) changes the key", () => {
  assert.deepEqual(keys((l) => l.replace("sha512-deep", "sha512-deep2")), { a: true, b: false, c: true });
  // a peer-suffixed snapshot key, followed to its package
  assert.deepEqual(keys((l) => l.replace("sha512-peer", "sha512-peer2")), { a: true, b: false, c: true });
});

test("pnpm input: an npm: alias of an importer is followed to its package, not a fallback", () => {
  const aliased = LOCK
    .replace("        version: 1.0.1\n\n  c:", "        version: 1.0.1\n      sw:\n        specifier: npm:string-width@4.2.3\n        version: string-width@4.2.3\n\n  c:")
    .replace("\nsnapshots:\n", "\n  string-width@4.2.3:\n    resolution: {integrity: sha512-sw}\n\nsnapshots:\n")
    .replace("  deep@4.0.0:\n    optional: true\n", "  deep@4.0.0:\n    optional: true\n\n  string-width@4.2.3: {}\n");
  const r = resolveInputs(workspace(aliased), [{ pnpm: "b" }]);
  assert.deepEqual([r.files, r.warnings], [[], []]);
  assert.deepEqual(keys((l) => l.replace("sha512-sw", "sha512-sw2"), aliased), { a: false, b: true, c: false });
});

test("pnpm input: a linked workspace member's external dependency changes the dependent's key", () => {
  // c installs nothing itself: only through link:../a
  assert.deepEqual(keys((l) => l.replace("sha512-tool", "sha512-tool2")), { a: true, b: false, c: true });
});

test("pnpm input: settings, overrides, patchedDependencies (and the patch's content) and pnpmfileChecksum change every key", () => {
  const all = { a: true, b: true, c: true };
  assert.deepEqual(keys((l) => l.replace("autoInstallPeers: true", "autoInstallPeers: false")), all, "settings");
  assert.deepEqual(keys((l) => l.replace("\nimporters:", "\noverrides:\n  deep: 4.0.1\n\nimporters:")), all, "overrides");
  assert.deepEqual(keys((l) => l.replace("\nimporters:", "\npnpmfileChecksum: sha256-x\n\nimporters:")), all, "pnpmfileChecksum");
  const patched = LOCK.replace("\nimporters:", "\npatchedDependencies:\n  right-pad@1.0.1:\n    hash: abc\n    path: patches/right-pad.patch\n\nimporters:");
  assert.deepEqual(keys((l) => l.replace("hash: abc", "hash: abd"), patched), all, "patchedDependencies");
  // the patch file itself, the lockfile unchanged
  const root = workspace(patched);
  fs.mkdirSync(path.join(root, "patches"));
  fs.writeFileSync(path.join(root, "patches/right-pad.patch"), "one");
  assert.deepEqual(resolveInputs(root, [{ pnpm: "a" }]).files, ["patches/right-pad.patch"]);
  const k = key(root, "a");
  fs.writeFileSync(path.join(root, "patches/right-pad.patch"), "two");
  assert.notEqual(key(root, "a"), k);
});

test("pnpm input: reordering the lockfile without changing its content keeps every key", () => {
  // entries swapped, keys of an entry swapped, a flow mapping's keys swapped, quoting changed
  const reordered = LOCK
    .replace("  b:\n    dependencies:\n      right-pad:\n        specifier: ^1.0.1\n        version: 1.0.1\n\n", "")
    .replace("  c:\n", "  b:\n    dependencies:\n      right-pad:\n        version: 1.0.1\n        specifier: '^1.0.1'\n\n  c:\n")
    .replace("    resolution: {integrity: sha512-left}\n    engines: {node: '>=14, <30', npm: '*'}", "    engines: {npm: '*', node: \">=14, <30\"}\n    resolution: {integrity: sha512-left}")
    .replace("  deep@4.0.0:\n    optional: true\n", "")
    .replace("snapshots:\n", "snapshots:\n\n  deep@4.0.0:\n    optional: true\n");
  assert.deepEqual(keys(() => reordered), { a: false, b: false, c: false });
});

test("pnpm input: an unknown lockfileVersion hashes the whole file, with a line in the task's log", async () => {
  const lock = LOCK.replace("lockfileVersion: '9.0'", "lockfileVersion: '10.0'");
  const root = workspace(lock);
  const r = resolveInputs(root, [{ pnpm: "a" }]);
  assert.deepEqual([r.files, r.parts], [["pnpm-lock.yaml"], []]);
  assert.match(r.warnings.join("\n"), /lockfileVersion "10\.0", which fdash does not read.*the whole lockfile is hashed/);
  // b's key moves with a change only a sees: the whole file counts
  const k = key(root, "b");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), lock.replace("sha512-left", "sha512-left2"));
  assert.notEqual(key(root, "b"), k);
  // a lockfile fdash cannot parse falls back the same way
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), LOCK + "\n  bad: |\n    a block scalar\n\tx\n");
  assert.deepEqual(resolveInputs(root, [{ pnpm: "a" }]).files, ["pnpm-lock.yaml"]);
  // the log of a run says so
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "fdash-pnpm-log-"));
  temps.push(logDir);
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), lock);
  const config = parseConfig(JSON.stringify({ tasks: { t: { run: [[process.execPath, "-e", ""]], inputs: [{ pnpm: "a" }] } } }));
  const { results } = await run({ root, config, names: ["t"], jobs: 1, logDir, cacheDir: path.join(root, ".cache") });
  assert.equal(results[0].ok, true);
  assert.match(fs.readFileSync(results[0].log, "utf8"), /^fdash: pnpm-lock\.yaml has lockfileVersion "10\.0"/m);
});

test("pnpm input: a member the lockfile does not have is refused, by name", () => {
  const root = workspace();
  assert.throws(() => resolveInputs(root, [{ pnpm: "nope" }]), /pnpm input nope: pnpm-lock\.yaml has no importer "nope".*it has \., a, b, c/);
  assert.throws(() => resolveInputs(root, [{ pnpm: "../x" }]), /outside the root/);
  // the config takes only { "pnpm": <dir> }
  assert.throws(() => parseConfig(JSON.stringify({ tasks: { t: { run: [["x"]], inputs: [{ pnpm: "a", extra: 1 }] } } })), /\{ "pnpm": <member dir> \}/);
});

test("pnpm input: the root member is '.', and the lockfile stays in the signature", () => {
  const root = workspace();
  const r = resolveInputs(root, [{ pnpm: "." }, { pnpm: "a" }]);
  assert.deepEqual([r.files, r.parts.map((p) => [p.file, p.name])], [[], [["pnpm-lock.yaml", "pnpm:."], ["pnpm-lock.yaml", "pnpm:a"]]]);
  const s = signature(root, r);
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), LOCK + "\n");
  assert.notEqual(signature(root, r), s, "a pnpm install during a run is seen");
});

test("pnpm input: the YAML reader takes what pnpm writes and refuses the rest", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parseYaml("a:\n  'b@1(c@2)':\n    x: {k: 'it''s', u: https://h/p.tgz}\n    l:\n      - one\n    e: []\n"))),
    { a: { "b@1(c@2)": { x: { k: "it's", u: "https://h/p.tgz" }, l: ["one"], e: [] } } });
  assert.throws(() => parseYaml("a: |\n  text\n"), /line 2/);
  assert.throws(() => parseYaml("a: {b: c\n"), /line 1/);
});
