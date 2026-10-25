#!/usr/bin/env bash
# Local development stack: LiveKit (dev mode) + Go server + Vite.
# NOT for production: uses the well-known LiveKit dev key pair.
#
# Sign-in (default: none, the session cookie is the account):
#   scripts/dev.sh --auth=fake-oidc   one "Authorize" button, walks the real OIDC path, invents dev.local people
#   scripts/dev.sh --auth=google      needs HQ_GOOGLE_CLIENT_ID and HQ_GOOGLE_CLIENT_SECRET, with
#                                     http://localhost:5173/auth/google/callback registered in the Google console
#
# Other computers of your local network, audio and video included (a trusted network: the dev stack has no
# sign-in and its first visitor is administrator):
#   scripts/dev.sh --lan=192.168.1.20  this computer's address on the network. Vite serves https on every
#                                     address with a self-signed certificate for it (made with openssl in .run/;
#                                     each browser accepts it once: a microphone and a camera need https), relays
#                                     LiveKit at wss://<address>:5173/livekit, and the server accepts that origin.
#                                     LiveKit must announce that address for media: started here it does; one
#                                     already running (Docker) is restarted with HQ_LK_NODE_IP=<address>.
set -euo pipefail
cd "$(dirname "$0")/.."

auth=none
lan=""
for arg in "$@"; do
  case "$arg" in
    --auth=*) auth=${arg#--auth=} ;;
    --lan=*) lan=${arg#--lan=} ;;
    *) echo "unknown option $arg (known: --auth=none|fake-oidc|google, --lan=<this computer's IPv4 address>)"; exit 1 ;;
  esac
done
if [ -n "$lan" ] && ! [[ "$lan" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "--lan wants this computer's IPv4 address on the local network, like --lan=192.168.1.20 (got $lan)"; exit 1
fi
origins="localhost:*,127.0.0.1:*${lan:+,$lan:*}"
vite_host=127.0.0.1
lk_url=ws://127.0.0.1:7880
if [ -n "$lan" ]; then
  vite_host=0.0.0.0
  lk_url="wss://$lan:5173/livekit" # through Vite: an https page cannot open ws://
  command -v openssl >/dev/null || { echo "--lan needs openssl (Git for Windows has it)"; exit 1; }
  mkdir -p .run
  key=".run/lan-$lan.key" crt=".run/lan-$lan.crt"
  if [ ! -f "$crt" ]; then
    MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout "$key" -out "$crt" \
      -subj "/CN=Home Quarters dev $lan" -addext "subjectAltName=IP:$lan,IP:127.0.0.1,DNS:localhost" 2>/dev/null
  fi
  export HQ_DEV_HTTPS_KEY="$PWD/$key" HQ_DEV_HTTPS_CERT="$PWD/$crt"
fi
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
  if [ -n "$lan" ]; then
    livekit-server --dev --bind 0.0.0.0 --node-ip "$lan" > $LOG/livekit.log 2>&1 &
  else
    livekit-server --dev --bind 127.0.0.1 > $LOG/livekit.log 2>&1 &
  fi
  pids+=($!)
fi

( cd server && go build -o ../bin/homequarters ./cmd/homequarters )
# plugins: the repository's plugins/bundled, plus your own in plugins/installed (git-ignored)
HQ_ENV=dev HQ_ADDR=127.0.0.1:8080 HQ_DB="${HQ_DB:-server/data/dev.db}" \
  HQ_ALLOWED_ORIGINS="$origins" HQ_PLUGINS_DIR="${HQ_PLUGINS_DIR:-plugins}" \
  LIVEKIT_URL="$lk_url" LIVEKIT_API_URL=http://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
  ./bin/homequarters > $LOG/server.log 2>&1 &
pids+=($!)

( cd web && [ -d node_modules ] || pnpm install )
( cd web && pnpm exec vite --host "$vite_host" > ../$LOG/vite.log 2>&1 ) &
pids+=($!)

echo "Home Quarters dev stack:"
# Google sends the browser back to the registered address: open that one, or the sign-in cookie is on another host
echo "  app      ${HQ_PUBLIC_URL:-http${lan:+s}://${lan:-127.0.0.1}:5173}"
if [ -n "$lan" ]; then
  echo "  network  https://$lan:5173  (accept the self-signed certificate once in each browser)"
  echo "           also https://$lan:5173 on this computer: http://127.0.0.1:5173 is not served in this mode"
  if [ "$livekit" = external ]; then
    echo "  media    the LiveKit already on 7880 must announce $lan, e.g. for the local Docker one:"
    echo "           HQ_LK_NODE_IP=$lan docker compose -p homequarters-local -f deploy/docker-compose.local.yml up -d livekit"
  fi
fi
echo "  server   http://127.0.0.1:8080  (metrics: /metrics)"
echo "  livekit  $lk_url ($livekit)"
echo "  sign-in  $auth"
echo "logs in $LOG/. Ctrl-C to stop."
wait
