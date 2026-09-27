#!/bin/bash
# ============================================================
# Is OBS actually talking to the overlay server?
#
#   bash scripts/check-overlay.sh
#
# Run this with the server already running. It watches for OBS to fetch the
# page, so you can tell "OBS never asked" apart from "OBS asked but nothing
# rendered" — two different problems that look identical on stream.
#
# Then, while it's watching: in OBS, right-click your Browser Source and
# choose Refresh.
# ============================================================

set -uo pipefail
PORT="${PORT:-3000}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }
info() { printf "  \033[36m→\033[0m %s\n" "$1"; }

echo
echo "--- Overlay connection check ---"

# 1. Server reachable?
HEALTH=$(curl -s --max-time 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null)
if [ -z "$HEALTH" ]; then
  bad "Server is not responding on port ${PORT}"
  echo "     Start it first:  bash scripts/start-overlay.sh"
  exit 1
fi
ok "Server responding on port ${PORT}"

CLIENTS=$(printf '%s' "$HEALTH" | sed -n 's/.*"obsClients":[[:space:]]*\([0-9]*\).*/\1/p')
CLIENTS=${CLIENTS:-0}
if [ "$CLIENTS" -gt 0 ]; then
  ok "An overlay IS connected right now (obsClients: $CLIENTS)"
  echo
  echo "  Connected clients (a browser tab you opened to test counts here too,"
  echo "  which is exactly how OBS's absence got masked before):"
  curl -s --max-time 5 "http://127.0.0.1:${PORT}/health" \
    | python3 -c "import sys,json;[print('     -',c['addr'],'|',c['ua'][:70]) for c in json.load(sys.stdin).get('clients',[])]" 2>/dev/null
  echo
  echo "  If bubbles still aren't showing, the page is loading but not"
  echo "  rendering. Two things to try:"
  echo
  echo "    1. Point the Browser Source at the TEST URL:"
  echo "         http://localhost:${PORT}/obs-overlay?test=1"
  echo "       That draws a bubble immediately, bypassing both the WebSocket"
  echo "       and the CSS animations. If OBS shows it, the source is fine and"
  echo "       the problem is delivery/timing. If OBS shows nothing, the"
  echo "       problem is the source itself — size, position, visibility, or a"
  echo "       filter. Remove ?test=1 afterwards."
  echo
  echo "    2. Right-click the source → Interact, to see what it renders."
  exit 0
fi

bad "No overlay is connected (obsClients: 0)"

# 2. Watch for a fetch.
LOG="logs/latest.log"
if [ ! -e "$LOG" ]; then
  info "No log file yet — start the server with scripts/start-overlay.sh"
  exit 1
fi
BEFORE=$(grep -c "Overlay page requested" "$LOG" 2>/dev/null || echo 0)

echo
info "Now: in OBS, right-click your Browser Source and choose REFRESH."
info "Watching for 45 seconds..."
echo

for _ in $(seq 45); do
  sleep 1
  AFTER=$(grep -c "Overlay page requested" "$LOG" 2>/dev/null || echo 0)
  if [ "$AFTER" -gt "$BEFORE" ]; then
    echo
    ok "OBS fetched the page:"
    grep "Overlay page requested" "$LOG" | tail -1 | sed 's/^/     /'
    sleep 2
    NOW=$(curl -s --max-time 5 "http://127.0.0.1:${PORT}/health" \
      | sed -n 's/.*"obsClients":[[:space:]]*\([0-9]*\).*/\1/p')
    if [ "${NOW:-0}" -gt 0 ]; then
      ok "And its WebSocket connected. The overlay is working."
    else
      bad "But its WebSocket did NOT connect — the page loaded and the script failed."
      echo "     Check the source's console: right-click → Interact, then look for errors."
    fi
    exit 0
  fi
done

echo
bad "OBS never fetched the page."
cat <<'EOF'

  The request is not reaching the server at all, so this is not the overlay
  code — it is something between OBS and localhost. In likely order:

  1. OBS started BEFORE this server. OBS loads the URL once at launch; if
     nothing answered, it shows an error page and never retries.
     Permanent fix: tick "Local File" in the Browser Source and point it at
        <this folder>/frontend/obs/obs-overlay.html
     A local file always loads and reconnects on its own.
     Quick fix right now: right-click the source -> Refresh.

  2. macOS Local Network permission (this Mac runs macOS 26/27, which
     enforces it). System Settings → Privacy & Security → Local Network →
     make sure OBS is listed and ON. A denied app fails silently.
     If OBS is not listed at all, quit OBS, reopen, and refresh the source
     to trigger the prompt.

  3. Try 127.0.0.1 instead of localhost in the URL:
        http://127.0.0.1:3000/obs-overlay
     This skips hostname resolution, which is what the permission check
     tends to catch.

  4. The source is hidden (eye icon off), or lives in a scene you are not
     showing, with "Shutdown source when not visible" ticked.

  5. OBS's browser subprocess crashed. Quit OBS fully and reopen.
EOF
exit 1
