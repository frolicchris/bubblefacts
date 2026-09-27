#!/bin/bash
# ============================================================
# Stream Facts Overlay — start the overlay server
#
#   bash scripts/start-overlay.sh
#
# Runs a preflight check, then starts the backend. Ctrl-C to stop.
# ============================================================

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/opt/homebrew/bin:$PATH"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s\n" "$1"; }

cd "$PROJECT_DIR" || exit 1

echo
echo "--- Preflight ---"

# Only check Ollama when it is the provider in use.
AI_PROVIDER=$(grep -E '^AI_PROVIDER=' .env 2>/dev/null | cut -d= -f2)
if [ "${AI_PROVIDER:-ollama}" = "ollama" ]; then
  OLLAMA_URL=$(grep -E '^OLLAMA_BASE_URL=' .env 2>/dev/null | cut -d= -f2-)
  OLLAMA_URL=${OLLAMA_URL:-http://localhost:11434}
  OLLAMA_MODEL=$(grep -E '^OLLAMA_MODEL=' .env 2>/dev/null | cut -d= -f2)
  OLLAMA_MODEL=${OLLAMA_MODEL:-llama3.2}
  if ! curl -s --max-time 3 "$OLLAMA_URL/" >/dev/null 2>&1 && command -v ollama >/dev/null; then
    echo "  Ollama not running — starting it..."
    nohup ollama serve > /tmp/ollama-overlay.log 2>&1 &
    sleep 4
  fi
  if curl -s --max-time 5 "$OLLAMA_URL/" >/dev/null 2>&1; then
    ok "Ollama responding at $OLLAMA_URL"
  else
    fail "Ollama not responding at $OLLAMA_URL"
    echo "     Install: https://ollama.com  then: ollama pull $OLLAMA_MODEL"
    exit 1
  fi
  if curl -s --max-time 5 "$OLLAMA_URL/api/tags" 2>/dev/null | grep -q "\"${OLLAMA_MODEL}"; then
    ok "$OLLAMA_MODEL available"
  else
    fail "$OLLAMA_MODEL not found — run: ollama pull $OLLAMA_MODEL"
    exit 1
  fi
else
  ok "AI provider: $AI_PROVIDER (skipping Ollama check)"
fi

# StreamerSongList reachable and the token accepted?
# The rebuilt API has no public endpoints, so this doubles as a token check —
# which is worth catching here rather than 20 seconds into a stream.
SSL_NAME=$(grep -E '^SSL_STREAMER_NAME=' .env 2>/dev/null | cut -d= -f2)
# Strip surrounding quotes. dotenv removes them but `cut` does not, so a
# .env written as SSL_ACCESS_TOKEN="abc..." — legal syntax and a common
# habit — sent Authorization: Streamer "abc...", got a 401, and hard-exited
# blaming the token, minutes before going live, on a config that runs fine.
SSL_TOKEN=$(grep -E '^SSL_ACCESS_TOKEN=' .env 2>/dev/null | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
SSL_PLAT=$(grep -E '^SSL_PLATFORM=' .env 2>/dev/null | cut -d= -f2)
SSL_PLAT=${SSL_PLAT:-twitch}
SSL_KIND=$(grep -E '^SSL_TOKEN_KIND=' .env 2>/dev/null | cut -d= -f2)
case "${SSL_KIND:-streamer}" in
  user)   SSL_SCHEME=User ;;
  bearer) SSL_SCHEME=Bearer ;;
  *)      SSL_SCHEME=Streamer ;;
esac
if [ -z "${SSL_TOKEN:-}" ]; then
  fail "SSL_ACCESS_TOKEN is not set in .env — the StreamerSongList API requires it on every request"
  fail "Create one at streamersonglist.com under Settings > Access, then re-run"
  exit 1
fi
SSL_HOST=$(grep -E '^SSL_API_BASE=' .env 2>/dev/null | cut -d= -f2-)
if [ -z "${SSL_HOST:-}" ]; then
  if [ "$(grep -E '^SSL_ENV=' .env 2>/dev/null | cut -d= -f2)" = "staging" ]; then
    SSL_HOST="https://api.staging.streamersonglist.com"
  else
    SSL_HOST="https://api.streamersonglist.com"
  fi
fi
if [ -n "${SSL_NAME:-}" ]; then
  SSL_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 \
    -H "Authorization: ${SSL_SCHEME} ${SSL_TOKEN}" \
    "${SSL_HOST}/streamers?streamer_name=${SSL_NAME}&platform=${SSL_PLAT}")
  case "$SSL_CODE" in
    200) ok "StreamerSongList reachable and token accepted (streamer: $SSL_NAME)" ;;
    401|403) fail "StreamerSongList rejected the token ($SSL_CODE) — check SSL_ACCESS_TOKEN and SSL_TOKEN_KIND"; exit 1 ;;
    *) fail "Could not resolve streamer '$SSL_NAME' on StreamerSongList ($SSL_CODE) (continuing anyway)" ;;
  esac
fi

# Port free?
if lsof -i :3000 -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port 3000 already in use:"
  lsof -i :3000 -sTCP:LISTEN | tail -n +2 | awk '{print "     " $1 " (pid " $2 ")"}'
  echo "     Stop it, or run with a different port: PORT=3001 bash scripts/start-overlay.sh"
  exit 1
fi
ok "Port 3000 free"

# Build if needed. We run the COMPILED output rather than ts-node-dev:
# the dev transpiler doesn't work on Node 24+, and a stream is no place
# for an on-the-fly transpiler anyway.
if [ ! -f dist/backend/server.js ] || [ -n "$(find backend/src -name '*.ts' -newer dist/backend/server.js 2>/dev/null)" ]; then
  echo "  Building backend..."
  npx tsc -p backend/tsconfig.json || { fail "Build failed"; exit 1; }
  ok "Build complete"
else
  ok "Build up to date"
fi

# Persist the log. Previously this ran in the foreground only, so when the
# overlay misbehaved mid-stream the evidence lived in a terminal that was
# closed by the time anyone looked. Keep the last 10 runs.
mkdir -p logs
LOG="logs/overlay-$(date +%Y%m%d-%H%M%S).log"
ls -1t logs/overlay-*.log 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
ln -sfn "$(basename "$LOG")" logs/latest.log 2>/dev/null || true

echo
echo "--- Starting server ---"
echo "  OBS Browser Source URL:  http://localhost:${PORT:-3000}/obs-overlay"
echo "  Health check:            http://localhost:${PORT:-3000}/health"
echo "  Log:                     $LOG  (also logs/latest.log)"
echo "  Ctrl-C to stop"
echo

# Line-buffered through tee so the log is complete even if the process is
# killed rather than exiting cleanly.
exec node dist/backend/server.js 2>&1 | tee -a "$LOG"
