#!/bin/bash
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

# Full test sweep.  Nothing here needs model credentials: the session pipeline
# is exercised through the built-in mock engine and the installer through
# synthetic artifacts.
#
#   tests/run-all.sh
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${CADEN_TEST_PORT:-17845}"
HOME_DIR="${CADEN_TEST_HOME:-$HOME/.caden-test}"
FAILED=0

step() { printf "\n\033[1m== %s\033[0m\n" "$1"; }
result() {
  if [ "$1" -eq 0 ]; then printf "   \033[32mpass\033[0m %s\n" "$2"
  else printf "   \033[31mfail\033[0m %s\n" "$2"; FAILED=1; fi
}

step "daemon selftest (mock engine, session pipeline)"
CADEN_HOME="$HOME_DIR/selftest" python3 server/heartbeat.py --selftest 2>/dev/null
result $? "heartbeat --selftest"

step "offline engine install (upload, artifact shapes, codex companion)"
python3 tests/offline_install_test.py --port "$PORT" --home "$HOME_DIR/install"
result $? "offline_install_test.py"

step "bootstrap script (provisioning, idempotent restart)"
BOOT="$HOME_DIR/bootstrap"
rm -rf "$BOOT"; mkdir -p "$BOOT"; cp server/heartbeat.py "$BOOT/"
OUT=$(sh server/bootstrap.sh --home "$BOOT" --port $((PORT + 1)) 2>&1 | tail -1)
echo "$OUT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); sys.exit(0 if d.get('ok') and d.get('token') else 1)"
result $? "bootstrap returns a usable token"
OUT2=$(sh server/bootstrap.sh --home "$BOOT" --port $((PORT + 1)) 2>&1 | tail -1)
[ "$(echo "$OUT" | python3 -c 'import json,sys;print(json.loads(sys.stdin.read())["token"])')" = \
  "$(echo "$OUT2" | python3 -c 'import json,sys;print(json.loads(sys.stdin.read())["token"])')" ]
result $? "re-running bootstrap reuses the daemon and token"

# Restarting used to walk one port forward every time, because the port the
# daemon had just released still read as busy. The client records the port it
# was told, so each drift left it addressing a daemon that was no longer there.
OUT3=$(sh server/bootstrap.sh --home "$BOOT" --port $((PORT + 1)) --restart 2>&1 | tail -1)
OUT4=$(sh server/bootstrap.sh --home "$BOOT" --port $((PORT + 1)) --restart 2>&1 | tail -1)
PORTS=$(for o in "$OUT" "$OUT3" "$OUT4"; do
          echo "$o" | python3 -c 'import json,sys;print(json.loads(sys.stdin.read())["port"])'
        done | sort -u | wc -l)
[ "$PORTS" -eq 1 ]
result $? "restarting reuses the port instead of walking forward"
sh server/bootstrap.sh --home "$BOOT" --port $((PORT + 1)) --stop >/dev/null 2>&1

# A daemon left behind under some other name. `--status` only knows
# `heartbeat.pid`, so a predecessor that wrote `legacyd.pid` reads as
# "nothing running here", and bootstrap would start a second daemon on the same
# home: two processes, one set of sessions, and a client talking to whichever
# it was pointed at. Its own home, so nothing else in this file can muddy it.
OLD="$HOME_DIR/superseded"
rm -rf "$OLD"; mkdir -p "$OLD"; cp server/heartbeat.py "$OLD/legacyd.py"
CADEN_HOME="$OLD" python3 "$OLD/legacyd.py" --port $((PORT + 8)) --host 127.0.0.1 >/dev/null 2>&1
sleep 1
mv "$OLD/heartbeat.pid" "$OLD/legacyd.pid" 2>/dev/null
mv "$OLD/heartbeat.port" "$OLD/legacyd.port" 2>/dev/null
OLDPID=$(cat "$OLD/legacyd.pid" 2>/dev/null || echo "")
[ -n "$OLDPID" ] && kill -0 "$OLDPID" 2>/dev/null
result $? "a daemon under the old name is running"

cp server/heartbeat.py "$OLD/heartbeat.py"
sh server/bootstrap.sh --home "$OLD" --port $((PORT + 9)) >/dev/null 2>&1
! kill -0 "$OLDPID" 2>/dev/null
result $? "bootstrap stops the daemon it supersedes"
[ "$(pgrep -f "$OLD/" | wc -l | tr -d ' ')" = "1" ]
result $? "and leaves exactly one daemon on the home"
[ ! -f "$OLD/legacyd.pid" ] && [ ! -f "$OLD/legacyd.port" ]
result $? "the superseded records are cleared"
sh server/bootstrap.sh --home "$OLD" --port $((PORT + 9)) --stop >/dev/null 2>&1
pkill -f "$OLD/" >/dev/null 2>&1 || true

pkill -f "$BOOT/" >/dev/null 2>&1 || true

step "flavors (the dev install shares nothing, the real one has not moved)"
node tests/flavor_test.cjs
result $? "flavor_test.cjs"

step "SSH provisioning payload (exact file bytes)"
node tests/provision-upload_test.cjs
result $? "provision-upload_test.cjs"

step "detached engines (survive a daemon restart)"
python3 tests/detach_test.py --home "$HOME_DIR/detach" >/dev/null 2>&1
result $? "detach_test.py"

step "supervision (systemd unit, cron watchdog, crash recovery)"
python3 tests/supervise_test.py --home "$HOME_DIR/supervise" --port $((PORT + 3)) >/dev/null 2>&1
result $? "supervise_test.py"

step "file permissions (a shared box cannot read the session tree)"
python3 tests/permissions_test.py >/dev/null 2>&1
result $? "permissions_test.py"

step "the console over HTTP (served, cached, and no way out of the web root)"
python3 tests/console_serving_test.py >/dev/null 2>&1
result $? "console_serving_test.py"

step "event stream (the terminal event survives the close)"
python3 tests/stream_close_test.py
result $? "stream_close_test.py"

step "engine wiring (code-mode host on PATH, seeded config cannot reroute)"
python3 tests/engine_wiring_test.py
result $? "engine_wiring_test.py"

step "turn ownership (work that outlives the turn it started in)"
python3 tests/turn_ownership_test.py
result $? "turn_ownership_test.py"

step "/goal on the claude side (the CLI's own answers, and asking again)"
python3 tests/goal_claude_test.py >/dev/null 2>&1
result $? "goal_claude_test.py"

step "/goal against a codex that runs turns of its own"
python3 tests/goal_test.py --home "$HOME_DIR/goal" --port $((PORT + 4)) >/dev/null 2>&1
result $? "goal_test.py"

step "client (HTTP, SSE, transcript reduction, routing)"
CLIENT_HOME="$HOME_DIR/client"
rm -rf "$CLIENT_HOME"; mkdir -p "$CLIENT_HOME"; cp server/heartbeat.py "$CLIENT_HOME/"
CADEN_HOME="$CLIENT_HOME" python3 "$CLIENT_HOME/heartbeat.py" --port $((PORT + 2)) >/dev/null 2>&1
TOKEN=$(CADEN_HOME="$CLIENT_HOME" python3 "$CLIENT_HOME/heartbeat.py" --print-token)
node tests/client-test.mjs --url "http://127.0.0.1:$((PORT + 2))" --token "$TOKEN"
result $? "client-test.mjs"
CADEN_HOME="$CLIENT_HOME" python3 "$CLIENT_HOME/heartbeat.py" --stop >/dev/null 2>&1

step "end-to-end (renderer in a real browser, mock engine)"
if node -e "require.resolve('playwright')" >/dev/null 2>&1; then
  node tests/e2e/session.mjs
  result $? "e2e (playwright)"
  node tests/e2e/narrow.mjs
  result $? "e2e narrow (phone-sized viewport, touch pointer)"
  node tests/e2e/gateway.mjs
  result $? "e2e gateway (served by a proxy, with the Mac switched off)"
else
  echo "   skip  e2e -- npm install && npx playwright install chromium"
fi

printf "\n"
if [ "$FAILED" -eq 0 ]; then printf "\033[32mall checks passed\033[0m\n"; else printf "\033[31msome checks failed\033[0m\n"; fi
exit "$FAILED"
