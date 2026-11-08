#!/usr/bin/env bash
# Presence/movement benchmark (scenario A/E): starts a fresh server (media disabled) and runs the load generator.
# usage: scripts/bench.sh <label> <bots> [loadgen flags...]
# For a valid capacity number run the generator on ANOTHER machine (-url http://server:port) and pass the
# server PID sampling yourself; when both run on one host the result is only a rough local reference.
set -euo pipefail
cd "$(dirname "$0")/.."
LABEL=${1:?label}; N=${2:?bots}; shift 2
PORT=${HQ_BENCH_PORT:-18090}
ulimit -n 20000 2>/dev/null || true
DIR=$(mktemp -d)
OUT=${OUT_DIR:-bench/results}
mkdir -p "$OUT"
# HQ_BENCH_ENV: more NAME=value pairs for the server, separated by spaces. env sets them: an expanded word in
# front of the command would be run as the command, not read as an assignment. (The ${a[@]+...} form keeps an
# empty array working under set -u in bash 3.2, macOS's.)
read -ra EXTRA_ENV <<< "${HQ_BENCH_ENV:-}"
HQ_ENV=dev HQ_ADDR=127.0.0.1:$PORT HQ_DB=$DIR/bench.db HQ_JOIN_RATE=100000 HQ_MAX_PLAYERS=10000 \
  env ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} ./bin/homequarters > "$DIR/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; wait $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.1; done
./bin/loadgen -url "http://127.0.0.1:$PORT" -pid "$PID" -label "$LABEL" -n "$N" -out "$OUT/$LABEL.json" "$@"
echo "server log: $DIR/server.log" >&2
