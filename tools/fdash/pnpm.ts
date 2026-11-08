// The part of a pnpm lockfile one workspace member installs: what an input { "pnpm": <dir> } puts in a cache
// key instead of the whole pnpm-lock.yaml, so that a package only another member uses changes no key here.
// The lockfile is read by hand (fdash has no dependency): it is machine-written YAML of a known shape, and a
// lockfileVersion this file does not know is not guessed at: the caller hashes the whole file instead.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LOCKFILE = "pnpm-lock.yaml";
/** The lockfile versions whose layout (importers, packages, snapshots) this file reads. */
export const KNOWN_VERSIONS = ["9.0"];

type Yaml = string | Yaml[] | { [k: string]: Yaml };
type YMap = { [k: string]: Yaml };

/** The subset of YAML pnpm writes: block mappings and sequences by indentation, plain and quoted scalars,
 * flow mappings and sequences on one line. Anything else throws, naming the line. */
export function parseYaml(text: string): YMap {
  const lines: { n: number; indent: number; body: string }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (raw.trim() === "") return;
    if (/^\s*\t/.test(raw)) throw new Error(`line ${i + 1}: a tab in the indentation`);
    const body = raw.trim();
    if (body.startsWith("#")) return;
    lines.push({ n: i + 1, indent: raw.length - raw.trimStart().length, body });
  });
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`line ${lines[Math.min(i, lines.length - 1)]?.n ?? 0}: ${msg}`);
  };
  const isItem = (body: string) => body === "-" || body.startsWith("- ");

  function block(indent: number): Yaml {
    return isItem(lines[i].body) ? sequence(indent) : mapping(indent);
  }
  function nested(indent: number): Yaml {
    // the value of a key or item written on the lines below it
    if (i < lines.length && lines[i].indent > indent) return block(lines[i].indent);
    return "";
  }
  function mapping(indent: number): YMap {
    const out: YMap = Object.create(null) as YMap;
    while (i < lines.length && lines[i].indent === indent && !isItem(lines[i].body)) {
      const { key, rest } = splitKey(lines[i].body, fail);
      i++;
      out[key] = rest === "" ? nested(indent) : value(rest, fail);
    }
    if (i < lines.length && lines[i].indent > indent) fail("unexpected indentation");
    return out;
  }
  function sequence(indent: number): Yaml[] {
    const out: Yaml[] = [];
    while (i < lines.length && lines[i].indent === indent && isItem(lines[i].body)) {
      const rest = lines[i].body.slice(1).trim();
      i++;
      if (rest === "") out.push(nested(indent));
      else if (/^[^'"{[][^:]*:( |$)|^'[^']*':( |$)|^"[^"]*":( |$)/.test(rest)) fail("a mapping inside a sequence item (not written by pnpm)");
      else out.push(value(rest, fail));
    }
    if (i < lines.length && lines[i].indent > indent) fail("unexpected indentation");
    return out;
  }
  if (lines.length === 0) return {};
  if (lines[0].indent !== 0) fail("the document must start at column 0");
  const doc = mapping(0);
  if (i < lines.length) fail("unexpected content");
  return doc;
}

function quoted(s: string, at: number, fail: (m: string) => never): { text: string; end: number } {
  const q = s[at];
  if (q === "'") {
    let out = "";
    for (let j = at + 1; j < s.length; j++) {
      if (s[j] !== "'") out += s[j];
      else if (s[j + 1] === "'") { out += "'"; j++; }
      else return { text: out, end: j + 1 };
    }
  } else {
    for (let j = at + 1; j < s.length; j++) {
      if (s[j] === "\\") j++;
      else if (s[j] === '"') {
        try {
          return { text: JSON.parse(s.slice(at, j + 1)) as string, end: j + 1 };
        } catch {
          fail("a double-quoted string fdash cannot read");
        }
      }
    }
  }
  return fail("an unterminated quoted string");
}

function splitKey(body: string, fail: (m: string) => never): { key: string; rest: string } {
  if (body[0] === "'" || body[0] === '"') {
    const { text, end } = quoted(body, 0, fail);
    if (body[end] !== ":" || (body.length > end + 1 && body[end + 1] !== " ")) fail("a quoted key not followed by ':'");
    return { key: text, rest: body.slice(end + 1).trim() };
  }
  const m = /^([^\s'"{[][^:]*?):(?: (.*))?$/.exec(body);
  if (!m) return fail(`not a key: ${body}`);
  return { key: m[1].trim(), rest: (m[2] ?? "").trim() };
}

/** A scalar or a flow collection written whole on its line. */
function value(s: string, fail: (m: string) => never): Yaml {
  let at = 0;
  const ws = () => { while (s[at] === " ") at++; };
  const scalar = (stops: string): string => {
    ws();
    if (s[at] === "'" || s[at] === '"') {
      const { text, end } = quoted(s, at, fail);
      at = end;
      return text;
    }
    const from = at;
    while (at < s.length && !stops.includes(s[at])) at++;
    return s.slice(from, at).trim();
  };
  const any = (stops: string): Yaml => {
    ws();
    if (s[at] === "{") {
      at++;
      const out: YMap = Object.create(null) as YMap;
      ws();
      if (s[at] === "}") { at++; return out; }
      for (;;) {
        const k = scalar(":,}");
        if (s[at] !== ":") fail("a flow mapping entry without ':'");
        at++;
        out[k] = any(",}");
        ws();
        if (s[at] === "}") { at++; return out; }
        if (s[at] !== ",") fail("a flow mapping not closed by '}'");
        at++;
      }
    }
    if (s[at] === "[") {
      at++;
      const out: Yaml[] = [];
      ws();
      if (s[at] === "]") { at++; return out; }
      for (;;) {
        out.push(any(",]"));
        ws();
        if (s[at] === "]") { at++; return out; }
        if (s[at] !== ",") fail("a flow sequence not closed by ']'");
        at++;
      }
    }
    return scalar(stops);
  };
  const v = any("");
  ws();
  if (at !== s.length) fail(`unexpected text after a value: ${s.slice(at)}`);
  return v;
}

/** JSON with the keys of every mapping sorted: the same content always gives the same text. */
export function canonical(v: Yaml | undefined): string {
  if (v === undefined) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

const asMap = (v: Yaml | undefined): YMap => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
// the top-level sections that are the graph itself; every other one (settings, overrides, patchedDependencies,
// pnpmfileChecksum, packageExtensionsChecksum, what a later pnpm adds) changes installs everywhere. The catalogs
// are left out: a catalog entry a member uses shows up as its resolved version.
const GRAPH = new Set(["importers", "packages", "snapshots", "catalogs"]);
const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];

/** What a member installs, from a parsed lockfile: the canonical text of its importer entry, of the importers it
 * links to (followed), of every snapshot and package reached from them, and of the global sections. */
export function importerGraph(lock: YMap, importer: string): string {
  const importers = asMap(lock.importers), snapshots = asMap(lock.snapshots), packages = asMap(lock.packages);
  if (!Object.hasOwn(importers, importer)) throw new Error(`${LOCKFILE} has no importer ${JSON.stringify(importer)} (a member of pnpm-workspace.yaml, installed by pnpm install?); it has ${Object.keys(importers).sort().join(", ")}`);
  const seenImporters = new Set<string>(), seenSnapshots = new Set<string>();
  const entries: string[] = [];
  const snapshot = (key: string) => {
    if (seenSnapshots.has(key)) return;
    seenSnapshots.add(key);
    if (!Object.hasOwn(snapshots, key)) throw new Error(`${LOCKFILE}: ${key} is not in snapshots`);
    const pkg = key.replace(/\(.*$/, "");
    if (!Object.hasOwn(packages, pkg)) throw new Error(`${LOCKFILE}: ${pkg} is not in packages`);
    const snap = asMap(snapshots[key]);
    entries.push("snapshot " + JSON.stringify(key) + " " + canonical(snap), "package " + JSON.stringify(pkg) + " " + canonical(packages[pkg]));
    for (const section of ["dependencies", "optionalDependencies"]) {
      for (const [name, ref] of Object.entries(asMap(snap[section]))) {
        if (typeof ref !== "string" || ref.startsWith("link:")) continue; // a link from a package: its text is in the entry
        // `name@version(peers)`, or an alias whose reference is a whole key (`string-width@4.2.3`)
        snapshot(Object.hasOwn(snapshots, `${name}@${ref}`) ? `${name}@${ref}` : ref);
      }
    }
  };
  const visit = (id: string) => {
    if (seenImporters.has(id)) return;
    seenImporters.add(id);
    const imp = asMap(importers[id]);
    entries.push("importer " + JSON.stringify(id) + " " + canonical(imp));
    for (const section of DEP_SECTIONS) {
      for (const [name, dep] of Object.entries(asMap(imp[section]))) {
        const version = asMap(dep).version;
        if (typeof version !== "string") throw new Error(`${LOCKFILE}: importers.${id}.${section}.${name} has no version`);
        if (version.startsWith("link:")) {
          // a workspace member: its files are fdash's dependsOn, its own installs are followed here
          const target = path.posix.normalize(path.posix.join(id, version.slice("link:".length)));
          if (Object.hasOwn(importers, target)) visit(target);
          continue;
        }
        // `name@version(peers)`, or an npm: alias whose version is a whole key (`string-width@4.2.3`)
        snapshot(Object.hasOwn(snapshots, `${name}@${version}`) ? `${name}@${version}` : version);
      }
    }
  };
  visit(importer);
  const globals = Object.keys(lock).filter((k) => !GRAPH.has(k)).sort().map((k) => "global " + JSON.stringify(k) + " " + canonical(lock[k]));
  return [...globals, ...entries.sort()].join("\n");
}

/** The patch files a lockfile names (patchedDependencies entries with a path), relative to its folder. */
export function patchFiles(lock: YMap): string[] {
  const out: string[] = [];
  for (const v of Object.values(asMap(lock.patchedDependencies))) {
    const p = asMap(v).path;
    if (typeof p === "string" && p !== "") out.push(p);
  }
  return out.sort();
}

export type PnpmPart = {
  /** the lockfile, relative to the root */
  lockfile: string;
  /** "pnpm:<importer>": the name of the part in the key */
  name: string;
  /** the digest of the importer's graph; undefined when the lockfile was not read (then hash it whole) */
  digest?: string;
  /** patch files the lockfile names, relative to the root, hashed whole */
  patches: string[];
  /** why the whole lockfile is hashed instead */
  warning?: string;
};

const parsed = new Map<string, YMap | Error>();
/** The parsed lockfile, once per content per process. */
function parseOnce(id: string, text: string): YMap | Error {
  let v = parsed.get(id);
  if (v === undefined) {
    try {
      v = parseYaml(text);
    } catch (e) {
      v = e as Error;
    }
    if (parsed.size > 8) parsed.clear();
    parsed.set(id, v);
  }
  return v;
}
// a run asks for the same parts before and after each command: each is computed once per lockfile content
const parts = new Map<string, PnpmPart>();

/** The part of the lockfile the member in `dir` (relative to the root) installs. The lockfile is the nearest
 * pnpm-lock.yaml from `dir` up to the root. An importer the lockfile lacks throws; a lockfile fdash cannot
 * read (an unknown lockfileVersion, a shape it does not parse) gives no digest and a warning, and the caller
 * hashes the whole file. */
export function pnpmPart(root: string, dir: string): PnpmPart {
  const rel = path.posix.normalize(dir.split(path.sep).join("/")).replace(/\/$/, "");
  if (rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) throw new Error(`pnpm input ${dir}: outside the root`);
  let lockDir = rel;
  for (;;) {
    if (fs.existsSync(path.join(root, lockDir, LOCKFILE))) break;
    if (lockDir === ".") throw new Error(`pnpm input ${dir}: no ${LOCKFILE} in it or above it`);
    lockDir = path.posix.dirname(lockDir);
  }
  const lockfile = lockDir === "." ? LOCKFILE : `${lockDir}/${LOCKFILE}`;
  const importer = lockDir === "." ? rel : path.posix.relative(lockDir, rel) || ".";
  const name = `pnpm:${importer}`;
  const text = fs.readFileSync(path.join(root, lockfile), "utf8");
  const memo = crypto.createHash("sha1").update(text).digest("hex") + "\0" + importer;
  const known = parts.get(memo);
  if (known && known.lockfile === lockfile) return known;
  const part = partOf(parseOnce(memo.slice(0, 40), text), { dir, lockDir, lockfile, importer, name });
  if (parts.size > 256) parts.clear();
  parts.set(memo, part);
  return part;
}

function partOf(lock: YMap | Error, o: { dir: string; lockDir: string; lockfile: string; importer: string; name: string }): PnpmPart {
  const { dir, lockDir, lockfile, importer, name } = o;
  if (lock instanceof Error) return { lockfile, name, patches: [], warning: `${lockfile} could not be read (${lock.message}): the whole lockfile is hashed` };
  const version = lock.lockfileVersion;
  if (typeof version !== "string" || !KNOWN_VERSIONS.includes(version)) {
    return { lockfile, name, patches: [], warning: `${lockfile} has lockfileVersion ${JSON.stringify(version ?? null)}, which fdash does not read (it reads ${KNOWN_VERSIONS.join(", ")}): the whole lockfile is hashed` };
  }
  let graph: string;
  try {
    graph = importerGraph(lock, importer);
  } catch (e) {
    // a missing importer is the config's mistake: refused; a graph that does not hold together is the file's
    if (!Object.hasOwn(asMap(lock.importers), importer)) throw new Error(`pnpm input ${dir}: ${(e as Error).message}`);
    return { lockfile, name, patches: [], warning: `${(e as Error).message}: the whole lockfile is hashed` };
  }
  const patches = patchFiles(lock).map((p) => path.posix.normalize(path.posix.join(lockDir, p)));
  return { lockfile, name, digest: crypto.createHash("sha256").update(graph).digest("hex"), patches };
}
