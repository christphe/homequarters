# Plugin runtime spike: gopher-lua vs QuickJS + TypeScript

Throwaway measurement to decide whether plugins' server code moves from Lua to TypeScript. `main.go` runs the sample plugin's server logic on both runtimes with the same minimal `tw` API (kv, broadcast, send, now) and the same workload:

- **Lua:** `sample.lua`, the sample plugin as it was in Lua (commit 226a404), on gopher-lua 1.1.2.
- **TypeScript:** `sample.ts`, the same logic compiled by esbuild 0.28.2 (a Go library, at load time) and run by QuickJS through `modernc.org/quickjs` 0.25.0 (pure Go, no cgo).

~~~bash
cd bench/plugin-runtime && go run . -rt lua && go run . -rt js
~~~

## Measured (2026-10-18)

Windows 11, amd64, Go 1.27.0, one laptop, the dev stack running beside it. Two runs each; numbers are from those runs, not averages of many.

| | gopher-lua | QuickJS + TS |
| --- | --- | --- |
| Start (compile + load) | 0.5-1.0 ms | 2.6-3.6 ms (esbuild included) |
| Tick: 5 messages + `update` + one broadcast, 50 members (mean of 5000) | 16-17 µs | 35-36 µs |
| Memory per live instance (50 members, working set over 20 instances) | 0.28-0.31 MB | 0.44-0.48 MB |
| Runaway `while true` stopped by a 50 ms budget | 51 ms | 52 ms |
| Heap cap per plugin | none (cannot be capped) | 16 MB cap enforced ("out of memory" raised in the plugin) |
| Stripped binary of a program using only that library (stdlib only: 1.7 MB) | 2.9 MB | QuickJS 5.2 MB, esbuild 8.3 MB |

Large plugins (synthetic: N small typed functions, same machine, two runs, 2026-10-18):

| Plugin size | esbuild bundle | QuickJS parse and run | QuickJS from bytecode compiled earlier |
| --- | --- | --- | --- |
| 6,000 lines (202 KB of TS) | 34-50 ms | 18 ms | 4 ms |
| 30,000 lines (1 MB of TS) | 80-85 ms | 107-108 ms | 18 ms |

Single-tick latencies are not reported: the Windows timer here moves in steps of about 0.5 ms, so only means over many ticks are meaningful.

## What it means (estimates, not measured)

- Both are far below the world's 66 ms tick: QuickJS is about twice as slow per call, which does not matter at plugin rates (10 Hz updates, a few messages a second).
- QuickJS brings the one thing gopher-lua lacks: a per-plugin memory cap.
- Binary cost: about +3.5 MB for QuickJS and about +6.6 MB for esbuild over stdlib. esbuild could be left out if plugins ship plain JavaScript (compiled by their author); keeping it lets authors drop a `.ts` file in.
- `modernc.org/quickjs` 0.25 requires Go 1.27; the server and its Docker image are on Go 1.26. An older release or a toolchain bump would be needed.

## Not measured

Linux and the Docker image, many plugins at once, garbage collection pauses over hours, and the cost of real JSON payloads larger than the sample's.
