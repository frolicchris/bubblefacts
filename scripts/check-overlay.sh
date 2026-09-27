#!/usr/bin/env bash
# Is OBS connected to the overlay server? Run while the server is running.
#
#   bash scripts/check-overlay.sh
#
# If nothing is connected, it waits while you refresh the Browser Source in OBS.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
PORT="${PORT:-$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -dc '0-9')}"
PORT="${PORT:-3000}"
WAIT_SECONDS=45

ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

clients() {
  curl -s --max-time 5 "http://127.0.0.1:$PORT/health" | sed -n 's/.*"obsClients":\([0-9]*\).*/\1/p'
}

echo
if ! curl -s --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null; then
  bad "Nothing is answering on port $PORT. Start it with: bash scripts/start-overlay.sh"
  exit 1
fi
ok "Server responding on port $PORT"

if [ "$(clients)" -gt 0 ] 2>/dev/null; then
  ok "An overlay is connected:"
  curl -s "http://127.0.0.1:$PORT/health" |
    node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>JSON.parse(s).clients.forEach((c)=>console.log("     ",c.addr,c.ua.slice(0,70))))'
  echo "  A browser tab counts too; OBS's user agent contains \"OBS/\"."
  exit 0
fi

bad "No overlay connected"
echo "  In OBS, right-click the Browser Source and choose Refresh. Waiting ${WAIT_SECONDS}s..."
for _ in $(seq "$WAIT_SECONDS"); do
  sleep 1
  if [ "$(clients)" -gt 0 ] 2>/dev/null; then
    ok "OBS connected. The overlay is working."
    exit 0
  fi
done

bad "OBS did not connect. Likely causes, in order:"
cat <<'TIPS'

  1. The Browser Source isn't set to Local File -> frontend/obs/obs-overlay.html.
  2. macOS Local Network permission is off for OBS
     (System Settings > Privacy & Security > Local Network).
  3. The source is hidden, or in a scene that isn't live, with
     "Shutdown source when not visible" ticked.
  4. OBS's browser process crashed. Quit OBS fully and reopen it.

  To separate a rendering problem from a connection problem, open
  frontend/obs/obs-overlay.html?test=1 in a browser: it draws a bubble
  without the server.
TIPS
exit 1
