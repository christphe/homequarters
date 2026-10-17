#!/usr/bin/env bash
# Local development stack: LiveKit (dev mode) + Go server + Vite.
# NOT for production: uses the well-known LiveKit dev key pair.
#
# Sign-in (default: none, the session cookie is the account):
#   scripts/dev.sh --auth=fake-oidc   one "Authorize" button, walks the real OIDC path, invents dev.local people
#   scripts/dev.sh --auth=google      needs TILEWORK_GOOGLE_CLIENT_ID and TILEWORK_GOOGLE_CLIENT_SECRET, with
#                                     http://localhost:5173/auth/google/callback registered in the Google console
set -euo pipefail
cd "$(dirname "$0")/.."

auth=none
for arg in "$@"; do
  case "$arg" in
    --auth=*) auth=${arg#--auth=} ;;
    *) echo "unknown option $arg (known: --auth=none|fake-oidc|google)"; exit 1 ;;
  esac
done
case "$auth" in
  none) export TILEWORK_AUTH_PROVIDERS=none ;;
  fake-oidc)
    export TILEWORK_AUTH_PROVIDERS=fake-oidc TILEWORK_AUTH_DOMAINS="${TILEWORK_AUTH_DOMAINS:-dev.local}" ;;
  google)
    : "${TILEWORK_GOOGLE_CLIENT_ID:?--auth=google needs TILEWORK_GOOGLE_CLIENT_ID}"
    : "${TILEWORK_GOOGLE_CLIENT_SECRET:?--auth=google needs TILEWORK_GOOGLE_CLIENT_SECRET}"
    export TILEWORK_AUTH_PROVIDERS=google TILEWORK_PUBLIC_URL="${TILEWORK_PUBLIC_URL:-http://localhost:5173}" ;;
  *) echo "unknown --auth=$auth (known: none, fake-oidc, google)"; exit 1 ;;
esac
mkdir -p .run server/data
LOG=.run

command -v livekit-server >/dev/null || { echo "livekit-server not found (brew install livekit, or use docker compose)"; exit 1; }
command -v go >/dev/null || { echo "go not found"; exit 1; }

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

livekit-server --dev --bind 127.0.0.1 > $LOG/livekit.log 2>&1 &
pids+=($!)

( cd server && go build -o ../bin/tilework ./cmd/tilework )
TILEWORK_ENV=dev TILEWORK_ADDR=127.0.0.1:8080 TILEWORK_DB="${TILEWORK_DB:-server/data/dev.db}" \
  TILEWORK_ALLOWED_ORIGINS="localhost:*,127.0.0.1:*" \
  LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
  ./bin/tilework > $LOG/server.log 2>&1 &
pids+=($!)

( cd web && [ -d node_modules ] || pnpm install )
( cd web && pnpm exec vite --host 127.0.0.1 > ../$LOG/vite.log 2>&1 ) &
pids+=($!)

echo "Tilework dev stack:"
# Google sends the browser back to the registered address: open that one, or the sign-in cookie is on another host
echo "  app      ${TILEWORK_PUBLIC_URL:-http://127.0.0.1:5173}"
echo "  server   http://127.0.0.1:8080  (metrics: /metrics)"
echo "  livekit  ws://127.0.0.1:7880"
echo "  sign-in  $auth"
echo "logs in $LOG/. Ctrl-C to stop."
wait
