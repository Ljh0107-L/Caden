#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""What the daemon settles before it will start a session, and why.

Two checks, both of which exist because the alternative is a session that is
created, starts a turn, and dies on the engine's first line with a message
about something Caden never showed anyone -- which reads as "Caden is broken"
rather than as the one-line fact it is.

The first is turning a `key_ref` into the key it names.

The renderer has never held a model API key: it sends the provider's id and
something in front of the daemon supplies the value. On the Mac that is
app/server.js reading the login keychain -- see app/secret-inject.js, whose
behaviour this has to match, because the same renderer talks to both.

A reverse proxy cannot do it. It can add a header; it cannot rewrite a JSON
body. So for a console served straight from the daemon the swap happens in the
daemon, out of the copy provisioning leaves in ~/.caden/providers.json.

The case worth pinning is the ref with nothing behind it: it must still be
stripped. Leaving it in makes a missing key surface as a malformed body
instead of `require_credential`'s own sentence about a missing key, which is
the error the user can actually act on.

    python3 tests/key_ref_test.py
"""

import importlib.util
import json
import os
import shutil
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


def load(home):
    os.environ["CADEN_HOME"] = home
    spec = importlib.util.spec_from_file_location("heartbeat_key_ref", SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def root_refusal(caden):
    """Full access is what Claude Code will not do as root.

    It is --dangerously-skip-permissions underneath, and the CLI refuses it
    with a uid check. Caden does not work around that -- an agent that runs
    arbitrary commands should not be running them as root, least of all on a
    machine a browser can reach -- so the job here is to say so first.

    running_as_root is stubbed rather than the test being run as root, which
    would be a strange thing to require of a test suite.
    """
    real = caden.running_as_root
    try:
        caden.running_as_root = lambda: True
        try:
            caden.require_usable_permission_mode("claude", "bypassPermissions")
            check("as root, Full access is refused", False, "no error raised")
        except ValueError as exc:
            msg = str(exc)
            check("as root, Full access is refused", True)
            # The message has to name the cause and the way out; "invalid
            # permission mode" would send someone to the wrong place.
            check("and the message says it is about root",
                  "root" in msg, msg[:70])
            check("and offers something to do about it",
                  "Workspace write" in msg and "ordinary user" in msg, msg[:90])

        # The others start fine as root; refusing them would be a lie that
        # costs someone their only usable mode.
        for mode in ("acceptEdits", "plan", "dontAsk"):
            try:
                caden.require_usable_permission_mode("claude", mode)
                check("as root, %s is still allowed" % mode, True)
            except ValueError as exc:
                check("as root, %s is still allowed" % mode, False, str(exc)[:60])

        # Codex has no such check of its own.
        try:
            caden.require_usable_permission_mode("codex", "bypassPermissions")
            check("codex is not affected", True)
        except ValueError as exc:
            check("codex is not affected", False, str(exc)[:60])

        caden.running_as_root = lambda: False
        try:
            caden.require_usable_permission_mode("claude", "bypassPermissions")
            check("as anyone else, Full access is allowed", True)
        except ValueError as exc:
            check("as anyone else, Full access is allowed", False, str(exc)[:60])
    finally:
        caden.running_as_root = real


def main():
    keep = os.environ.get("CADEN_HOME")
    home = tempfile.mkdtemp(prefix="caden-keyref-")
    try:
        with open(os.path.join(home, "providers.json"), "w") as fh:
            json.dump({"prov-a": "sk-alpha", "prov-b": "sk-beta"}, fh)
        caden = load(home)

        spec = {"key_ref": "prov-a",
                "provider": {"protocol": "anthropic-messages",
                             "base_url": "https://example.invalid"}}
        out = caden.resolve_key_ref(spec)
        check("the ref is replaced by the key it names",
              out["provider"].get("api_key") == "sk-alpha",
              json.dumps(out.get("provider")))
        check("and the ref itself does not reach the session",
              "key_ref" not in out, json.dumps(out))
        check("the rest of the provider is untouched",
              out["provider"].get("base_url") == "https://example.invalid")

        # require_credential's message is the one the user can act on; a
        # leftover key_ref would turn it into a complaint about the body.
        out = caden.resolve_key_ref({"key_ref": "prov-missing", "provider": {}})
        check("a ref with no key behind it is still stripped",
              "key_ref" not in out and not out["provider"].get("api_key"),
              json.dumps(out))
        try:
            caden.require_credential("claude", out.get("provider"))
            check("and the request fails at require_credential", False,
                  "no error raised")
        except ValueError as exc:
            check("and the request fails at require_credential",
                  "no API key" in str(exc), str(exc))

        # An inline key is what the Mac's proxy already produced; nothing to do.
        inline = {"provider": {"api_key": "sk-inline"}}
        check("a body that carries its own key is left alone",
              caden.resolve_key_ref(inline)["provider"]["api_key"] == "sk-inline")

        # A home that was never synced must not raise on every session create.
        os.remove(os.path.join(home, "providers.json"))
        check("a daemon with no providers file is not an error",
              caden.provider_keys() == {}
              and "key_ref" not in caden.resolve_key_ref({"key_ref": "prov-a"}))

        print("the permission mode a root daemon cannot run in")
        root_refusal(caden)
    finally:
        shutil.rmtree(home, ignore_errors=True)
        if keep is None:
            os.environ.pop("CADEN_HOME", None)
        else:
            os.environ["CADEN_HOME"] = keep

    if failed:
        print("key_ref_test: FAILED")
        for f in failed:
            print("  - %s" % f)
        return 1
    print("key_ref_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
