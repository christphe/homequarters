// A Go module's local dependencies, read from its go.mod: the modules it requires that a `replace` directive
// points at a folder (`replace example.com/lib => ../lib`). In a repository of several Go modules without a
// go.work, that is how one module uses another, so these folders are the projects it depends on.
import path from "node:path";

/** The directives of a go.mod, one per line, with their verb: `require ( a v1 \n b v2 )` gives two. */
function directives(text: string): { verb: string; args: string[] }[] {
  const out: { verb: string; args: string[] }[] = [];
  let block: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (block !== null) {
      if (line === ")") block = null;
      else out.push({ verb: block, args: words(line) });
      continue;
    }
    const [verb, ...args] = words(line);
    if (args.length === 1 && args[0] === "(") block = verb;
    else out.push({ verb, args });
  }
  return out;
}

/** The words of a line, a quoted one ("a b" or `a b`) counting as one, without its quotes. */
function words(line: string): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|`([^`]*)`|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** A replacement's target is a folder when it starts with ./ or ../ or is absolute (Go's own rule). */
const isFolder = (p: string) => p.startsWith("./") || p.startsWith("../") || p.startsWith(".\\") || p.startsWith("..\\") || path.isAbsolute(p);

/** The modules a go.mod requires and replaces with a folder: their module path and that folder, as written. */
export function localRequires(text: string): { module: string; dir: string }[] {
  const all = directives(text);
  const required = new Set(all.filter((d) => d.verb === "require").map((d) => d.args[0]));
  const out: { module: string; dir: string }[] = [];
  for (const d of all) {
    if (d.verb !== "replace") continue;
    const arrow = d.args.indexOf("=>");
    if (arrow < 1) continue;
    const module = d.args[0];
    const target = d.args[arrow + 1];
    // a replace of a module the go.mod does not require is no dependency of it
    if (target === undefined || !isFolder(target) || !required.has(module)) continue;
    if (!out.some((o) => o.module === module)) out.push({ module, dir: target });
  }
  return out;
}
