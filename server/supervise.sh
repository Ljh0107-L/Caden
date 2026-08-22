#!/bin/sh
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

# Install or remove the supervision that brings heartbeat back after a crash or a
# server reboot. Two mechanisms, chosen per host:
#
#   systemd -- a user service (heartbeat.service) with Restart=always and linger
#              on. heartbeat runs in --foreground under it, so the journald gets
#              its logs and `systemctl stop` is a clean shutdown.
#   cron    -- @reboot plus a one-minute watchdog that re-runs bootstrap, which
#              is a no-op while the daemon is alive. The fallback for hosts
#              without a working systemd user bus.
#
# Everything lands in the user's own account: no root, nothing outside the
# heartbeat home but the unit file and the crontab.
#
# Test hooks (environment): CADEN_SUPERVISOR forces the mechanism
# ("systemd" | "cron"); CADEN_UNIT_DIR, CADEN_SYSTEMCTL, CADEN_LOGINCTL and
# CADEN_CRON_CMD redirect the side effects at fakes.
#
#   sh supervise.sh install   --home DIR --port N --python P [--bind ADDR]
#   sh supervise.sh uninstall --home DIR
#
# Prints one JSON line on success.

set -eu

ACTION=""
HOME_DIR=""
PORT=""
PY=""
BIND="127.0.0.1"

while [ $# -gt 0 ]; do
  case "$1" in
    install|uninstall) ACTION="$1"; shift ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --python) PY="$2"; shift 2 ;;
    --bind) BIND="$2"; shift 2 ;;
    *) echo "supervise.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$ACTION" ] || { echo "usage: supervise.sh install|uninstall --home DIR ..." >&2; exit 2; }
[ -n "$HOME_DIR" ] || { echo "supervise.sh: --home is required" >&2; exit 2; }

UNIT_DIR="${CADEN_UNIT_DIR:-$HOME/.config/systemd/user}"
UNIT="$UNIT_DIR/heartbeat.service"
SYSTEMCTL="${CADEN_SYSTEMCTL:-systemctl}"
LOGINCTL="${CADEN_LOGINCTL:-loginctl}"
CRON="${CADEN_CRON_CMD:-crontab}"
TAG="heartbeat-supervise"
SUPERVISOR="none"

systemctl_usable() {
  command -v "$SYSTEMCTL" >/dev/null 2>&1
}

# A working user bus is more than the binary existing: containers and boxes
# without a logged-in session have systemctl but no bus. show-environment
# talks to the bus and is read-only.
systemd_bus() {
  systemctl_usable && "$SYSTEMCTL" --user show-environment >/dev/null 2>&1
}

if [ -n "${CADEN_SUPERVISOR:-}" ]; then
  MECH="$CADEN_SUPERVISOR"
elif systemd_bus; then
  MECH="systemd"
else
  MECH="cron"
fi

# ------------------------------------------------------------- cron watchdog
# The port is baked in on purpose: without it the pool's "requested port
# first" rule can bring the daemon back on a different port after a crash,
# and the app's forward would address a dead socket. Re-provisioning rewrites
# these lines whenever the port does move, so they converge.
cron_line_reboot() {
  printf '@reboot sh %s/bootstrap.sh --home %s --port %s >/dev/null 2>&1 # %s\n' \
    "$HOME_DIR" "$HOME_DIR" "$PORT" "$TAG"
}
cron_line_watch() {
  printf '* * * * * sh %s/bootstrap.sh --home %s --port %s >/dev/null 2>&1 # %s\n' \
    "$HOME_DIR" "$HOME_DIR" "$PORT" "$TAG"
}

cron_current() {
  "$CRON" -l 2>/dev/null | grep -v "$TAG" || true
}

cron_install() {
  # A host without a user systemd bus or crontab can still run the daemon.
  # Supervision is an enhancement; do not turn a successful daemon start into
  # a failed provisioning operation just because neither mechanism exists.
  if ! command -v "$CRON" >/dev/null 2>&1; then
    SUPERVISOR="none"
    return 0
  fi
  tmp=$(mktemp)
  cron_current > "$tmp"
  cron_line_reboot >> "$tmp"
  cron_line_watch >> "$tmp"
  "$CRON" "$tmp"
  rm -f "$tmp"
  SUPERVISOR="cron"
}

cron_uninstall() {
  command -v "$CRON" >/dev/null 2>&1 || return 0
  tmp=$(mktemp)
  cron_current > "$tmp"
  if [ -s "$tmp" ]; then
    "$CRON" "$tmp"
  else
    # Nothing left: drop the whole crontab rather than installing an empty one.
    "$CRON" -r 2>/dev/null || true
  fi
  rm -f "$tmp"
}

# ------------------------------------------------------------------- systemd
want_unit() {
  cat <<EOF
[Unit]
Description=Caden daemon (heartbeat)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$PY $HOME_DIR/heartbeat.py --foreground --port $PORT --host $BIND
Restart=always
RestartSec=3
Environment=CADEN_HOME=$HOME_DIR

[Install]
WantedBy=default.target
EOF
}

systemd_install() {
  systemctl_usable || { echo "supervise.sh: systemd forced but systemctl is unavailable" >&2; exit 1; }
  mkdir -p "$UNIT_DIR"
  tmp="$UNIT_DIR/heartbeat.service.tmp"
  want_unit > "$tmp"
  if [ -f "$UNIT" ] && cmp -s "$tmp" "$UNIT"; then
    changed=0
  else
    mv "$tmp" "$UNIT"
    changed=1
  fi
  # Without linger the user manager (and this service) only exists while
  # someone is logged in; with it, the service starts at boot. Best effort:
  # some hosts refuse enable-linger without polkit rights, and the watchdog
  # spirit degrades to "starts on first login" there.
  if command -v "$LOGINCTL" >/dev/null 2>&1; then
    "$LOGINCTL" enable-linger "${USER:-root}" >/dev/null 2>&1 || true
  fi
  "$SYSTEMCTL" --user daemon-reload
  "$SYSTEMCTL" --user enable heartbeat.service >/dev/null 2>&1 || true
  # A daemon started the old way (bootstrap's own daemonize) may hold the
  # port. systemd cannot kill what it did not start, so stop it explicitly;
  # then (re)start. When the service already owns the port, restart is a
  # clean stop+start of the systemd process.
  if [ "$changed" -eq 1 ] || ! "$SYSTEMCTL" --user is-active --quiet heartbeat 2>/dev/null; then
    "$PY" "$HOME_DIR/heartbeat.py" --stop --port "$PORT" >/dev/null 2>&1 || true
    "$SYSTEMCTL" --user reset-failed heartbeat >/dev/null 2>&1 || true
    "$SYSTEMCTL" --user restart heartbeat
  fi
  SUPERVISOR="systemd"
}

systemd_uninstall() {
  systemctl_usable || return 0
  "$SYSTEMCTL" --user disable --now heartbeat >/dev/null 2>&1 || true
  rm -f "$UNIT"
  "$SYSTEMCTL" --user daemon-reload >/dev/null 2>&1 || true
  "$SYSTEMCTL" --user reset-failed heartbeat >/dev/null 2>&1 || true
}

# --------------------------------------------------------------------- action
if [ "$ACTION" = "uninstall" ]; then
  # Remove whatever is present; a host may have been supervised one way and
  # uninstalled from an environment that detects the other.
  systemd_uninstall
  cron_uninstall
  printf '{"ok":true,"supervisor":"removed"}\n'
  exit 0
fi

case "$MECH" in
  systemd) systemd_install ;;
  cron) cron_install ;;
  *) echo "supervise.sh: unknown mechanism: $MECH" >&2; exit 2 ;;
esac

printf '{"ok":true,"supervisor":"%s"}\n' "$SUPERVISOR"
