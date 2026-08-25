#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""The daemon serving the console itself, and refusing to serve anything else.

Until now the renderer only ever came from the Mac: `app/server.js` read it off
local disk and the daemon spoke nothing but JSON. Serving it from the daemon is
what lets a phone reach a session with the laptop shut, and it puts a file path
built from a URL into a process that also runs arbitrary commands -- so the
half of this that matters is the refusals.

Three ways out of the web root are tried: `..` in the path, the same thing
percent-encoded past `unquote`, and a symlink inside the tree pointing out of
it. The last is why the check is on `realpath` and not `normpath`.

    python3 tests/console_serving_test.py [--port N]
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
SRC = os.path.join(ROOT, "server", "heartbeat.py")
WEB = os.path.join(ROOT, "app", "web")

failed = []


def check(label, ok, detail=""):
    print("  %s   %s%s" % ("ok  " if ok else "FAIL", label,
                           " - %s" % detail if detail else ""))
    if not ok:
        failed.append(label)


def get(url, token=None, headers=None):
    """Returns (status, headers, body-bytes). A 4xx is an answer, not a crash."""
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def start(home, port):
    subprocess.run([sys.executable, os.path.join(home, "heartbeat.py"),
                    "--port", str(port)], capture_output=True,
                   env=dict(os.environ, CADEN_HOME=home))
    base = "http://127.0.0.1:%d" % port
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            if get(base + "/v1/ping")[0] == 200:
                break
        except Exception:
            pass
        time.sleep(0.2)
    token = subprocess.run(
        [sys.executable, os.path.join(home, "heartbeat.py"), "--print-token"],
        capture_output=True, text=True,
        env=dict(os.environ, CADEN_HOME=home)).stdout.strip()
    return base, token


def stop(home):
    subprocess.run([sys.executable, os.path.join(home, "heartbeat.py"), "--stop"],
                   capture_output=True, env=dict(os.environ, CADEN_HOME=home))


def without_console(tmp, port):
    """A daemon provisioned before the console shipped must not change."""
    home = os.path.join(tmp, "bare")
    os.makedirs(home)
    shutil.copy(SRC, os.path.join(home, "heartbeat.py"))
    base, token = start(home, port)
    try:
        status, _, body = get(base + "/")
        check("with no web/ directory, / is still the ping alias",
              status == 200 and json.loads(body).get("service") == "heartbeat",
              "%s %s" % (status, body[:80]))
        check("and an asset is a plain 404",
              get(base + "/styles.css", token)[0] == 404)
    finally:
        stop(home)


def with_console(tmp, port):
    home = os.path.join(tmp, "served")
    os.makedirs(home)
    shutil.copy(SRC, os.path.join(home, "heartbeat.py"))
    shutil.copytree(WEB, os.path.join(home, "web"))

    # A file outside the root, and a symlink inside it that points at the file.
    # normpath cannot see this one: the path never contains `..`.
    with open(os.path.join(home, "outside.txt"), "w") as fh:
        fh.write("not yours\n")
    os.symlink(os.path.join(home, "outside.txt"),
               os.path.join(home, "web", "escape.txt"))

    base, token = start(home, port)
    try:
        status, hdrs, body = get(base + "/", token)
        check("/ serves the console", status == 200 and b"<!DOCTYPE html>" in body,
              str(status))
        check("as html", "text/html" in (hdrs.get("Content-Type") or ""),
              hdrs.get("Content-Type"))

        status, hdrs, body = get(base + "/styles.css", token)
        check("stylesheet by its own type",
              status == 200 and "text/css" in (hdrs.get("Content-Type") or ""),
              "%s %s" % (status, hdrs.get("Content-Type")))

        status, hdrs, body = get(base + "/fonts/jetbrains-mono-400.woff2", token)
        check("a font is served as a font, not as octet-stream",
              status == 200 and hdrs.get("Content-Type") == "font/woff2",
              "%s %s" % (status, hdrs.get("Content-Type")))

        # The renderer and its fonts are 340K. On the connection this feature
        # exists for, sending all of it on every open is the difference
        # between usable and not.
        etag = hdrs.get("ETag")
        check("assets carry an ETag", bool(etag), str(etag))
        if etag:
            status, _, body = get(base + "/fonts/jetbrains-mono-400.woff2", token,
                                  {"If-None-Match": etag})
            check("an unchanged asset comes back as 304 with no body",
                  status == 304 and not body, "%s %d bytes" % (status, len(body)))

        # -- the refusals ---------------------------------------------------
        check("the console needs the token like everything else",
              get(base + "/")[0] == 401, str(get(base + "/")[0]))
        check("and liveness still does not",
              get(base + "/v1/ping")[0] == 200)

        for label, path in (
                ("a path with .. in it", "/../../etc/passwd"),
                ("the same thing percent-encoded", "/%2e%2e/%2e%2e/etc/passwd"),
                ("a symlink pointing out of the tree", "/escape.txt")):
            status, _, body = get(base + path, token)
            check("%s is refused" % label, status == 403,
                  "%s %s" % (status, body[:60]))
    finally:
        stop(home)


def main():
    port = 17994
    for i, a in enumerate(sys.argv):
        if a == "--port" and i + 1 < len(sys.argv):
            port = int(sys.argv[i + 1])

    tmp = tempfile.mkdtemp(prefix="caden-console-")
    try:
        print("a daemon with no console")
        without_console(tmp, port)
        print("a daemon serving one")
        with_console(tmp, port + 1)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if failed:
        print("console_serving_test: FAILED")
        for f in failed:
            print("  - %s" % f)
        return 1
    print("console_serving_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
