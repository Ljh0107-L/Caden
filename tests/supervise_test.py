#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""Supervision: the daemon comes back after a crash or a reboot.

Four walks: the cron watchdog's crontab management (idempotent, removable),
the systemd unit's content and call sequence (against a fake systemctl, so it
runs on a Mac too), heartbeat's own --foreground mode, and the whole thing end to
end -- bootstrap --supervise, a simulated crash, and the watchdog bringing the
daemon back on the same port.

  python3 tests/supervise_test.py --home /tmp/caden-supervise --port 17848
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "server")

failed = []


def until(pred, timeout=8.0):
    """Wait for an asynchronous result instead of guessing how long it takes."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.05)
    return False


def check(label, ok, detail=""):
    print("  %s   %s%s" % ("ok  " if ok else "FAIL", label,
                           " -- %s" % detail if detail else ""))
    if not ok:
        failed.append(label)


def listening(port):
    try:
        socket.create_connection(("127.0.0.1", port), 1).close()
        return True
    except OSError:
        return False


def write_fake(dirname, name, body):
    path = os.path.join(dirname, name)
    with open(path, "w") as fh:
        fh.write(body)
    os.chmod(path, 0o755)
    return path


FAKE_CRONTAB = """#!/bin/sh
# A crontab that keeps its content in $CADEN_FAKE_CRONTAB instead of a spool.
case "${1:-}" in
  -l) cat "$CADEN_FAKE_CRONTAB" 2>/dev/null || exit 1 ;;
  -r) rm -f "$CADEN_FAKE_CRONTAB" ;;
  *)  cp "$1" "$CADEN_FAKE_CRONTAB" ;;
esac
"""

FAKE_SYSTEMCTL = """#!/bin/sh
# Records every call and fakes active/inactive state in a file.
echo "$*" >> "$CADEN_FAKE_SYS_LOG"
verb=""
for a in "$@"; do
  case "$a" in
    daemon-reload|enable|disable|start|stop|restart|reset-failed|is-active|show-environment) verb="$a" ;;
  esac
done
case "$verb" in
  is-active|show-environment)
    [ "$(cat "$CADEN_FAKE_SYS_STATE" 2>/dev/null)" = "active" ] && exit 0 || exit 3 ;;
  start|restart) echo active > "$CADEN_FAKE_SYS_STATE"; exit 0 ;;
  stop) echo inactive > "$CADEN_FAKE_SYS_STATE"; exit 0 ;;
  *) exit 0 ;;
esac
"""


def cron_lines(path):
    with open(path) as fh:
        return [l for l in fh.read().splitlines() if l.strip()]


def main():
    home = "/tmp/caden-supervise-test"
    port = 17848
    for i, a in enumerate(sys.argv):
        if a == "--home" and i + 1 < len(sys.argv):
            home = sys.argv[i + 1]
        if a == "--port" and i + 1 < len(sys.argv):
            port = int(sys.argv[i + 1])

    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(home)
    for name in ("heartbeat.py", "bootstrap.sh", "supervise.sh"):
        shutil.copy(os.path.join(SERVER, name), os.path.join(home, name))
    tmp = tempfile.mkdtemp(prefix="caden-sup-")
    fake_cron = write_fake(tmp, "crontab", FAKE_CRONTAB)
    fake_sys = write_fake(tmp, "systemctl", FAKE_SYSTEMCTL)

    # ------------------------------------------------------- cron watchdog
    print("== cron watchdog")
    cron_tab = os.path.join(tmp, "crontab.txt")
    env = dict(os.environ, CADEN_SUPERVISOR="cron", CADEN_CRON_CMD=fake_cron,
               CADEN_FAKE_CRONTAB=cron_tab,
               CADEN_UNIT_DIR=os.path.join(tmp, "no-unit-here"))
    sup = [ "sh", os.path.join(home, "supervise.sh") ]
    args = ["install", "--home", home, "--port", str(port),
            "--python", sys.executable]

    r = subprocess.run(sup + args, env=env, capture_output=True, text=True)
    check("install exits 0", r.returncode == 0, r.stderr.strip())
    out = json.loads(r.stdout.strip().splitlines()[-1])
    check("reports the cron mechanism", out.get("supervisor") == "cron", str(out))
    lines = cron_lines(cron_tab) if os.path.exists(cron_tab) else []
    check("two crontab lines", len(lines) == 2, str(lines))
    check("reboot + per-minute watchdog",
          any(l.startswith("@reboot") for l in lines)
          and any(l.startswith("* * * * *") for l in lines))
    check("port baked in", all(str(port) in l for l in lines))
    check("tagged for removal", all("heartbeat-supervise" in l for l in lines))

    subprocess.run(sup + args, env=env, capture_output=True, text=True)
    check("install is idempotent", len(cron_lines(cron_tab)) == 2)

    r = subprocess.run(sup + ["uninstall", "--home", home],
                       env=env, capture_output=True, text=True)
    check("uninstall exits 0", r.returncode == 0, r.stderr.strip())
    check("crontab cleaned", not os.path.exists(cron_tab)
          or len(cron_lines(cron_tab)) == 0)

    # ------------------------------------------------ no supervisor available
    print("== no supervisor available")
    no_cron_env = dict(os.environ, CADEN_SUPERVISOR="cron",
                       CADEN_CRON_CMD=os.path.join(tmp, "missing-crontab"),
                       CADEN_UNIT_DIR=os.path.join(tmp, "no-unit-here"))
    r = subprocess.run(sup + args, env=no_cron_env,
                       capture_output=True, text=True)
    check("missing crontab is non-fatal", r.returncode == 0, r.stderr.strip())
    if r.returncode == 0:
        out = json.loads(r.stdout.strip().splitlines()[-1])
        check("reports no supervisor", out.get("supervisor") == "none", str(out))

    # ----------------------------------------------------- systemd service
    print("== systemd user service")
    unit_dir = os.path.join(tmp, "systemd-user")
    sys_log = os.path.join(tmp, "sys.log")
    sys_state = os.path.join(tmp, "sys.state")
    env = dict(os.environ, CADEN_SUPERVISOR="systemd", CADEN_UNIT_DIR=unit_dir,
               CADEN_SYSTEMCTL=fake_sys, CADEN_LOGINCTL="true",
               CADEN_FAKE_SYS_LOG=sys_log, CADEN_FAKE_SYS_STATE=sys_state)
    unit_path = os.path.join(unit_dir, "heartbeat.service")
    args = ["install", "--home", home, "--port", str(port + 1),
            "--python", "/usr/bin/python3"]

    r = subprocess.run(sup + args, env=env, capture_output=True, text=True)
    check("install exits 0", r.returncode == 0, r.stderr.strip())
    out = json.loads(r.stdout.strip().splitlines()[-1])
    check("reports the systemd mechanism", out.get("supervisor") == "systemd")
    check("unit file written", os.path.exists(unit_path))
    unit = open(unit_path).read()
    check("runs heartbeat in foreground", "--foreground" in unit)
    check("port and home baked in", str(port + 1) in unit and home in unit)
    check("Restart=always", "Restart=always" in unit)
    calls = open(sys_log).read()
    check("daemon-reload, enable and (re)start called",
          all(x in calls for x in ("daemon-reload", "enable", "restart")), calls)

    open(sys_log, "w").close()
    subprocess.run(sup + args, env=env, capture_output=True, text=True)
    calls = open(sys_log).read()
    check("unchanged unit does not restart", "restart" not in calls
          and "start" not in calls, calls.strip())

    open(sys_log, "w").close()
    subprocess.run(sup + ["install", "--home", home, "--port", str(port + 2),
                          "--python", "/usr/bin/python3"],
                   env=env, capture_output=True, text=True)
    check("unit rewritten on port change", str(port + 2) in open(unit_path).read())
    check("changed unit restarts", "restart" in open(sys_log).read())

    r = subprocess.run(sup + ["uninstall", "--home", home],
                       env=env, capture_output=True, text=True)
    check("uninstall exits 0", r.returncode == 0, r.stderr.strip())
    check("unit removed", not os.path.exists(unit_path))
    check("service disabled", "disable" in open(sys_log).read())

    # ------------------------------------------------------ foreground mode
    print("== heartbeat --foreground")
    fg_home = os.path.join(tmp, "fg-home")
    os.makedirs(fg_home)
    env = dict(os.environ, CADEN_HOME=fg_home)
    proc = subprocess.Popen(
        [sys.executable, os.path.join(home, "heartbeat.py"), "--foreground",
         "--port", str(port + 3)],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        check("answers ping in foreground", until(lambda: listening(port + 3)))
        check("pid file written", os.path.exists(os.path.join(fg_home, "heartbeat.pid")))
        proc.terminate()
        proc.wait(timeout=10)
        check("SIGTERM is a clean exit", proc.returncode == 0, str(proc.returncode))
        check("pid file removed on exit",
              not os.path.exists(os.path.join(fg_home, "heartbeat.pid")))
    finally:
        if proc.poll() is None:
            proc.kill()

    # --------------------------------------------- end to end with a crash
    print("== bootstrap --supervise, crash, watchdog restart")
    cron_tab = os.path.join(tmp, "crontab-e2e.txt")
    env = dict(os.environ, CADEN_SUPERVISOR="cron", CADEN_CRON_CMD=fake_cron,
               CADEN_FAKE_CRONTAB=cron_tab,
               CADEN_UNIT_DIR=os.path.join(tmp, "no-unit-here"))
    boot = ["sh", os.path.join(home, "bootstrap.sh")]

    r = subprocess.run(boot + ["--home", home, "--port", str(port + 4),
                               "--supervise"],
                       env=env, capture_output=True, text=True)
    check("bootstrap --supervise exits 0", r.returncode == 0, r.stderr.strip())
    result = json.loads(r.stdout.strip().splitlines()[-1])
    check("reports supervised", result.get("supervised") is True, str(result))
    check("reports the cron mechanism", result.get("supervisor") == "cron")
    check("daemon answers", until(lambda: listening(port + 4)))
    check("watchdog installed", len(cron_lines(cron_tab)) == 2)

    # A crash: stop the daemon the way an OOM kill would leave it -- dead, with
    # its supervision still installed.
    env_daemon = dict(os.environ, CADEN_HOME=home)
    subprocess.run([sys.executable, os.path.join(home, "heartbeat.py"), "--stop",
                    "--port", str(port + 4)],
                   env=env_daemon, capture_output=True, text=True)
    check("daemon is down", until(lambda: not listening(port + 4)))

    # This is exactly the line the cron watchdog runs every minute.
    r = subprocess.run(boot + ["--home", home, "--port", str(port + 4)],
                       env=env, capture_output=True, text=True)
    check("watchdog run exits 0", r.returncode == 0, r.stderr.strip())
    check("daemon is back on the same port", until(lambda: listening(port + 4)))

    # Clean up after ourselves.
    subprocess.run(sup + ["uninstall", "--home", home],
                   env=env, capture_output=True, text=True)
    subprocess.run([sys.executable, os.path.join(home, "heartbeat.py"), "--stop",
                    "--port", str(port + 4)],
                   env=env_daemon, capture_output=True, text=True)
    shutil.rmtree(tmp, ignore_errors=True)

    print()
    if failed:
        print("supervise_test: %d FAILED" % len(failed))
        for f in failed:
            print("  - %s" % f)
        return 1
    print("supervise_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
