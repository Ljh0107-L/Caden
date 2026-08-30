#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""Exercises the offline engine-install path against a running heartbeat.

Builds three synthetic artifacts that mimic the shapes Caden actually uploads,
pushes each through the chunked upload endpoint, installs it, and checks that
the daemon reports the *newly installed* binary rather than an unrelated copy
that happened to be on PATH.

    python3 tests/offline_install_test.py --port 17838 --home ~/.caden-test
"""

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request


def wait_ready(port, timeout=20):
    """Block until the daemon is answering on `port`.

    Starting it returns as soon as the parent of the double fork exits, which
    is before the child has bound anything -- so the first request could be
    refused by a daemon that was seconds away from being fine. It came back as
    a connection error out of the middle of an upload, which reads like the
    upload endpoint is broken. Rare enough to look like a flake and often
    enough to lose a CI run.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(
                    "http://127.0.0.1:%d/v1/ping" % port, timeout=2) as resp:
                if resp.status == 200:
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.1)
    raise SystemExit("the daemon never answered on port %d" % port)


class Client(object):
    def __init__(self, port, token):
        self.port = port
        self.token = token

    def call(self, method, path, body=None, raw=None):
        req = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path),
                                     method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        if raw is not None:
            req.add_header("Content-Type", "application/octet-stream")
            req.data = raw
        elif body is not None:
            req.add_header("Content-Type", "application/json")
            req.data = json.dumps(body).encode()
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read().decode())

    def upload(self, path, chunk=64 * 1024):
        data = open(path, "rb").read()
        digest = hashlib.sha256(data).hexdigest()
        up = self.call("POST", "/v1/uploads",
                       {"name": os.path.basename(path), "size": len(data),
                        "sha256": digest})["upload"]
        for off in range(0, len(data), chunk):
            self.call("PUT", "/v1/uploads/%s?offset=%d" % (up["id"], off),
                      raw=data[off:off + chunk])
        done = self.call("POST", "/v1/uploads/%s/complete" % up["id"])["upload"]
        assert done["sha256"] == digest, "checksum mismatch on upload"
        return done["path"]

    def install(self, engine, artifact, companion=None):
        body = {"engine": engine, "method": "offline", "artifact": artifact}
        if companion:
            body["companion"] = companion
        job = self.call("POST", "/v1/engines/install", body)["job"]
        req = urllib.request.Request(
            "http://127.0.0.1:%d/v1/jobs/%s/events?after=0" % (self.port, job["id"]))
        req.add_header("Authorization", "Bearer " + self.token)
        steps = []
        with urllib.request.urlopen(req, timeout=300) as resp:
            for line in resp:
                line = line.decode().strip()
                if not line.startswith("data: "):
                    continue
                ev = json.loads(line[6:])
                # `event: eof` carries `{}`. Reaching it means the stream ended
                # without the terminal event, which is a bug in the stream
                # rather than something to crash a KeyError over.
                if not isinstance(ev, dict) or "type" not in ev:
                    continue
                if ev["type"] in ("step", "log") and ev.get("text"):
                    steps.append(ev["text"])
                if ev["type"] == "done":
                    return ev.get("ok"), ev.get("error"), ev.get("result") or {}, steps
        return False, "stream ended without a result", {}, steps


FAKE = """#!/bin/sh
[ "$1" = "--version" ] && echo "%s" && exit 0
echo "%s stub"
"""


def make_native_tgz(tmp, engine, version):
    """The shape of @anthropic-ai/claude-code-<platform>: package/<engine>."""
    root = os.path.join(tmp, "native", "package")
    os.makedirs(root)
    exe = os.path.join(root, engine)
    with open(exe, "w") as fh:
        fh.write(FAKE % (version, engine))
    os.chmod(exe, 0o755)
    with open(os.path.join(root, "package.json"), "w") as fh:
        json.dump({"name": engine, "version": "9.9.9"}, fh)
    out = os.path.join(tmp, "%s-linux-x64-9.9.9.tgz" % engine)
    with tarfile.open(out, "w:gz") as tf:
        tf.add(root, arcname="package")
    return out


def make_release_tar(tmp, engine, version):
    """The shape of a codex GitHub release: one binary in a top-level dir."""
    root = os.path.join(tmp, "release", "codex-x86_64-unknown-linux-musl")
    os.makedirs(root)
    exe = os.path.join(root, engine)
    with open(exe, "w") as fh:
        fh.write(FAKE % (version, engine))
    os.chmod(exe, 0o755)
    out = os.path.join(tmp, "codex-v9.9.9-codex-x86_64-unknown-linux-musl.tar.gz")
    with tarfile.open(out, "w:gz") as tf:
        tf.add(root, arcname=os.path.basename(root))
    return out


def make_codex_npm_tgz(tmp, engine, version):
    """The current host's @openai/codex platform package shape."""
    root = os.path.join(tmp, "codex-npm", "package")
    arch = "aarch64" if platform.machine().lower() in ("arm64", "aarch64") else "x86_64"
    triple = ("%s-apple-darwin" % arch if sys.platform == "darwin"
              else "%s-unknown-linux-musl" % arch)
    npm_platform = ("darwin-arm64" if arch == "aarch64" else "darwin-x64") \
        if sys.platform == "darwin" else \
        ("linux-arm64" if arch == "aarch64" else "linux-x64")
    native = os.path.join(root, "vendor", triple)
    os.makedirs(os.path.join(native, "bin"))
    os.makedirs(os.path.join(native, "codex-path"))
    os.makedirs(os.path.join(native, "codex-resources"))
    for name, reported in (("codex", version),
                           ("codex-code-mode-host", "host 9.9.9")):
        exe = os.path.join(native, "bin", name)
        with open(exe, "w") as fh:
            fh.write(FAKE % (reported, name))
        os.chmod(exe, 0o755)
    with open(os.path.join(native, "codex-path", "rg"), "w") as fh:
        fh.write("resource kept")
    with open(os.path.join(root, "package.json"), "w") as fh:
        json.dump({"name": "@openai/codex", "version": "9.9.9-" + npm_platform}, fh)
    out = os.path.join(tmp, "codex-9.9.9-%s.tgz" % npm_platform)
    with tarfile.open(out, "w:gz") as tf:
        tf.add(root, arcname="package")
    return out


def make_companion_tar(tmp, version):
    """The shape of the codex-code-mode-host release asset."""
    root = os.path.join(tmp, "host", "codex-code-mode-host-x86_64-unknown-linux-musl")
    os.makedirs(root)
    exe = os.path.join(root, "codex-code-mode-host")
    with open(exe, "w") as fh:
        fh.write(FAKE % (version, "codex-code-mode-host"))
    os.chmod(exe, 0o755)
    out = os.path.join(tmp, "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz")
    with tarfile.open(out, "w:gz") as tf:
        tf.add(root, arcname=os.path.basename(root))
    return out


def make_prefix_bundle(tmp, engine, version):
    """The shape of a whole `npm install --prefix` tree: bin/<engine>."""
    root = os.path.join(tmp, "bundle", "root")
    os.makedirs(os.path.join(root, "bin"))
    os.makedirs(os.path.join(root, "lib", "node_modules", engine))
    exe = os.path.join(root, "bin", engine)
    with open(exe, "w") as fh:
        fh.write(FAKE % (version, engine))
    os.chmod(exe, 0o755)
    out = os.path.join(tmp, "%s-bundle-9.9.9.tar.gz" % engine)
    with tarfile.open(out, "w:gz") as tf:
        tf.add(root, arcname="root")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=17839)
    ap.add_argument("--home", default=os.path.expanduser("~/.caden-test"))
    args = ap.parse_args()

    home = os.path.abspath(os.path.expanduser(args.home))
    daemon = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "server", "heartbeat.py")

    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(home)
    shutil.copy2(daemon, os.path.join(home, "heartbeat.py"))
    env = dict(os.environ, CADEN_HOME=home)
    subprocess.check_call([sys.executable, os.path.join(home, "heartbeat.py"),
                           "--port", str(args.port)], env=env)
    wait_ready(args.port)
    token = subprocess.check_output([sys.executable, os.path.join(home, "heartbeat.py"),
                                     "--print-token"], env=env).decode().strip()

    failures = []
    try:
        client = Client(args.port, token)
        cases = [
            ("claude", make_native_tgz, "9.9.9 (Fake Claude Code)",
             "npm-style platform package"),
            ("codex", make_release_tar, "codex-cli 9.9.9", "release tarball"),
            ("codex", make_codex_npm_tgz, "codex-cli 9.9.9",
             "codex npm platform package"),
            ("claude", make_prefix_bundle, "9.9.9 (Fake Claude Code)", "npm prefix bundle"),
        ]
        for engine, builder, version, label in cases:
            tmp = tempfile.mkdtemp()
            try:
                artifact = builder(tmp, engine, version)
                remote = client.upload(artifact)
                ok, error, result, steps = client.install(engine, remote)
                installed_under_home = str(result.get("path", "")).startswith(home)
                version_ok = result.get("version") == version
                status = "ok  " if (ok and installed_under_home and version_ok) else "FAIL"
                print("  %s %-24s -> %s %s" % (status, label,
                                               result.get("path"), result.get("version")))
                if not ok:
                    print("       error: %s" % error)
                    for s in steps[-4:]:
                        print("       | %s" % s.strip()[:100])
                if not ok:
                    failures.append("%s: %s" % (label, error))
                elif not installed_under_home:
                    failures.append("%s: installed outside CADEN_HOME (%s)" %
                                    (label, result.get("path")))
                elif not version_ok:
                    failures.append("%s: reported version %r, expected %r" %
                                    (label, result.get("version"), version))
                if label == "codex npm platform package":
                    companion = os.path.join(home, "bin", "codex-code-mode-host")
                    resource = os.path.join(home, "engines", "codex", "native",
                                            "codex-path", "rg")
                    complete = (bool(result.get("code_mode_host"))
                                and os.path.exists(companion)
                                and os.path.exists(resource))
                    print("  %s npm package keeps host and resources" %
                          ("ok  " if complete else "FAIL"))
                    if not complete:
                        print("       host=%r link=%s resource=%s" %
                              (result.get("code_mode_host"),
                               os.path.exists(companion), os.path.exists(resource)))
                        failures.append("codex npm platform package lost native resources")
            finally:
                shutil.rmtree(tmp, ignore_errors=True)

        # Codex is two binaries, and it resolves the second one as a sibling of
        # the path it was launched as -- which is the shim in $CADEN_HOME/bin,
        # not the real binary the installer put it beside.  A host that is not
        # linked there leaves a codex that can talk but cannot run a command.
        tmp = tempfile.mkdtemp()
        try:
            artifact = client.upload(make_release_tar(tmp, "codex", "codex-cli 9.9.9"))
            companion = client.upload(make_companion_tar(tmp, "host 9.9.9"))
            ok, error, result, steps = client.install("codex", artifact, companion)
            shim = os.path.join(home, "bin", "codex-code-mode-host")
            beside = os.path.exists(shim)  # follows the link; a dangling one fails
            print("  %s codex code-mode host is on PATH -> %s" %
                  ("ok  " if (ok and beside) else "FAIL", result.get("code_mode_host")))
            if not ok:
                print("       error: %s" % error)
                for s in steps[-4:]:
                    print("       | %s" % s.strip()[:100])
                failures.append("codex + companion: %s" % error)
            elif not result.get("code_mode_host"):
                failures.append("codex + companion: install reported no code_mode_host")
            elif not beside:
                failures.append("codex + companion: %s is missing or dangling" % shim)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

        # Older releases publish no host, so an install without one has to
        # succeed -- but it must say what was lost, because a codex that can
        # only talk is otherwise indistinguishable from a good install.
        tmp = tempfile.mkdtemp()
        try:
            shutil.rmtree(os.path.join(home, "engines", "codex"), ignore_errors=True)
            os.remove(os.path.join(home, "bin", "codex-code-mode-host"))
            artifact = client.upload(make_release_tar(tmp, "codex", "codex-cli 9.9.8"))
            ok, error, _, steps = client.install("codex", artifact)
            warned = any("cannot run commands" in s for s in steps)
            print("  %s installs without a host, and says so" %
                  ("ok  " if (ok and warned) else "FAIL"))
            if not ok:
                failures.append("codex without companion: %s" % error)
            elif not warned:
                failures.append("codex without companion: install was silent about it")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

        # A corrupt artifact must fail loudly rather than silently "succeeding"
        # by finding some other copy on PATH.
        tmp = tempfile.mkdtemp()
        try:
            junk = os.path.join(tmp, "claude-broken-1.0.0.tgz")
            with open(junk, "wb") as fh:
                fh.write(b"not an archive at all")
            remote = client.upload(junk)
            ok, error, _, _ = client.install("claude", remote)
            print("  %s rejects a corrupt artifact%s" %
                  ("ok  " if not ok else "FAIL", "" if not ok else " (reported success!)"))
            if ok:
                failures.append("corrupt artifact was accepted")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    finally:
        subprocess.call([sys.executable, os.path.join(home, "heartbeat.py"), "--stop"],
                        env=env, stdout=subprocess.DEVNULL)

    if failures:
        print("offline_install_test: FAILED")
        for f in failures:
            print("  - %s" % f)
        return 1
    print("offline_install_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
