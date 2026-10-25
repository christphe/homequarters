#!/usr/bin/env bash
# Local development stack: LiveKit (dev mode) + Go server + Vite.
# NOT for production: uses the well-known LiveKit dev key pair.
#
# Sign-in (default: none, the session cookie is the account):
#   scripts/dev.sh --auth=fake-oidc   one "Authorize" button, walks the real OIDC path, invents dev.local people
#   scripts/dev.sh --auth=google      needs HQ_GOOGLE_CLIENT_ID and HQ_GOOGLE_CLIENT_SECRET, with
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
  none) export HQ_AUTH_PROVIDERS=none ;;
  fake-oidc)
    export HQ_AUTH_PROVIDERS=fake-oidc HQ_AUTH_DOMAINS="${HQ_AUTH_DOMAINS:-dev.local}" ;;
  google)
    : "${HQ_GOOGLE_CLIENT_ID:?--auth=google needs HQ_GOOGLE_CLIENT_ID}"
    : "${HQ_GOOGLE_CLIENT_SECRET:?--auth=google needs HQ_GOOGLE_CLIENT_SECRET}"
    export HQ_AUTH_PROVIDERS=google HQ_PUBLIC_URL="${HQ_PUBLIC_URL:-http://localhost:5173}" ;;
  *) echo "unknown --auth=$auth (known: none, fake-oidc, google)"; exit 1 ;;
esac
mkdir -p .run server/data
LOG=.run

# A LiveKit already on 7880 (e.g. `docker compose -f deploy/docker-compose.local.yml up -d livekit`) is reused;
# it must run in --dev mode (devkey/secret).
livekit=start
if (exec 3<>/dev/tcp/127.0.0.1/7880) 2>/dev/null; then
  livekit=external
else
  command -v livekit-server >/dev/null || { echo "livekit-server not found and nothing listens on 7880 (brew install livekit, or: docker compose -f deploy/docker-compose.local.yml up -d livekit)"; exit 1; }
fi
command -v go >/dev/null || { echo "go not found"; exit 1; }

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

if [ "$livekit" = start ]; then
  livekit-server --dev --bind 127.0.0.1 > $LOG/livekit.log 2>&1 &
  pids+=($!)
fi

( cd server && go build -o ../bin/homequarters ./cmd/homequarters )
# plugins: the repository's plugins/bundled, plus your own in plugins/installed (git-ignored)
HQ_ENV=dev HQ_ADDR=127.0.0.1:8080 HQ_DB="${HQ_DB:-server/data/dev.db}" \
  HQ_ALLOWED_ORIGINS="localhost:*,127.0.0.1:*" HQ_PLUGINS_DIR="${HQ_PLUGINS_DIR:-plugins}" \
  LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
  ./bin/homequarters > $LOG/server.log 2>&1 &
pids+=($!)

( cd web && [ -d node_modules ] || pnpm install )
( cd web && pnpm exec vite --host 127.0.0.1 > ../$LOG/vite.log 2>&1 ) &
pids+=($!)

echo "Home Quarters dev stack:"
# Google sends the browser back to the registered address: open that one, or the sign-in cookie is on another host
echo "  app      ${HQ_PUBLIC_URL:-http://127.0.0.1:5173}"
echo "  server   http://127.0.0.1:8080  (metrics: /metrics)"
echo "  livekit  ws://127.0.0.1:7880 ($livekit)"
echo "  sign-in  $auth"
echo "logs in $LOG/. Ctrl-C to stop."
wait
