// Tests of scripts/check-protocol-docs.mjs on small fixtures. Run: node --test scripts/check-protocol-docs.test.mjs  (part of the web-unit gate)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.join(import.meta.dirname, "check-protocol-docs.mjs");
const DOC = "# Protocol\n\n## Client to server\n\n| Message | Fields | Meaning |\n| --- | --- | --- |\n| `in` | x | move |\n| `media-drop` | n | drop |\n| `ping` | c | probe |\n\n## Server to client\n\n| Message | Fields | Meaning |\n| --- | --- | --- |\n| `hello` | m | state |\n| `pong` | c | answer |\n| `ack` | s | ack |\n\n## Limits\n\n| `x` | not a message |\n";
const GO = 'package httpapi\n\nfunc f() {\n\t\tswitch m.T {\n\t\tcase "in":\n\t\t\trl = inputRL\n\t\t}\n\t\tswitch m.T {\n\t\tcase "in":\n\t\t\tmove()\n\t\tcase "media-drop", "ping":\n\t\t\tother()\n\t\t}\n}\n';
const TS = 'export interface Hello { t: "hello" }\nexport interface Pong { t: "pong"; c: number }\nexport interface Ack { t: "ack" | "pong" }\n';

function run({ doc = DOC, go = GO, ts = TS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-protocol-docs-"));
  const files = [["protocol.md", doc], ["ws.go", go], ["protocol.ts", ts]].map(([name, text]) => {
    fs.writeFileSync(path.join(dir, name), text);
    return path.join(dir, name);
  });
  const r = spawnSync(process.execPath, [script, ...files], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: r.stdout + r.stderr };
}

test("matching lists pass, with a multi-value case, a name with a dash and a union type", () => {
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /all 3 client and 3 server messages/);
});

test("a dispatched message missing from the docs fails", () => {
  const r = run({ go: GO.replace('case "media-drop", "ping":', 'case "media-drop", "ping", "pl_g":') });
  assert.equal(r.code, 1);
  assert.match(r.out, /`pl_g` is in ws.go's dispatch but not in docs/);
});

test("a documented message nobody dispatches or types fails", () => {
  assert.match(run({ doc: DOC.replace("| `ping` | c | probe |", "| `ping` | c | probe |\n| `gone` | - | removed |") }).out, /`gone` is in docs\/protocol.md but not in ws.go/);
  assert.match(run({ ts: TS.replace('t: "ack" | "pong"', 't: "ack"').replace('t: "pong"; c', 't: "png"; c') }).out, /`pong` is in docs\/protocol.md but not in web\/src\/net\/protocol.ts/);
});

test("a switch nested in a case does not add its cases", () => {
  const r = run({ go: GO.replace("\t\t\tother()\n", '\t\t\tswitch m.V {\n\t\t\tcase "inner":\n\t\t\t}\n') });
  assert.equal(r.code, 0, r.out);
});

test("only the second switch counts, and a missing section or switch is an error, not a pass", () => {
  assert.equal(run({ go: GO.replace('\t\tcase "in":\n\t\t\tmove()\n', "") }).code, 1);
  assert.notEqual(run({ doc: DOC.replace("## Server to client", "## Server messages") }).code, 0);
  assert.notEqual(run({ go: 'package httpapi\n\nfunc f() {\n\t\tswitch m.T {\n\t\tcase "in":\n\t\t}\n}\n' }).code, 0);
});
