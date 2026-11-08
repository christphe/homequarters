# fdash

Runs the tasks of a repository, several at once, and skips those whose inputs already passed.

fdash needs Node 24 (it is TypeScript run as is, without a build) and git for cached commands. It has no
dependency. It lives in the repository that uses it until it is proven, then it will move to its own
repository; it imports nothing from its host and names none of its paths.

```
node tools/fdash/cli.ts run                         # the task "default"
node tools/fdash/cli.ts run test:unit               # test:unit in every project defining it
node tools/fdash/cli.ts run test:unit --pkg server  # only server's (--pkg may be repeated)
node tools/fdash/cli.ts run build test:integration  # two stages: every build, then every test:integration
node tools/fdash/cli.ts run --skip test:e2e         # leave a task out wherever it appears
node tools/fdash/cli.ts run --jobs 4                # 4 at once (FDASH_JOBS; default: half the logical CPUs)
node tools/fdash/cli.ts run --force                 # run everything, even what is cached
node tools/fdash/cli.ts run test:e2e --pkg e2e -- one two  # extra arguments for the commands with "args": true
node tools/fdash/cli.ts list [--pkg server]         # the tasks, in file order
```

Several names on the command line run as **stages**, one after the other: the tasks of the first name, then
those of the second, and so on; a task already run by an earlier stage is not repeated, and a failed stage
stops the next ones. Inside a stage, tasks run at once as far as `--jobs` and their order (below) allow.
`--pkg` applies to every stage: `run build test:integration --pkg maps` fails when `maps` has no `build`. A task name runs its projects' tasks as far as `--jobs` allows; a group's `jobs` limits only that group: in this repository `run browser` runs the browser suites one at a time, while `run test:e2e` starts them together.
To build another project first, run it as its own command: `run build --pkg core`, then
`run test:integration --pkg maps`.

It prints one line per command as it ends: `PASS <name>`, `CACHED <name>`, `FAIL <name> (log: <file>)`
followed by the last 15 lines of the log, or `FAIL <name> (after <other> failed)` for a command not run
because a command it starts after failed. A command that had passed but runs again because its outputs could
not be restored is preceded by `WARN cache miss <name>: <why>` (see Outputs). Each command's output goes to its own log file in a temporary
folder (`FDASH_LOG_DIR` keeps them in a folder of your choice, to publish them from CI). The exit code is 1 when a command failed, 2 for a usage or configuration error, 130 when
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
| `outputs` | the files the command produces, stored with a pass and restored on a hit (below) |
| `after` | tasks of the same file (or project) this command starts after, when they are part of the run |
| `cache` | `false` turns the cache off for this command |

| Group key | Meaning |
| --- | --- |
| `tasks` | its members, commands or groups |
| `jobs` | how many members run at once; without it, the global value (`--jobs`) |
| `after` | tasks every command of the group starts after |

A group runs all its members even when one fails, and fails when any did. A command reached twice in a run
runs once. `after` only orders: a task named there that is not part of the run is not started and not waited
for (`run test:unit --pkg site` does not run site's `build`). Unknown keys, wrong types, unknown names and cycles are refused before anything runs. On
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
    "default": { "jobs": 1, "tasks": ["static", "test:e2e"] },
    "static": { "tasks": ["lint", "build", "test:unit"] }
  }
}
```

```json
// core/fdash.json
{ "tasks": { "build": { "run": [["go", "build", "-o", "../bin/", "./cmd/app"]], "outputs": ["/bin/app*"] },
             "test:unit": { "run": [["go", "test", "./..."]] } } }
// addons/maps/fdash.json
{ "dependsOn": ["core"], "tasks": { "test:unit": { "run": [["node", "--test", "test/*.test.ts"]] },
                                    "test:integration": { "run": [["node", "--test", "**/*.ispec.ts"]] } } }
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

- A project's task runs in its folder. On the command line and in groups it is named without its project
  (`test:unit`, a name may hold colons), which means that task in every project defining it, in project
  order; `--pkg <project>` restricts the command line to the projects named, and is an error when one of
  them lacks the task. Reports name it `<project>:<task>` (an item `<project>:<task>:<item>`). A workspace
  task and a project task cannot share a name, and `--pkg` cannot restrict a workspace task.
- In a project's group, a member is first a task of the same project, else that name in every project
  defining it, else the workspace's task. In a workspace group, a member is that name in every project
  defining it, else the workspace's task.
- Every command of a project is cached; its default inputs are every file of its folder plus its
  `dependsOn`'s `files`. Its own `inputs` add to them: relative to the project, or from the root with a
  leading `/` (`/docs/protocol.md`); a Go provider's `cwd` is relative to the project. Its `!` patterns
  remove files from the whole set. `outputs` are written the same way (relative to the project, or from
  the root with a leading `/`). `"cache": false` turns the cache off for one command.
- A file a test reads at run time, outside its project and its `dependsOn`, must be added to its
  `inputs`: fdash only sees what is declared.

### Order

Tasks run as a graph with two kinds of edges, and no other:

1. **Across projects:** task X of a project starts after task X of each project it depends on. When a
   dependency has no task X, the walk goes through it to its own dependencies: with `maps` depending on
   `cards` depending on `core`, `maps:test:integration` waits for `core:test:integration` even if `cards`
   has none.
2. **Inside a project:** a task starts after the tasks of its own project it names in `after`
   (`"test:unit": { "after": ["build"], ... }`). Whether a project needs a build before its tests is its own
   business.

A task never starts another project's task by itself: `test:integration` does not build anything. Run the
build first, as a stage (`run build test:integration`) or a group with `"jobs": 1`; a test that finds an
artefact missing should say which task makes it. When a task fails, the tasks that start after it are not
run and are reported `FAIL <name> (after <task> failed)`.

### Conventional names

fdash knows no task name but `default`. A workspace may agree on names so that one word runs a tier
everywhere; the repository fdash lives in uses these, and puts format checks in `lint`:

| Task | Meant for |
| --- | --- |
| `build` | what runs or what other projects use (a binary, a built client, a site) |
| `lint` | checks that read code without running it: format, types, linters, doc checks |
| `test:unit` | unit tests |
| `test:integration` | tests against a real process, without a browser |
| `test:e2e` | browser tests |

## The cache

A command with `inputs` is cached. Its key is a SHA-256 of its definition, the extra arguments it gets, the
values of its `envKeys`, the output of its `tools`, the OS, the CPU architecture, Node's version, and the
content of its input files. A pass records the key in `.fdash/cache/` (or `FDASH_CACHE_DIR`); a command
whose key is recorded is reported `CACHED` and not run, and its record is touched (its time set to now):
records older than a run's start were not used by it, so a CI job can delete them before saving its cache.
Failures are never recorded, nor a pass whose inputs changed while it ran (their content or their time; on a file system whose times
are coarse, FAT or some network shares, a change undone within the same tick at the same size goes unseen),
nor anything after Ctrl+C. The cache only grows (each stored build adds its outputs: a server binary is about 32 MB): deleting `.fdash/cache` (or its old files) is always safe,
it only makes the next run longer. Add `.fdash/` to
`.gitignore`.

Inputs:

- a **path pattern** relative to the root, in git's glob syntax (`src/**`, `docs/*.md`); a leading `!`
  excludes. It matches the tracked files and the untracked files git does not ignore.
- a **Go provider**, `{ "go": "<package pattern>", "cwd": "<module folder>", "tests": <bool> }`: the
  files of every package of that module reached by `go list -deps` from the pattern (Go, cgo and embedded
  files, plus test files and `testdata/` when `tests` is true), with the module's `go.mod` and `go.sum`.
- a **disk pattern**, `{ "disk": "<path pattern>" }`: the files the pattern matches on disk, git-ignored
  ones included, in the syntax of `outputs` (in a project, relative to it or from the root with a leading
  `/`). It is for build artefacts a command runs or serves: a test that runs `bin/app` declares
  `{ "disk": "/bin/app*" }`, so a pass on a stale binary is recorded under a key that the rebuilt binary does
  not give, and the test runs again once it is rebuilt. A pattern that matches nothing (not built yet) adds
  nothing; the command then runs and fails for lack of the artefact, and nothing is recorded. Only the
  content counts, not the file's mode or time.

When in doubt, declare an input wider: a missing input is a check skipped while what it tests changed.

### Outputs

A cached command may declare `outputs`: path patterns, in the same syntax as inputs (a leading `!`
excludes), of the files it produces. They are found on disk, not through git, since what a build writes is
usually ignored by git.

- The patterns are part of the key: changing them makes the command run again.
- On a pass, the files they match are copied next to the record (`<record>.out/`, with a list in
  `<record>.out.json` written last); if they cannot be stored, nothing is recorded.
- Each file's mode is kept in the list, and given back on a restore: a cache moved by means that lose modes
  (a CI artifact holds every file as 0644) still restores an executable binary.
- On a hit, they are copied back over what is on disk before the commands that start after it, and files
  the patterns match on disk that the pass did not produce are removed (a page removed on this branch, a
  binary built for another platform), so what is on disk matches the key. A record whose outputs are not all in the cache is a miss: the command runs,
  after the line `WARN cache miss <name>: outputs not in the cache`.
- A pass recorded before the command declared outputs cannot restore anything: the command runs, after
  `WARN cache miss <name>: a pass recorded before outputs were cached`.
- `outputs` cannot be combined with `items`. A command without `outputs` keeps the key it had before.

This is what lets a fresh machine that only received the records (a CI runner) skip a build: the build is
`CACHED` and its binary is on disk.

### Items

A command with `items` (and `inputs`, even `[]`) caches each item on its own, with the command's inputs
plus the item's. fdash appends the names of the items that have not passed to the last step, runs the
command once, and gives it `FDASH_REPORT`, a file where the command appends one JSON line per item:
`{"item":"login","ok":true}`. An item missing from that file takes the command's exit status. A line `{"nocache":true}` asks fdash to record nothing for that run (a run on a stale build). Items are
reported as `<command>:<item>`, and run with `fdash run <command> -- <item>`. Extra arguments that are all items pick those items; any other extra
argument runs the command uncached, with the arguments as given.

## API

```ts
import { load, select } from "./workspace.ts";
import { run } from "./run.ts";
const config = load(root); // the workspace's, or a lone fdash.json's
const { results, interrupted } = await run({ root, config, names: select(config, ["test:unit"], ["server"]),
  jobs: 4, skip: [], extraArgs: [], force: false, onResult: (r) => console.log(r.name, r.ok, r.cached, r.warn), signal });
```

`select` turns names as the command line takes them (and `--pkg` projects) into the tasks they stand for.
`run` runs one stage; `results` lists each command (or item) that ran or was cached, in the order the groups
reach them, with `warn` set when a command that had passed ran again and `failedAfter` when it was not run.

## Tests

`node --test 'tools/fdash/test/*.test.ts'`
