# Critic: CLI and tools

Lens: the developer tools of the repository (`tools/`, `scripts/`, `fdash.json`, the e2e runner): do they do what they say for every person who runs them, on every OS, without lying about what passed?

Inputs: the brief, the diff, the gate output.

1. False greens first. For every cache, skip or shortcut, find a change that should rerun a check and does not (an input left out, a key that ignores an argument, an environment variable or a tool version, a failure recorded as a pass, a stale record that looks current). Reproduce it with a temporary edit and the real command.
2. The command line: run each command and flag as a newcomer would, from the README or `--help`: no argument, an unknown task or flag, a bad value, Ctrl+C mid-run, a second run at once. Exit codes and messages must say what happened and what to do.
3. Portability: Windows (PowerShell without Git Bash, `.cmd` shims such as `pnpm`, paths with spaces or accents, CRLF), Linux and macOS. Name what you could not run.
4. Isolation: a tool meant to leave the repository (`tools/fdash`) imports nothing from it and names none of its paths; its README matches its behaviour.
5. Processes and files: no orphan process after a failure or Ctrl+C, no unbounded log or cache growth left unexplained, nothing written outside the declared folders.

Done when every shortcut has been attacked with a reproduction, every command and flag has been run once, and what was not run is listed.
