#!/bin/bash
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

# Development helper: runs a heartbeat instance locally and points the app at it in
# "direct HTTP" mode, so the UI can be exercised without a server or a tunnel.
#
# It writes ~/Library/Application Support/Caden/config.json and one keychain item
# under the service "app.caden.secrets".  `scripts/dev-seed.sh --clean` undoes both.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${CADEN_DEV_PORT:-17838}"
DEV_HOME="${CADEN_DEV_HOME:-$HOME/.caden-dev}"
SUPPORT="$HOME/Library/Application Support/Caden"
CONFIG="$SUPPORT/config.json"
SERVICE="app.caden.secrets"

if [ "${1:-}" = "--clean" ]; then
  CADEN_HOME="$DEV_HOME" python3 server/heartbeat.py --port "$PORT" --stop >/dev/null 2>&1 || true
  if [ -f "$CONFIG" ]; then
    uuid=$(python3 -c "import json;d=json.load(open('$CONFIG'));print((d.get('servers') or [{}])[0].get('id',''))" 2>/dev/null || echo "")
    [ -n "$uuid" ] && security delete-generic-password -s "$SERVICE" -a "server.$uuid" >/dev/null 2>&1 || true
    rm -f "$CONFIG"
  fi
  echo "cleaned dev config, keychain item and daemon"
  exit 0
fi

mkdir -p "$DEV_HOME" "$SUPPORT"
cp server/heartbeat.py "$DEV_HOME/heartbeat.py"
CADEN_HOME="$DEV_HOME" sh server/bootstrap.sh --home "$DEV_HOME" --port "$PORT" >/dev/null
TOKEN=$(CADEN_HOME="$DEV_HOME" python3 server/heartbeat.py --print-token)

python3 - "$CONFIG" "$PORT" <<'PY'
import json, os, sys, uuid
config_path, port = sys.argv[1], int(sys.argv[2])
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
    "remoteHome": "~/.caden-dev", "remotePort": port, "localPort": 0,
    # Point straight at the daemon's own token file, so the dev profile needs
    # no keychain item at all.
    "tokenFile": os.path.join(os.path.expanduser("~/.caden-dev"), "token"),
    "provisioned": True,
})
cfg["servers"] = servers
cfg.setdefault("models", [])
cfg.setdefault("defaultWorkdir", os.path.expanduser("~"))
cfg.setdefault("defaultPermissionMode", "bypassPermissions")
cfg["lastServer"] = dev["id"]
json.dump(cfg, open(config_path, "w"), indent=2, sort_keys=True)
print(dev["id"])
PY

UUID=$(python3 -c "import json;d=json.load(open('$CONFIG'));print([s for s in d['servers'] if s['name']=='localhost (dev)'][0]['id'])")
# The dev profile reads its token straight from the daemon's token file, so no
# keychain item is created at all.
security delete-generic-password -s "$SERVICE" -a "server.$UUID" >/dev/null 2>&1 || true

echo "dev daemon on 127.0.0.1:$PORT  (home $DEV_HOME)"
echo "server profile: $UUID"
