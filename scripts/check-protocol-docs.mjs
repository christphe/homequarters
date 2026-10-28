// docs/protocol.md lists every WebSocket message, both ways (AGENTS.md: protocol changes update
// protocol.ts, docs/protocol.md and the world tests together):
// - client to server: the cases of the dispatch switch in server/internal/httpapi/ws.go;
// - server to client: the `t: "..."` message types in web/src/net/protocol.ts.
// Run: node scripts/check-protocol-docs.mjs [protocol.md ws.go protocol.ts]  (part of scripts/gauntlet.sh and CI)
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const [docPath, goPath, tsPath] = process.argv.length > 4 ? process.argv.slice(2, 5) : ["docs/protocol.md", "server/internal/httpapi/ws.go", "web/src/net/protocol.ts"].map((p) => path.join(root, p));
const doc = fs.readFileSync(docPath, "utf8");
const go = fs.readFileSync(goPath, "utf8");
const ts = fs.readFileSync(tsPath, "utf8");

// the rows of one "## ..." section's table: | `name` | fields | meaning |
const section = (title) => {
  const start = doc.indexOf("\n## " + title + "\n");
  if (start < 0) throw new Error(`docs/protocol.md has no "## ${title}" section`);
  const end = doc.indexOf("\n## ", start + 1);
  return new Set([...doc.slice(start, end < 0 ? undefined : end).matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]));
};
// ws.go switches on m.T twice: first to pick a rate limit, then to dispatch; the second lists every message
const switches = [...go.matchAll(/^(\t+)switch m\.T \{\n([\s\S]*?)^\1\}/gm)];
if (switches.length < 2) throw new Error("ws.go: the dispatch switch on m.T was not found");
const names = (list) => [...list.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
// only the cases at the switch's own indentation: a switch nested in a case has cases of its own
const [, indent, body] = switches[switches.length - 1];
const fromClient = new Set([...body.matchAll(new RegExp(`^${indent}case ((?:"[^"]+"(?:, )?)+):`, "gm"))].flatMap((m) => names(m[1])));
// t: "hello", or a union t: "a" | "b"
const fromServer = new Set([...ts.matchAll(/\bt: ("[^"]+"(?: \| "[^"]+")*)/g)].flatMap((m) => names(m[1])));

let bad = 0;
const compare = (what, code, documented, where) => {
  for (const t of code) if (!documented.has(t)) { console.log(`${what}: \`${t}\` is in ${where} but not in docs/protocol.md`); bad++; }
  for (const t of documented) if (!code.has(t)) { console.log(`${what}: \`${t}\` is in docs/protocol.md but not in ${where}`); bad++; }
};
compare("client to server", fromClient, section("Client to server"), "ws.go's dispatch");
compare("server to client", fromServer, section("Server to client"), "web/src/net/protocol.ts");
console.log(bad ? `${bad} difference(s)` : `protocol docs list all ${fromClient.size} client and ${fromServer.size} server messages`);
process.exit(bad ? 1 : 0);
