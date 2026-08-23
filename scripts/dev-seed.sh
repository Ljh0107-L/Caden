#!/bin/bash
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

# Development helper: runs a heartbeat instance locally and points the app at it in
# "direct HTTP" mode, so the UI can be exercised without a server or a tunnel.
#
#   scripts/dev-seed.sh            # seed the development install
#   scripts/dev-seed.sh --clean    # undo it
#
# Everything it writes belongs to the development flavor: the config under
# "Application Support/Caden Dev" and a daemon in ~/.caden-dev. It used to write
# the real config.json and set `lastServer`, so running it once pointed the app
# you actually use at a throwaway daemon. See app/flavor.js -- the paths below
# come from there rather than being spelled out again.
set -euo pipefail
cd "$(dirname "$0")/.."

FLAVOR="${CADEN_FLAVOR:-dev}"
IFS=$'\t' read -r SUPPORT DEV_HOME FLAVOR_PORT LABEL <<EOF
$(CADEN_FLAVOR="$FLAVOR" node -p '
const f = require("./app/flavor"), os = require("os"), path = require("path");
const home = p => p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
[f.support, home(f.remoteHome), f.defaultPort, f.label].join("\t")')
EOF

if [ "$FLAVOR" = "prod" ]; then
  echo "dev-seed.sh refuses to seed the production install." >&2
  echo "It exists to give the development app something to talk to." >&2
  exit 2
fi

PORT="${CADEN_DEV_PORT:-$FLAVOR_PORT}"
CONFIG="$SUPPORT/config.json"

if [ "${1:-}" = "--clean" ]; then
  CADEN_HOME="$DEV_HOME" python3 server/heartbeat.py --port "$PORT" --stop >/dev/null 2>&1 || true
  rm -f "$CONFIG"
  echo "cleaned $LABEL config and stopped its daemon ($DEV_HOME)"
  exit 0
fi

mkdir -p "$DEV_HOME" "$SUPPORT"
cp server/heartbeat.py "$DEV_HOME/heartbeat.py"
CADEN_HOME="$DEV_HOME" sh server/bootstrap.sh --home "$DEV_HOME" --port "$PORT" >/dev/null

python3 - "$CONFIG" "$PORT" "$DEV_HOME" <<'PY'
import json, os, sys, uuid
config_path, port, dev_home = sys.argv[1], int(sys.argv[2]), sys.argv[3]
cfg = {}
if os.path.exists(config_path):
    try:
        cfg = json.load(open(config_path))
    except Exception:
        cfg = {}
servers = cfg.get("servers") or []
dev = next((s for s in servers if s.get("name") == "localhost (dev)"), None)
if dev is None:
    dev = {"id": str(uuid.uuid4()).upper(), "name": "localhost (dev)"}
    servers.append(dev)
dev.update({
    "mode": "direct",
    "directURL": "http://127.0.0.1:%d" % port,
    "sshUser": "", "sshHost": "", "sshPort": 22,
    "identityFile": "", "jumpHost": "", "sshExtraArgs": "",
    "remoteHome": dev_home, "remotePort": port, "localPort": 0,
    # Point straight at the daemon's own token file, so the dev profile needs
    # no keychain item at all.
    "tokenFile": os.path.join(dev_home, "token"),
    "provisioned": True,
})
cfg["servers"] = servers
cfg.setdefault("models", [])
cfg.setdefault("defaultWorkdir", os.path.expanduser("~"))
cfg.setdefault("defaultPermissionMode", "bypassPermissions")
cfg["lastServer"] = dev["id"]
json.dump(cfg, open(config_path, "w"), indent=2, sort_keys=True)
PY

echo "$LABEL: daemon on 127.0.0.1:$PORT  (home $DEV_HOME)"
echo "config: $CONFIG"
echo
echo "Start it with:  npm start"
