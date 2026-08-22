#!/bin/sh
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

# Caden provisioning script.
#
# The Mac app pipes this over SSH together with heartbeat.py, runs it once, and
# parses the single JSON line printed on the last line of stdout.  Everything
# here is POSIX sh: the target may be a minimal container with no bash.
#
#   sh bootstrap.sh [--port N] [--restart] [--stop] [--status] [--home DIR]
#                   [--supervise]
#
# --supervise installs a supervisor (systemd user service, or a cron watchdog)
# when the host provides one. Hosts with neither mechanism still get a working
# daemon and report supervisor="none". See supervise.sh.
#
set -eu

PORT="${CADEN_PORT:-7838}"
HOME_DIR="${CADEN_HOME:-$HOME/.caden}"
ACTION="start"
BIND="127.0.0.1"
SUPERVISE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --bind) BIND="$2"; shift 2 ;;
    --restart) ACTION="restart"; shift ;;
    --stop) ACTION="stop"; shift ;;
    --status) ACTION="status"; shift ;;
    --supervise) SUPERVISE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

export CADEN_HOME="$HOME_DIR"
CADEN_REQUESTED_PORT="$PORT"
DAEMON="$HOME_DIR/heartbeat.py"

emit_error() {
  printf '{"ok":false,"error":"%s"}\n' "$1"
  exit 1
}

# ---------------------------------------------------------------- python
# Servers vary wildly; walk the plausible names and take the first that is
# 3.6 or newer.  heartbeat.py is written to that floor on purpose.
find_python() {
  for cand in python3 python3.13 python3.12 python3.11 python3.10 python3.9 \
              python3.8 python3.7 python3.6 /usr/bin/python3 /usr/local/bin/python3 \
              /opt/python3/bin/python3 python; do
    p=$(command -v "$cand" 2>/dev/null) || continue
    [ -n "$p" ] || continue
    if "$p" -c 'import sys; sys.exit(0 if sys.version_info >= (3,6) else 1)' 2>/dev/null; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

PY=$(find_python) || emit_error "no python3 (>=3.6) found on this host; Caden needs one to run its daemon"

mkdir -p "$HOME_DIR" "$HOME_DIR/bin" "$HOME_DIR/sessions" "$HOME_DIR/uploads" \
         "$HOME_DIR/engines" "$HOME_DIR/runtime" "$HOME_DIR/tmp" "$HOME_DIR/jobs"
chmod 700 "$HOME_DIR"

[ -f "$DAEMON" ] || emit_error "heartbeat.py missing at $DAEMON (upload it before running bootstrap)"
chmod 700 "$DAEMON"

# When supervision is installed as a systemd user service, the daemon belongs
# to systemd, not to us: stopping it ourselves just makes Restart=always bring
# it back on a different start path, and starting a second one loses the port
# fight. Route lifecycle through systemctl in that case. The unit file is the
# record of which mechanism supervise.sh installed.
SYSTEMCTL="${CADEN_SYSTEMCTL:-systemctl}"
UNIT="${CADEN_UNIT_DIR:-$HOME/.config/systemd/user}/heartbeat.service"

systemd_supervised() {
  [ -f "$UNIT" ] && command -v "$SYSTEMCTL" >/dev/null 2>&1
}

# A foreign (daemonized, pre-supervision) daemon may hold the port while the
# service is inactive. systemd cannot kill what it did not start, so do it by
# hand before asking systemd to take over.
stop_foreign_daemon() {
  "$PY" "$DAEMON" --stop --port "$PORT" >/dev/null 2>&1 || true
}

case "$ACTION" in
  stop)
    if systemd_supervised; then
      "$SYSTEMCTL" --user stop heartbeat >/dev/null 2>&1 || true
    else
      "$PY" "$DAEMON" --stop --port "$PORT" || true
    fi
    exit 0 ;;
  status)
    "$PY" "$DAEMON" --status --port "$PORT"
    exit $? ;;
  restart)
    if systemd_supervised; then
      "$SYSTEMCTL" --user is-active --quiet heartbeat 2>/dev/null || stop_foreign_daemon
      "$SYSTEMCTL" --user reset-failed heartbeat >/dev/null 2>&1 || true
      "$SYSTEMCTL" --user restart heartbeat || \
        emit_error "systemd could not restart heartbeat (journalctl --user -u heartbeat)"
    else
      "$PY" "$DAEMON" --stop --port "$PORT" >/dev/null 2>&1 || true
      CADEN_STOPPED=1
    fi ;;
esac

# ------------------------------------------------------------------ port
# If the requested port is busy but not ours, walk forward rather than
# failing: several people may share one box.
port_busy() {
  "$PY" - "$1" <<'PYCHK'
import socket, sys
s = socket.socket()
# SO_REUSEADDR because the daemon sets it too: without it a port left in
# TIME_WAIT by the daemon we just stopped reads as busy, and every restart
# would walk one port forward for the rest of the server's life.
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
    sys.exit(1)
except OSError:
    sys.exit(0)
finally:
    s.close()
PYCHK
}

# A daemon we asked to stop needs a moment to let go of its socket. Walking
# forward before it does is what made a restart land one port higher every
# time; the requested port is worth a short wait.
wait_port_free() {
  i=0
  while [ $i -lt 5 ] && port_busy "$1"; do
    sleep 1
    i=$((i + 1))
  done
}

port_listening() {
  "$PY" - "$1" <<'PYLIVE'
import socket, sys
try:
    socket.create_connection(("127.0.0.1", int(sys.argv[1])), 1).close()
except OSError:
    sys.exit(1)
PYLIVE
}

# A daemon this home is already serving under some other pid file.
#
# `--status` only knows about `heartbeat.pid`, so a predecessor that wrote its
# own -- a daemon from before a rename, say -- reads as "nothing running here".
# Bootstrap would then take a fresh port and start a second daemon on the same
# home: two processes, one set of sessions, and a client talking to whichever
# it happened to be pointed at.
#
# Any pid file but ours, naming a live process that is running out of this
# home, is that. It is stopped, and its records go with it.
stop_superseded_daemons() {
  for pidfile in "$HOME_DIR"/*.pid; do
    [ -f "$pidfile" ] || continue
    case "$pidfile" in *"/heartbeat.pid") continue ;; esac
    oldpid=$(cat "$pidfile" 2>/dev/null || echo "")
    case "$oldpid" in ''|*[!0-9]*) rm -f "$pidfile"; continue ;; esac
    if kill -0 "$oldpid" 2>/dev/null \
       && ps -o args= -p "$oldpid" 2>/dev/null | grep -q "$HOME_DIR"; then
      kill "$oldpid" 2>/dev/null || true
      i=0
      while [ $i -lt 10 ] && kill -0 "$oldpid" 2>/dev/null; do sleep 1; i=$((i + 1)); done
      kill -9 "$oldpid" 2>/dev/null || true
    fi
    base=${pidfile%.pid}
    rm -f "$pidfile" "$base.port" "$base.ports"
  done
}
stop_superseded_daemons

RUNNING=0
if STATUS=$("$PY" "$DAEMON" --status --port "$PORT" 2>/dev/null); then
  RUNNING=1
  # Adopt the port it is really on. A previous run may have walked forward off
  # a busy port, and connecting to the one we asked for would find nothing.
  PORT=$("$PY" - "$STATUS" "$PORT" <<'PYPORT'
import json, sys
try:
    print(json.loads(sys.argv[1]).get("actual_port") or sys.argv[2])
except Exception:
    print(sys.argv[2])
PYPORT
)
fi

# A live pid that is not actually listening is nothing to reuse: it may predate
# the port record, or be wedged. Stop it and start clean rather than reporting
# a daemon nobody can reach.
if [ "$RUNNING" -eq 1 ] && ! port_listening "$PORT"; then
  "$PY" "$DAEMON" --stop --port "$PORT" >/dev/null 2>&1 || true
  PORT="${CADEN_REQUESTED_PORT:-$PORT}"
  RUNNING=0
  CADEN_STOPPED=1
fi

if [ "$RUNNING" -eq 0 ]; then
  if systemd_supervised; then
    # The unit pins the port and owns the process; starting it ourselves would
    # only lose the bind to systemd's copy.
    "$SYSTEMCTL" --user reset-failed heartbeat >/dev/null 2>&1 || true
    "$SYSTEMCTL" --user start heartbeat || \
      emit_error "systemd could not start heartbeat (journalctl --user -u heartbeat)"
  else
    [ -n "${CADEN_STOPPED:-}" ] && wait_port_free "$PORT"
  # Ports come from a pool this home keeps, rather than a fresh walk forward
  # every time.  Walking meant a box where the requested port was ever busy
  # drifted upward for good, and the client's recorded address went stale with
  # it; reusing what this home has held before keeps the set small and
  # familiar, and it only grows when every port it knows is taken at once.
  PORT=$("$PY" - "$HOME_DIR" "$PORT" <<'PYPOOL'
import json, os, socket, sys

home, requested = sys.argv[1], int(sys.argv[2])
pool_path = os.path.join(home, "heartbeat.ports")


def free(port):
    s = socket.socket()
    # Matches how the daemon binds, so a port it just released does not read
    # as taken while it sits in TIME_WAIT.
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


try:
    with open(pool_path) as fh:
        pool = [int(p) for p in json.load(fh)]
except Exception:
    pool = []

# The requested port first -- it is the one the client has written down --
# then everything this home has used before, low to high.
order = [requested] + [p for p in sorted(pool) if p != requested]
chosen = next((p for p in order if free(p)), None)
if chosen is None:
    # Every port the pool knows is in use: take one more and remember it.
    start = max(order) + 1
    chosen = next((p for p in range(start, start + 40) if free(p)), None)
if chosen is None:
    sys.exit(1)

if chosen not in pool:
    pool.append(chosen)
    tmp = pool_path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(sorted(pool), fh)
    os.replace(tmp, pool_path)
print(chosen)
PYPOOL
) || emit_error "no free port for the daemon (see $HOME_DIR/heartbeat.ports)"
  CADEN_HOME="$HOME_DIR" "$PY" "$DAEMON" --port "$PORT" --host "$BIND" || \
    emit_error "daemon failed to start (see $HOME_DIR/heartbeat.log)"
  fi
fi

# ---------------------------------------------------------------- verify
i=0
while [ $i -lt 60 ]; do
  if "$PY" - "$PORT" <<'PYWAIT'
import socket, sys
try:
    socket.create_connection(("127.0.0.1", int(sys.argv[1])), 1).close()
except OSError:
    sys.exit(1)
PYWAIT
  then
    break
  fi
  i=$((i + 1))
  sleep 0.25
done
[ $i -lt 60 ] || emit_error "daemon did not come up on port $PORT; see $HOME_DIR/heartbeat.log"

TOKEN=$(CADEN_HOME="$HOME_DIR" "$PY" "$DAEMON" --print-token)
PID=$(cat "$HOME_DIR/heartbeat.pid" 2>/dev/null || echo "")

# Supervision is installed last and only when asked: it may hand the daemon
# from our own daemonize() to a systemd service, so everything above has to
# work without it first. After the handoff the pid file belongs to the new
# process, so re-read it.
SUPERVISED_JSON=""
if [ "$SUPERVISE" -eq 1 ]; then
  SUP="$HOME_DIR/supervise.sh"
  [ -f "$SUP" ] || emit_error "supervise.sh missing at $SUP (upload it before running bootstrap)"
  SUPERVISED_JSON=$(sh "$SUP" install --home "$HOME_DIR" --port "$PORT" --python "$PY" --bind "$BIND" 2>&1) || \
    emit_error "supervision install failed: $SUPERVISED_JSON"
  i=0
  while [ $i -lt 40 ]; do
    port_listening "$PORT" && break
    i=$((i + 1))
    sleep 0.25
  done
  [ $i -lt 40 ] || emit_error "daemon did not survive the supervision handoff on port $PORT"
  PID=$(cat "$HOME_DIR/heartbeat.pid" 2>/dev/null || echo "")
fi

# Single machine-readable line, last -- the Mac reads only this.
CADEN_HOME="$HOME_DIR" "$PY" - "$PORT" "$TOKEN" "$PID" "$PY" "$HOME_DIR" "$SUPERVISED_JSON" <<'PYOUT'
import json, os, platform, socket, sys
port, token, pid, py, home = sys.argv[1:6]
try:
    sup = json.loads(sys.argv[6]) if sys.argv[6] else {}
except Exception:
    sup = {}


def which(name):
    for d in [os.path.join(home, "bin"),
              os.path.join(home, "engines", "claude", "bin"),
              os.path.join(home, "engines", "codex", "bin"),
              os.path.join(os.path.expanduser("~"), ".local", "bin")] + \
             (os.environ.get("PATH") or "").split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


print(json.dumps({
    "ok": True,
    "port": int(port),
    "token": token,
    "pid": pid,
    "python": py,
    "python_version": platform.python_version(),
    "home": home,
    "hostname": socket.gethostname(),
    "os": sys.platform,
    "arch": platform.machine(),
    "user": os.environ.get("USER") or "",
    "engines": {"claude": which("claude"), "codex": which("codex"),
                "node": which("node"), "npm": which("npm")},
    "supervised": bool(sup.get("ok")
                        and sup.get("supervisor") not in (None, "none", "removed")),
    "supervisor": sup.get("supervisor"),
}))
PYOUT
