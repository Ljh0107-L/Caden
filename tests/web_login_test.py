#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""Signing in to the console from a browser.

The daemon's bearer token is the right credential for a program and the wrong
one for a person: a browser cannot put a header on the navigation that loads a
page. HTTP basic auth at the proxy covered that and cost too much -- the
dialog is the browser's rather than Caden's, it appears before anything has
rendered, and Safari re-prompts on its own schedule, which ends any event
stream open at the time.

So: a password here, a session cookie, and one endpoint nginx can ask before
it serves anything. What is worth pinning is the shape of the refusals, not
the happy path.

    python3 tests/web_login_test.py [--port N]
"""

import http.client
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "server", "heartbeat.py")

failed = []


def check(label, ok, detail=""):
    print("  %s   %s%s" % ("ok  " if ok else "FAIL", label,
                           " - %s" % detail if detail else ""))
    if not ok:
        failed.append(label)


def req(base, path, method="GET", body=None, cookie=None, token=None):
    """Returns (status, headers, body). Redirects are the answer, not a step."""
    url = urllib.parse.urlsplit(base + path)
    conn = http.client.HTTPConnection(url.hostname, url.port, timeout=10)
    headers = {}
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if cookie:
        headers["Cookie"] = "caden_web=" + cookie
    if token:
        headers["Authorization"] = "Bearer " + token
    conn.request(method, url.path or "/", body=body, headers=headers)
    r = conn.getresponse()
    out = (r.status, dict(r.getheaders()), r.read().decode("utf-8", "replace"))
    conn.close()
    return out


def cookie_of(headers):
    raw = headers.get("Set-Cookie") or ""
    for part in raw.split(";"):
        k, _, v = part.strip().partition("=")
        if k == "caden_web":
            return v, raw
    return None, raw


def start(home, port):
    subprocess.run([sys.executable, os.path.join(home, "heartbeat.py"),
                    "--port", str(port)], capture_output=True,
                   env=dict(os.environ, CADEN_HOME=home))
    base = "http://127.0.0.1:%d" % port
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            if req(base, "/v1/ping")[0] == 200:
                return base
        except Exception:
            time.sleep(0.2)
    raise SystemExit("daemon did not start")


def stop(home):
    subprocess.run([sys.executable, os.path.join(home, "heartbeat.py"), "--stop"],
                   capture_output=True, env=dict(os.environ, CADEN_HOME=home))


def set_password(home, pw):
    return subprocess.run(
        [sys.executable, os.path.join(home, "heartbeat.py"), "--set-web-password"],
        input=pw + "\n", capture_output=True, text=True,
        env=dict(os.environ, CADEN_HOME=home))


def main():
    port = 17962
    for i, a in enumerate(sys.argv):
        if a == "--port" and i + 1 < len(sys.argv):
            port = int(sys.argv[i + 1])

    home = tempfile.mkdtemp(prefix="caden-weblogin-")
    shutil.copy(SRC, os.path.join(home, "heartbeat.py"))
    shutil.copytree(os.path.join(HERE, "..", "app", "web"),
                    os.path.join(home, "web"))
    try:
        base = start(home, port)

        # A console with no password is not one that lets everybody in.
        print("before a password is set")
        check("nothing verifies", req(base, "/v1/web/verify")[0] == 401)
        st, _, _ = req(base, "/v1/web/login", "POST", "password=")
        check("and an empty password does not get in", st == 401, str(st))

        print("setting one")
        r = set_password(home, "short")
        check("a short password is refused", r.returncode == 2, r.stderr.strip())
        r = set_password(home, "correct-horse-battery")
        check("a real one is accepted", r.returncode == 0, r.stderr.strip())
        mode = stat.S_IMODE(os.stat(os.path.join(home, "web-password")).st_mode)
        check("the verifier is 0600", mode == 0o600, "%04o" % mode)
        check("and is not the password",
              "correct-horse-battery" not in open(os.path.join(home, "web-password")).read())

        print("signing in")
        st, _, body = req(base, "/login")
        check("the login page is served without one", st == 200 and "<form" in body,
              str(st))
        st, _, _ = req(base, "/v1/web/login", "POST", "password=wrong")
        check("a wrong password is 401", st == 401, str(st))

        st, hdrs, _ = req(base, "/v1/web/login", "POST",
                          "password=correct-horse-battery&next=/")
        token, raw = cookie_of(hdrs)
        check("the right one redirects", st == 303, str(st))
        check("with a cookie", bool(token))
        check("HttpOnly, so script cannot read it", "HttpOnly" in raw, raw)
        check("SameSite, so another site cannot spend it",
              "SameSite=Lax" in raw, raw)
        check("the cookie verifies", req(base, "/v1/web/verify", cookie=token)[0] == 200)
        check("a made-up one does not",
              req(base, "/v1/web/verify", cookie="not-a-session")[0] == 401)

        # A login page that will redirect anywhere is how a convincing
        # phishing link gets built out of a domain someone trusts.
        print("what next= may not do")
        for evil in ("https://example.com/", "//example.com/"):
            st, hdrs, _ = req(base, "/v1/web/login", "POST",
                              "password=correct-horse-battery&next="
                              + urllib.parse.quote(evil, safe=""))
            check("it will not redirect to %s" % evil,
                  hdrs.get("Location") == "/", hdrs.get("Location"))

        # Sessions are on disk because a daemon restart is routine -- an
        # upgrade, a crash, a reboot -- and being signed out by one is not.
        print("across a restart")
        stop(home)
        base = start(home, port)
        check("the session survives the daemon restarting",
              req(base, "/v1/web/verify", cookie=token)[0] == 200)

        print("losing a phone")
        tok = open(os.path.join(home, "token")).read().strip()
        st, _, _ = req(base, "/v1/web/logout-all", "POST", token=tok)
        check("logout-all answers", st == 200, str(st))
        check("and every session is gone",
              req(base, "/v1/web/verify", cookie=token)[0] == 401)

        # Changing the password must not leave anyone signed in against the
        # old one -- that is usually why it is being changed.
        print("changing it")
        st, hdrs, _ = req(base, "/v1/web/login", "POST",
                          "password=correct-horse-battery")
        token, _ = cookie_of(hdrs)
        set_password(home, "a-different-password")
        check("an existing session does not outlive the password",
              req(base, "/v1/web/verify", cookie=token)[0] == 401)
    finally:
        stop(home)
        shutil.rmtree(home, ignore_errors=True)

    if failed:
        print("web_login_test: FAILED")
        for f in failed:
            print("  - %s" % f)
        return 1
    print("web_login_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
