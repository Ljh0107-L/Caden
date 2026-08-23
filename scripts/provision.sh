#!/bin/bash
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

# Install (or restart) the Caden daemon on a server, and register it locally.
#
#   scripts/provision.sh user@host [remote-port]
#   scripts/provision.sh --flavor dev user@host
#
# Three SSH round-trips: make the directory, copy the two files, run bootstrap.
# bootstrap.sh is idempotent -- re-running it reuses a live daemon and its
# existing token, so this is also how you upgrade a server to a newer heartbeat.py.
#
# Which daemon home and which local config it touches come from the flavor
# (app/flavor.js). The default is production, because this is the documented
# way to set a machine up -- but that also means an unflagged run here upgrades
# the daemon your real sessions are living in, so it says what it is about to
# touch before it touches it. Run it from a checkout of the released tag; see
# docs/DEVELOPING.md.
set -euo pipefail
cd "$(dirname "$0")/.."

FLAVOR="prod"
TARGET=""
PORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --flavor) FLAVOR="$2"; shift 2 ;;
    --dev) FLAVOR="dev"; shift ;;
    -*) echo "provision.sh: unknown option: $1" >&2; exit 2 ;;
    *) if [ -z "$TARGET" ]; then TARGET="$1"; else PORT="$1"; fi; shift ;;
  esac
done
[ -n "$TARGET" ] || { echo "usage: provision.sh [--flavor dev] user@host [remote-port]" >&2; exit 2; }

IFS=$'\t' read -r SUPPORT REMOTE FLAVOR_PORT LABEL <<EOF
$(CADEN_FLAVOR="$FLAVOR" node -p '
const f = require("./app/flavor");
[f.support, f.remoteHome, f.defaultPort, f.label].join("\t")')
EOF
PORT="${PORT:-$FLAVOR_PORT}"
CONFIG="$SUPPORT/config.json"
SERVICE=$(CADEN_FLAVOR="$FLAVOR" node -p 'require("./app/flavor").keychainService')

echo "==> $LABEL"
echo "    server:  $TARGET  $REMOTE  port $PORT"
echo "    config:  $CONFIG"
echo

echo "==> $TARGET: preparing $REMOTE"
ssh "$TARGET" "mkdir -p $REMOTE && chmod 700 $REMOTE"

echo "==> uploading heartbeat.py, bootstrap.sh and supervise.sh"
scp -q server/heartbeat.py server/bootstrap.sh server/supervise.sh "$TARGET:$REMOTE/"

echo "==> starting the daemon on port $PORT"
OUT=$(ssh "$TARGET" "sh $REMOTE/bootstrap.sh --home $REMOTE --port $PORT --supervise" | tail -1)

ID=$(CONFIG="$CONFIG" TARGET="$TARGET" PORT="$PORT" REMOTE="$REMOTE" python3 - "$OUT" <<'PY'
import json, os, sys, uuid
result = json.loads(sys.argv[1])
if not result.get("ok"):
    sys.exit("bootstrap failed: %s" % result.get("error"))
path, target, port = os.environ["CONFIG"], os.environ["TARGET"], int(os.environ["PORT"])
remote = os.environ["REMOTE"]
user, _, host = target.rpartition("@")
os.makedirs(os.path.dirname(path), exist_ok=True)
cfg = json.load(open(path)) if os.path.exists(path) else {}
servers = cfg.setdefault("servers", [])
entry = next((s for s in servers if s.get("sshHost") == host), None)
if entry is None:
    entry = {"id": str(uuid.uuid4()).upper()}
    servers.append(entry)
entry.update({"name": host, "mode": "tunnel", "sshUser": user, "sshHost": host,
              "sshPort": 22, "remoteHome": remote, "remotePort": port,
              # The bridge falls back to remotePort when localPort is 0, so the
              # forward below has to use the same number on both ends.
              "localPort": port, "provisioned": True})
cfg.setdefault("models", [])
json.dump(cfg, open(path, "w"), indent=2, sort_keys=True)
print("%s\t%s\t%s" % (entry["id"], result["token"], result.get("hostname", host)))
PY
)
SID=$(echo "$ID" | cut -f1); TOKEN=$(echo "$ID" | cut -f2); HOSTNAME=$(echo "$ID" | cut -f3)

security add-generic-password -s "$SERVICE" -a "server.$SID" -w "$TOKEN" -U
echo "==> $HOSTNAME ready; token stored in the login keychain under $SERVICE"
echo
echo "Open the forward, then start $LABEL:"
echo "  ssh -N -L $PORT:127.0.0.1:$PORT $TARGET"
echo "  npm start"
