#!/usr/bin/env bash
# BubbleFacts: check the setup, build if needed, and run the server.
#
#   bash scripts/start-overlay.sh
#
# Logs go to logs/overlay-<timestamp>.log (last 10 kept) and logs/latest.log.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

# Read KEY from .env the way dotenv does: quotes removed, or an unquoted
# value cut at "#" with trailing spaces trimmed.
env_get() {
  grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- |
    sed -E -e "/^[\"']/!s/#.*$//" -e 's/[[:space:]]+$//' \
      -e "s/^\"(.*)\"[[:space:]]*(#.*)?$/\1/" -e "s/^'(.*)'[[:space:]]*(#.*)?$/\1/"
}

echo
echo "--- Preflight ---"

[ -f .env ] || fail "No .env file. Run: cp .env.example .env  and fill it in"
command -v node >/dev/null || fail "Node.js not found. Install Node 20 or newer"
[ -d node_modules ] || fail "Dependencies missing. Run: npm install"

PORT="${PORT:-$(env_get PORT)}"
PORT="${PORT:-3000}"

provider="$(env_get AI_PROVIDER)"
if [ "${provider:-ollama}" = "ollama" ]; then
  url="$(env_get OLLAMA_BASE_URL)"; url="${url:-http://localhost:11434}"
  model="$(env_get OLLAMA_MODEL)"; model="${model:-llama3.2}"
  if ! curl -s --max-time 3 "$url/" >/dev/null && command -v ollama >/dev/null; then
    echo "  Starting Ollama..."
    nohup ollama serve >/tmp/ollama-overlay.log 2>&1 &
    sleep 4
  fi
  curl -s --max-time 5 "$url/" >/dev/null || fail "Ollama not responding at $url (install from https://ollama.com)"
  curl -s --max-time 5 "$url/api/tags" | grep -q "\"$model" || fail "Model $model missing. Run: ollama pull $model"
  ok "Ollama ready with $model"
else
  ok "AI provider: $provider"
fi

# The StreamerSongList API needs the token on every call, so this doubles as a token check.
name="$(env_get SSL_STREAMER_NAME)"
token="$(env_get SSL_ACCESS_TOKEN)"
[ -n "$name" ] || fail "SSL_STREAMER_NAME is not set in .env"
[ -n "$token" ] || fail "SSL_ACCESS_TOKEN is not set in .env (streamersonglist.com > Settings > Access)"
case "$(env_get SSL_TOKEN_KIND)" in
  user)   scheme=User ;;
  bearer) scheme=Bearer ;;
  *)      scheme=Streamer ;;
esac
api="$(env_get SSL_API_BASE)"
[ "$(env_get SSL_ENV)" = staging ] && api="${api:-https://api.staging.streamersonglist.com}"
api="${api:-https://api.streamersonglist.com}"
platform="$(env_get SSL_PLATFORM)"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 -H "Authorization: $scheme $token" \
  "$api/streamers?streamer_name=$name&platform=${platform:-twitch}")"
case "$code" in
  200)     ok "StreamerSongList accepted the token for $name" ;;
  401|403) fail "StreamerSongList rejected the token ($code). Check SSL_ACCESS_TOKEN and SSL_TOKEN_KIND" ;;
  *)       printf '  ! StreamerSongList returned %s for %s; continuing, the server will retry\n' "$code" "$name" ;;
esac

if lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port $PORT is in use. Stop that process or set PORT to another value"
fi
ok "Port $PORT free"

if [ ! -f dist/backend/server.js ] || [ -n "$(find backend/src -newer dist/backend/server.js -print -quit)" ]; then
  echo "  Building..."
  npm run build --silent || fail "Build failed"
fi
ok "Build up to date"

mkdir -p logs
log="logs/overlay-$(date +%Y%m%d-%H%M%S).log"
find logs -name 'overlay-*.log' | sort -r | tail -n +10 | xargs rm -f
ln -sfn "$(basename "$log")" logs/latest.log

echo
echo "--- Running on port $PORT (Ctrl-C to stop) ---"
echo "  Health: http://127.0.0.1:$PORT/health"
echo "  Log:    $log"
echo
PORT="$PORT" node dist/backend/server.js 2>&1 | tee -a "$log"
