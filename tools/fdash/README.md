# fdash

Runs the tasks of a repository, several at once, and skips those whose inputs already passed.

fdash needs Node 24 (it is TypeScript run as is, without a build) and git for cached commands. It has no
dependency. It lives in the repository that uses it until it is proven, then it will move to its own
repository; it imports nothing from its host and names none of its paths.

```
node tools/fdash/cli.ts run                    # the task "default"
node tools/fdash/cli.ts run lint test          # these tasks
node tools/fdash/cli.ts run --skip slow        # leave a task out wherever it appears
node tools/fdash/cli.ts run --jobs 4           # 4 at once (FDASH_JOBS; default: half the logical CPUs)
node tools/fdash/cli.ts run --force            # run everything, even what is cached
node tools/fdash/cli.ts run browser -- one two # extra arguments for the commands with "args": true
node tools/fdash/cli.ts list                   # the tasks, in file order
```

It prints one line per command as it ends: `PASS <name>`, `CACHED <name>`, or `FAIL <name> (log: <file>)`
followed by the last 15 lines of the log. Each command's output goes to its own log file in a temporary
folder (`FDASH_LOG_DIR` keeps them in a folder of your choice, to publish them from CI). The exit code is the number of failed commands, 2 for a usage or configuration error, 130 when
interrupted. On Ctrl+C the terminal stops the running commands itself; fdash starts nothing more.

## fdash.json

At the root of the repository (fdash looks for it from the current folder up):

```json
{
  "tasks": {
    "default": { "jobs": 1, "tasks": ["static", "browser"] },
    "static": { "tasks": ["fmt", "test"] },
    "fmt": { "cwd": "src", "run": [["gofmt", "-l", "."]], "failOnOutput": true,
             "inputs": ["src/**/*.go"], "tools": [["go", "version"]] },
    "test": { "run": [["node", "--test"]], "inputs": ["lib/**", "test/**", "package.json"] },
    "browser": { "cwd": "browser", "run": [["node", "run.mjs"]], "args": true, "env": { "VIEWPORT": "small" },
                 "inputs": [{ "go": "./cmd/app", "cwd": "src" }, "browser/*.mjs"], "envKeys": ["VIEWPORT"],
                 "items": { "login": { "inputs": ["browser/scenarios/login.mjs"] },
                            "chat": { "inputs": ["browser/scenarios/chat.mjs"] } } }
  }
}
```

A task is a **command** or a **group**.

| Command key | Meaning |
| --- | --- |
| `run` | the steps, in sequence, each an argv (no shell); the first that fails fails the command |
| `cwd` | folder the steps run in, relative to the root (default `.`) |
| `env` | variables added to the environment |
| `failOnOutput` | anything printed on stdout fails the command (a formatter listing files) |
| `args` | extra arguments given to fdash are appended to the last step |
| `inputs` | the files the command reads; without it the command is never cached (below) |
| `envKeys` | environment variables whose values are part of the cache key |
| `tools` | commands whose output is part of the cache key (`[["go", "version"]]`) |
| `items` | parts of the command cached one by one (below) |

| Group key | Meaning |
| --- | --- |
| `tasks` | its members, commands or groups |
| `jobs` | how many members run at once; without it, the global value (`--jobs`) |

A group runs all its members even when one fails, and fails when any did. A command reached twice in a run
runs once. Unknown keys, wrong types, unknown names and cycles are refused before anything runs. On
Windows, a command found as a `.cmd` or `.bat` (such as `pnpm`) is started through the shell with its
arguments quoted; nothing else uses a shell.

## Projects: fdash-workspace.json

A repository with several parts declares them as projects, each in its own folder with its own
`fdash.json`, listed by `fdash-workspace.json` at the root (fdash looks for it from the current folder up,
before a lone `fdash.json`):

```json
{
  "projects": ["core", "app", "addons/*"],
  "tasks": {
    "default": { "jobs": 1, "tasks": ["static", "app:browser"] },
    "static": { "tasks": ["*:lint", "*:test", "docs"] },
    "docs": { "run": [["node", "tools/docs.mjs"]], "inputs": ["docs/**"] }
  }
}
```

```json
// addons/maps/fdash.json
{ "dependsOn": ["core"], "tasks": { "test": { "run": [["node", "--test", "test/*.test.ts"]] } } }
```

| Workspace key | Meaning |
| --- | --- |
| `projects` | folders; a `*` matches one level and skips folders without `fdash.json`; a folder named in full must have one |
| `tasks` | the workspace's own commands (run from the root, inputs written from the root; without `inputs` not cached) and groups |

| Project key | Meaning |
| --- | --- |
| `name` | default: the folder's name; two projects with one name are refused |
| `files` | what other projects see of it, patterns relative to the project (default `**`) |
| `dependsOn` | project names; their `files`, transitively, are inputs of every task of this project |
| `tasks` | as in a single `fdash.json` |

- A project's tasks are named `<project>:<task>` (an item `<project>:<task>:<item>`) and run in its folder.
- Every command of a project is cached; its default inputs are every file of its folder plus its
  `dependsOn`'s `files`. Its own `inputs` add to them: relative to the project, or from the root with a
  leading `/` (`/docs/protocol.md`); a Go provider's `cwd` is relative to the project. Its `!` patterns
  remove files from the whole set. `"cache": false` turns the cache off for one command.
- In a group, a member is a task of the same project (`test`), a qualified name (`core:test`), or
  `*:<task>`: that task in every project that has it, in project order.
- A file a test reads at run time, outside its project and its `dependsOn`, must be added to its
  `inputs`: fdash only sees what is declared.

## The cache

A command with `inputs` is cached. Its key is a SHA-256 of its definition, the extra arguments it gets, the
values of its `envKeys`, the output of its `tools`, the OS, the CPU architecture, Node's version, and the
content of its input files. A pass records the key in `.fdash/cache/` (or `FDASH_CACHE_DIR`); a command
whose key is recorded is reported `CACHED` and not run, and its record is touched (its time set to now):
records older than a run's start were not used by it, so a CI job can delete them before saving its cache.
Failures are never recorded. Add `.fdash/` to
`.gitignore`.

Inputs:

- a **path pattern** relative to the root, in git's glob syntax (`src/**`, `docs/*.md`); a leading `!`
  excludes. It matches the tracked files and the untracked files git does not ignore.
- a **Go provider**, `{ "go": "<package pattern>", "cwd": "<module folder>", "tests": <bool> }`: the
  files of every package of that module reached by `go list -deps` from the pattern (Go, cgo and embedded
  files, plus test files and `testdata/` when `tests` is true), with the module's `go.mod` and `go.sum`.

When in doubt, declare an input wider: a missing input is a check skipped while what it tests changed.

### Items

A command with `items` (and `inputs`, even `[]`) caches each item on its own, with the command's inputs
plus the item's. fdash appends the names of the items that have not passed to the last step, runs the
command once, and gives it `FDASH_REPORT`, a file where the command appends one JSON line per item:
`{"item":"login","ok":true}`. An item missing from that file takes the command's exit status. Items are
reported as `<command>:<item>`. Extra arguments that are all items pick those items; any other extra
argument runs the command uncached, with the arguments as given.

## API

```ts
import { loadConfig } from "./config.ts";
import { run } from "./run.ts";
const { results, interrupted } = await run({ root, config: loadConfig(root), names: ["default"], jobs: 4,
  skip: [], extraArgs: [], force: false, onResult: (r) => console.log(r.name, r.ok, r.cached), signal });
```

`results` lists each command (or item) that ran or was cached, in the order the groups reach them.

## Tests

`node --test 'tools/fdash/test/*.test.ts'`
