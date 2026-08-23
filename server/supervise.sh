#!/bin/sh
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

# Install or remove the supervision that brings heartbeat back after a crash or a
# server reboot. Two mechanisms, chosen per host:
#
#   systemd -- a user service (heartbeat.service, or heartbeat-<flavor> for a
#              home beside the default one) with Restart=always and linger on.
#              heartbeat runs in --foreground under it, so the journald gets
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

# One box can run two daemons -- the real `~/.caden` and a `~/.caden-dev`
# beside it -- so the unit and the crontab tag are per-home. They used to be
# fixed names: installing supervision for the development home rewrote
# production's ExecStart and left the real daemon unsupervised, and the next
# reboot brought back only whichever home had been installed last.
#
# `~/.caden` keeps the original names, and so does any other home. Renaming the
# unit under an install already running would orphan the service it is running
# under, so only the `~/.caden-<flavor>` siblings this convention introduces
# take a suffix. The suffix sits in the middle of the crontab tag rather than at
# the end, so that grepping one tag out never also strips the other's lines.
case "$(basename "$HOME_DIR")" in
  .caden-*) SUFFIX="-$(basename "$HOME_DIR" | sed 's/^\.caden-//')" ;;
  *)        SUFFIX="" ;;
esac
SERVICE="heartbeat$SUFFIX"

UNIT_DIR="${CADEN_UNIT_DIR:-$HOME/.config/systemd/user}"
UNIT="$UNIT_DIR/$SERVICE.service"
SYSTEMCTL="${CADEN_SYSTEMCTL:-systemctl}"
LOGINCTL="${CADEN_LOGINCTL:-loginctl}"
CRON="${CADEN_CRON_CMD:-crontab}"
TAG="heartbeat$SUFFIX-supervise"
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

# A line is ours only if it carries our tag *and* names our home. The tag
# alone is not enough: every home whose basename falls outside the
# `.caden-<flavor>` convention shares `heartbeat-supervise` with `~/.caden`,
# so uninstalling supervision for, say, `~/.caden-test/supervise` used to grep
# production's two lines out along with its own -- and with nothing left,
# `cron_uninstall` went on to remove the whole crontab. The lines have carried
# `--home <dir> --port` since the first release, so an existing crontab
# written by an older build still matches.
#
# `case` rather than `grep`, because a home path is not a regular expression.
is_our_cron_line() {
  case "$1" in
    *"# $TAG") ;;
    *) return 1 ;;
  esac
  case "$1" in
    *" --home $HOME_DIR --port "*) return 0 ;;
    *) return 1 ;;
  esac
}

cron_current() {
  "$CRON" -l 2>/dev/null | while IFS= read -r line; do
    is_our_cron_line "$line" && continue
    printf '%s\n' "$line"
  done
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
Description=Caden daemon ($SERVICE, $HOME_DIR)
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
  tmp="$UNIT_DIR/$SERVICE.service.tmp"
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
  "$SYSTEMCTL" --user enable "$SERVICE.service" >/dev/null 2>&1 || true
  # A daemon started the old way (bootstrap's own daemonize) may hold the
  # port. systemd cannot kill what it did not start, so stop it explicitly;
  # then (re)start. When the service already owns the port, restart is a
  # clean stop+start of the systemd process.
  if [ "$changed" -eq 1 ] || ! "$SYSTEMCTL" --user is-active --quiet "$SERVICE" 2>/dev/null; then
    "$PY" "$HOME_DIR/heartbeat.py" --stop --port "$PORT" >/dev/null 2>&1 || true
    "$SYSTEMCTL" --user reset-failed "$SERVICE" >/dev/null 2>&1 || true
    "$SYSTEMCTL" --user restart "$SERVICE"
  fi
  SUPERVISOR="systemd"
}

systemd_uninstall() {
  systemctl_usable || return 0
  "$SYSTEMCTL" --user disable --now "$SERVICE" >/dev/null 2>&1 || true
  rm -f "$UNIT"
  "$SYSTEMCTL" --user daemon-reload >/dev/null 2>&1 || true
  "$SYSTEMCTL" --user reset-failed "$SERVICE" >/dev/null 2>&1 || true
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
