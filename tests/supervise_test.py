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
    # The fake crontab goes on PATH as well as being passed by name, because
    # naming it is not enough. `supervise.sh uninstall` tears down both
    # mechanisms whichever one installed the supervision, so the systemd walk
    # reaches the crontab too -- and its env set CADEN_SYSTEMCTL but not
    # CADEN_CRON_CMD, which left `crontab` resolving to the real binary. On a
    # machine whose own `~/.caden` is supervised by cron that is not a stray
    # write, it is the developer's production watchdog: same tag, so uninstall
    # stripped those lines, and with nothing left it ran `crontab -r`.
    #
    # A shim directory means a walk that forgets the variable still cannot
    # reach the real one, which is the property worth having -- the next walk
    # someone adds will forget it too.
    shim = os.path.join(tmp, "shim")
    os.makedirs(shim)
    fake_cron = write_fake(shim, "crontab", FAKE_CRONTAB)
    fake_sys = write_fake(tmp, "systemctl", FAKE_SYSTEMCTL)
    os.environ["PATH"] = shim + os.pathsep + os.environ["PATH"]
    # And somewhere for the shim to write when nobody said where.
    os.environ["CADEN_FAKE_CRONTAB"] = os.path.join(tmp, "crontab-unclaimed.txt")

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

    # ------------------------------------------- two homes on the same box
    #
    # A development daemon in `~/.caden-dev` beside the real one in `~/.caden`.
    # Both used to install `heartbeat.service`, so supervising the second
    # rewrote the first's ExecStart and left the real daemon unsupervised: the
    # next reboot brought back only whichever had been installed last, pointing
    # at the wrong home, with production's sessions sitting in the other one.
    print("== two daemon homes on one box")
    two = os.path.join(tmp, "two")
    prod_home = os.path.join(two, ".caden")
    dev_home = os.path.join(two, ".caden-dev")
    unit_dir = os.path.join(tmp, "systemd-two")
    for h in (prod_home, dev_home):
        os.makedirs(h)
        shutil.copy(os.path.join(SERVER, "heartbeat.py"), os.path.join(h, "heartbeat.py"))
    env = dict(os.environ, CADEN_SUPERVISOR="systemd", CADEN_UNIT_DIR=unit_dir,
               CADEN_SYSTEMCTL=fake_sys, CADEN_LOGINCTL="true",
               CADEN_FAKE_SYS_LOG=os.path.join(tmp, "sys2.log"),
               CADEN_FAKE_SYS_STATE=os.path.join(tmp, "sys2.state"))
    for h, p in ((prod_home, port + 6), (dev_home, port + 7)):
        subprocess.run(sup + ["install", "--home", h, "--port", str(p),
                              "--python", "/usr/bin/python3"],
                       env=env, capture_output=True, text=True)

    prod_unit = os.path.join(unit_dir, "heartbeat.service")
    dev_unit = os.path.join(unit_dir, "heartbeat-dev.service")
    check("the default home keeps heartbeat.service", os.path.exists(prod_unit))
    check("the dev home gets its own unit", os.path.exists(dev_unit))
    if os.path.exists(prod_unit) and os.path.exists(dev_unit):
        check("each unit runs its own home",
              prod_home in open(prod_unit).read()
              and dev_home in open(dev_unit).read()
              and ".caden-dev" not in open(prod_unit).read().replace(dev_home, ""))

    # Uninstalling one must leave the other supervised.
    subprocess.run(sup + ["uninstall", "--home", dev_home],
                   env=env, capture_output=True, text=True)
    check("removing dev leaves production's unit", os.path.exists(prod_unit)
          and not os.path.exists(dev_unit))
    subprocess.run(sup + ["uninstall", "--home", prod_home],
                   env=env, capture_output=True, text=True)

    # Same question for the crontab, where both tags live in one file. The
    # discriminator sits in the middle of the tag so that grepping one out
    # cannot also strip the other's lines.
    cron_tab = os.path.join(tmp, "crontab-two.txt")
    env = dict(os.environ, CADEN_SUPERVISOR="cron", CADEN_CRON_CMD=fake_cron,
               CADEN_FAKE_CRONTAB=cron_tab,
               CADEN_UNIT_DIR=os.path.join(tmp, "no-unit-here"))
    for h, p in ((prod_home, port + 6), (dev_home, port + 7)):
        subprocess.run(sup + ["install", "--home", h, "--port", str(p),
                              "--python", sys.executable],
                       env=env, capture_output=True, text=True)
    lines = cron_lines(cron_tab)
    check("four crontab lines, two per home", len(lines) == 4, str(len(lines)))
    check("distinct tags",
          sum("heartbeat-supervise" in l for l in lines) == 2
          and sum("heartbeat-dev-supervise" in l for l in lines) == 2, str(lines))
    subprocess.run(sup + ["uninstall", "--home", dev_home],
                   env=env, capture_output=True, text=True)
    lines = cron_lines(cron_tab) if os.path.exists(cron_tab) else []
    check("removing dev leaves production's crontab lines",
          len(lines) == 2 and all("heartbeat-supervise" in l for l in lines),
          str(lines))
    subprocess.run(sup + ["uninstall", "--home", prod_home],
                   env=env, capture_output=True, text=True)

    # A home outside the `.caden-<flavor>` convention -- a test home, a custom
    # one -- gets no suffix, so it carries the *same* tag as `~/.caden`.
    # Removing its supervision used to grep out every line with that tag,
    # production's included, and then delete the crontab because nothing was
    # left. The tag cannot be the discriminator; the home has to be.
    odd_home = os.path.join(two, "somewhere-else")
    os.makedirs(odd_home)
    cron_tab = os.path.join(tmp, "crontab-shared-tag.txt")
    env = dict(os.environ, CADEN_SUPERVISOR="cron", CADEN_CRON_CMD=fake_cron,
               CADEN_FAKE_CRONTAB=cron_tab,
               CADEN_UNIT_DIR=os.path.join(tmp, "no-unit-here"))
    for h, p_ in ((prod_home, port + 6), (odd_home, port + 7)):
        subprocess.run(sup + ["install", "--home", h, "--port", str(p_),
                              "--python", sys.executable],
                       env=env, capture_output=True, text=True)
    check("both homes install under one tag",
          sum("heartbeat-supervise" in l for l in cron_lines(cron_tab)) == 4,
          str(cron_lines(cron_tab)))
    subprocess.run(sup + ["uninstall", "--home", odd_home],
                   env=env, capture_output=True, text=True)
    lines = cron_lines(cron_tab) if os.path.exists(cron_tab) else []
    check("removing a same-tag home leaves the other's lines",
          len(lines) == 2 and all(prod_home in l for l in lines), str(lines))
    check("and does not delete the crontab", os.path.exists(cron_tab))
    subprocess.run(sup + ["uninstall", "--home", prod_home],
                   env=env, capture_output=True, text=True)

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
