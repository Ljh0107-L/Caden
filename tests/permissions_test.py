#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""Nothing under a daemon home is readable by another account on the box.

The daemon home and the token were 0700/0600 from the start; the session tree
underneath was not. `sessions/` shipped as 0755, and `meta.json` inside it as
0644 -- with the provider's API key written into it in clear, because meta is
saved verbatim minus the keys that start with an underscore. On a single-user
box that is invisible. On a shared one it is `cat` away, and the web UI is
about to make "the daemon holds the credentials" the normal arrangement rather
than an accident of how a session is started.

Both halves are tested: a home created now, and a home created by a daemon
from before this change, which the current one has to narrow on the way up.

    python3 tests/permissions_test.py
"""

import importlib.util
import json
import os
import shutil
import stat
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "server", "heartbeat.py")

failed = []


def check(label, ok, detail=""):
    print("  %s   %s%s" % ("ok  " if ok else "FAIL", label,
                           " - %s" % detail if detail else ""))
    if not ok:
        failed.append(label)


def mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


def check_mode(label, path, want):
    got = mode(path)
    check(label, got == want, "%s is %04o, wanted %04o" % (path, got, want))


def load_daemon(home, name):
    """Import heartbeat against `home`.

    A fresh module name per call: the module reads CADEN_HOME at import time
    into DIR_SESSIONS and friends, so two homes in one process need two
    imports rather than one cached one.
    """
    os.environ["CADEN_HOME"] = home
    spec = importlib.util.spec_from_file_location(name, SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


SPEC = {
    "title": "perm",
    "engine": "claude",
    "model": "claude-x",
    "provider": {"protocol": "anthropic-messages",
                 "base_url": "https://example.invalid",
                 "api_key": "sk-should-not-be-world-readable"},
}


def fresh_home(home):
    """A home this daemon created itself."""
    caden = load_daemon(home, "heartbeat_perm_fresh")
    caden.ensure_dirs()
    check_mode("sessions/ is 0700", caden.DIR_SESSIONS, 0o700)
    check_mode("uploads/ is 0700", caden.DIR_UPLOADS, 0o700)
    check_mode("tmp/ is 0700", caden.DIR_TMP, 0o700)

    caden.SESSIONS = caden.SessionManager()
    sess = caden.SESSIONS.create(SPEC)
    sess.save()
    meta_path = sess.path("meta.json")
    check_mode("a new session directory is 0700", sess.path(), 0o700)
    check_mode("its meta.json is 0600", meta_path, 0o600)
    check_mode("its workspace is 0700", sess.path("engine"), 0o700)

    # The reason the mode matters, asserted rather than assumed: if a later
    # change moves the credential out of meta and into a providers file, this
    # is the line that should fail and send someone to re-point the test.
    raw = open(meta_path).read()
    ok = SPEC["provider"]["api_key"] in raw
    check("meta.json is what holds the credential", ok,
          "" if ok else "no api_key in meta.json -- has it moved?")


def legacy_home(home):
    """A home laid out the way 0.1.0 left it, narrowed on the way up."""
    sessions = os.path.join(home, "sessions")
    sid = "s_0000000000000000"
    sdir = os.path.join(sessions, sid)
    os.makedirs(os.path.join(sdir, "logs"))
    meta = {"id": sid, "title": "old", "engine": "claude", "model": "claude-x",
            "state": "idle", "created_at": 1, "updated_at": 1, "turns": 0,
            "totals": {}, "archived": True,
            "provider": {"protocol": "anthropic-messages",
                         "api_key": "sk-left-behind-by-an-older-daemon"}}
    with open(os.path.join(sdir, "meta.json"), "w") as fh:
        json.dump(meta, fh)
    for p, m in ((sessions, 0o755), (sdir, 0o755),
                 (os.path.join(sdir, "logs"), 0o755),
                 (os.path.join(sdir, "meta.json"), 0o644)):
        os.chmod(p, m)

    caden = load_daemon(home, "heartbeat_perm_legacy")
    caden.ensure_dirs()
    caden.SESSIONS = caden.SessionManager()
    check("the old session still loads", sid in caden.SESSIONS.sessions)
    check_mode("sessions/ was narrowed to 0700", sessions, 0o700)
    check_mode("the old session directory was narrowed", sdir, 0o700)
    check_mode("its logs/ was narrowed", os.path.join(sdir, "logs"), 0o700)
    # Archived: nothing is going to write it again, so healing on the next
    # save would never happen. Loading has to be enough.
    check_mode("its meta.json was narrowed without a save",
               os.path.join(sdir, "meta.json"), 0o600)


def main():
    keep = os.environ.get("CADEN_HOME")
    root = tempfile.mkdtemp(prefix="caden-perm-")
    try:
        print("a home this daemon created")
        fresh_home(os.path.join(root, "fresh"))
        print("a home from before the session tree was narrowed")
        legacy_home(os.path.join(root, "legacy"))
    finally:
        shutil.rmtree(root, ignore_errors=True)
        if keep is None:
            os.environ.pop("CADEN_HOME", None)
        else:
            os.environ["CADEN_HOME"] = keep

    if failed:
        print("permissions_test: FAILED")
        for f in failed:
            print("  - %s" % f)
        return 1
    print("permissions_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
