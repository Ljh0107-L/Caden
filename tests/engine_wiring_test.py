#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""What an engine is handed at spawn time, and what has to be on PATH for it.

Every failure here is the same shape: the engine starts, answers, and is
quietly not the engine the session asked for -- nothing errors, so the only
symptom is behaviour nobody chose.

  * Codex resolves its Code Mode host as a sibling of the path it was
    *launched* as -- the shim in `$CADEN_HOME/bin`, which macOS reports without
    following the symlink first. A host installed only beside the real binary
    is invisible, and all that surfaces is a warning inside a session.
  * `seed_engine_config` copies the host's `config.toml` into the session's
    CODEX_HOME for its MCP servers and instructions. That file can also carry
    `model_provider` and `model`, which would decide for a session that already
    said what it wanted -- the substitution `SEEDED_ENV_DENY` takes back out of
    Claude's `settings.json`, arriving through Codex's file instead.
  * A declared context window is one setting doing two jobs: Codex takes what
    fits from its catalog, and takes when to make room from nine tenths of the
    same number -- `model_auto_compact_token_limit` looks like the second
    lever and, measured, moves nothing. A catalog written to the declared
    number therefore compacts a tenth early, with the gauge still drawing what
    Caden asked for.

    python3 tests/engine_wiring_test.py
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


def load_daemon(home):
    """Import heartbeat.py against a throwaway $CADEN_HOME."""
    os.environ["CADEN_HOME"] = home
    spec = importlib.util.spec_from_file_location("heartbeat_under_test", SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeSession(object):
    """Enough of a Session for `argv` -- meta, and where files would live."""

    id = "s_wiring"

    def __init__(self, root, meta):
        self.root = root
        self.meta = meta

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def engine_env(self):
        return {}


def touch(path, text="#!/bin/sh\nexit 0\n"):
    d = os.path.dirname(path)
    if not os.path.isdir(d):
        os.makedirs(d)
    with open(path, "w") as fh:
        fh.write(text)
    os.chmod(path, 0o755)
    return path


def test_companion_link(caden):
    """The Code Mode host has to be reachable from the shim, not just installed."""
    native = os.path.join(caden.DIR_ENGINES, "codex", "native")
    codex = touch(os.path.join(native, "codex"))
    host = touch(os.path.join(native, caden.CODEX_CODE_MODE_HOST))
    caden.mkdirp(caden.DIR_BIN)
    caden.link_bin(codex, "codex")
    shim = os.path.join(caden.DIR_BIN, caden.CODEX_CODE_MODE_HOST)

    # Installed beside the real binary but not linked: this is the state that
    # produced "host executable was not found" while the file was on disk.
    check("host is not reachable from bin/ until it is linked",
          not os.path.exists(shim))

    caden.link_codex_companion()
    check("backfill links the host beside the codex shim",
          os.path.exists(shim) and os.path.realpath(shim) == os.path.realpath(host),
          os.path.realpath(shim) if os.path.exists(shim) else "missing")

    # An install that replaces the engine tree takes the host with it. A link
    # left pointing at the old one is worse than none: codex would spawn a path
    # that no longer resolves, so the backfill has to clear it.
    os.remove(host)
    check("a host removed by a reinstall leaves the link dangling",
          os.path.islink(shim) and not os.path.exists(shim))
    caden.link_codex_companion()
    check("backfill clears the dangling link", not os.path.lexists(shim))

    # Nothing to link and nothing stale: must not invent one.
    caden.link_codex_companion()
    check("backfill is a no-op when there is no host", not os.path.lexists(shim))


def codex_argv(caden, root, meta):
    engine = object.__new__(caden.CodexEngine)
    engine.session = FakeSession(root, meta)
    return engine.argv()


def cfg_value(argv, key):
    """The value `-c key=<value>` was last given, if any."""
    found = None
    for i, a in enumerate(argv):
        if a == "-c" and i + 1 < len(argv):
            k, _, v = argv[i + 1].partition("=")
            if k == key:
                found = v.strip('"')
    return found


def test_argv_pins_routing(caden, root):
    """A seeded config.toml must not get to choose the provider or the model."""
    argv = codex_argv(caden, root, {"model": "gpt-5-codex"})
    check("provider is pinned when the session has no relay",
          cfg_value(argv, "model_provider") == "openai",
          "model_provider=%r" % cfg_value(argv, "model_provider"))
    check("model is pinned for the turns Caden does not start",
          cfg_value(argv, "model") == "gpt-5-codex",
          "model=%r" % cfg_value(argv, "model"))

    relay = codex_argv(caden, root, {
        "model": "gpt-5-codex",
        "provider": {"base_url": "https://relay.example/v1", "api_key": "k"},
    })
    check("a session with a relay still routes to it",
          cfg_value(relay, "model_provider") == "caden",
          "model_provider=%r" % cfg_value(relay, "model_provider"))
    check("the relay's base_url is the one configured",
          cfg_value(relay, "model_providers.caden.base_url")
          == "https://relay.example/v1")

    # No model on the session means nothing to pin; it must not invent one.
    bare = codex_argv(caden, root, {})
    check("no model on the session pins no model",
          cfg_value(bare, "model") is None,
          "model=%r" % cfg_value(bare, "model"))


CATALOG = {"models": [
    {"slug": "gpt-5.6-sol", "context_window": 272000,
     "max_context_window": 872000, "effective_context_window_percent": 95},
    {"slug": "gpt-5.4", "context_window": 272000,
     "max_context_window": 1000000, "effective_context_window_percent": 95},
]}


def test_compaction_limit(caden, root):
    """A declared window has to move the compaction point, not just the gauge.

    Codex decides when to compact from the catalog window and from nothing
    else: nine tenths of it, with no way to ask for another number. Measured
    on `codex-cli` 0.146.0, a catalog window of 100k resolved
    `auto_compact_scope_limit=Some(90000)` both with
    `-c model_auto_compact_token_limit=95000` on the command line and with
    `auto_compact_token_limit` written into the catalog entry itself; a
    0.149.1 on a devbox agreed from the other end, logging a limit of 748800
    against a catalog window of 832000.

    So a session that declared 800k got `800000 + 32000` written down and was
    compacted at 748800 -- 51200 short, on every single turn, with the gauge
    still drawing 800k and the conversation quietly losing six percent of what
    it had been promised. Ten ninths of the declared number is written down
    now, and Codex's own tenth comes off it to land on 800000 exactly. What
    sits above the compaction point is the reply's room, which is what the
    flat reserve was for.
    """
    engine = object.__new__(caden.CodexEngine)
    engine.session = FakeSession(root, {"model": "gpt-5.6-sol",
                                        "context_window": 800000})
    engine._auto_compact_limit = None
    os.makedirs(os.path.join(root, "engine"), exist_ok=True)

    real = caden.run_capture
    caden.run_capture = lambda *a, **k: (0, json.dumps(CATALOG), "")
    try:
        path = engine.write_model_catalog()
    finally:
        caden.run_capture = real

    written = json.load(open(path))
    windows = [m["context_window"] for m in written["models"]]
    check("the catalog carries ten ninths of the declared window",
          all(w == 888889 for w in windows), str(windows))
    # The property is the point, not the number: this is where compaction
    # actually lands, and rounding the line above down would put it one token
    # short of what the session asked for.
    check("so Codex's own tenth comes off it onto the declared number",
          all(w * caden.CODEX_AUTO_COMPACT_PERCENT // 100 == 800000
              for w in windows),
          str([w * caden.CODEX_AUTO_COMPACT_PERCENT // 100 for w in windows]))
    check("and it holds for every window a session might declare",
          all(caden.CodexEngine._catalog_window(d)
              * caden.CODEX_AUTO_COMPACT_PERCENT // 100 == d
              for d in (100000, 128000, 200000, 272000, 400000, 1000000)))
    # Codex would otherwise take a second percentage off that total, charging
    # for the reply twice.
    check("and Codex is told not to take its own cut as well",
          all(m["effective_context_window_percent"] == 100
              for m in written["models"]),
          str([m["effective_context_window_percent"] for m in written["models"]]))
    check("max_context_window keeps up with it",
          all(m["max_context_window"] >= 888889 for m in written["models"]),
          str([m["max_context_window"] for m in written["models"]]))
    check("the limit asked for by name is the same point",
          engine._auto_compact_limit == 800000, str(engine._auto_compact_limit))

    argv = engine.argv()
    # Sent even though no build tried has read it: it names the same point the
    # catalog puts the session at, so a build that starts honouring it agrees
    # with the window rather than moving the session.
    check("and is passed alongside the catalog",
          cfg_value(argv, "model_auto_compact_token_limit") == "800000",
          "%r" % cfg_value(argv, "model_auto_compact_token_limit"))
    check("the catalog is passed too",
          cfg_value(argv, "model_catalog_json") == path)


def test_compaction_reports_its_size(caden, root):
    """What the conversation was rewritten down from.

    app-server says a compaction finished; it never says how big the thing was
    that went into it. Without the size measured on the way in, the notice can
    only say that something happened.
    """
    engine = object.__new__(caden.CodexEngine)
    engine.session = FakeSession(root, {"model": "gpt-5.6-sol"})
    engine._items = {}
    engine._item_keys = {}
    engine._compacting = None
    engine._compact_pre = 0
    engine._ctx_usage = {"cache_read_tokens": 572200, "input_tokens": 2500,
                         "output_tokens": 786, "cache_write_tokens": 0}
    emitted = []
    engine.emit = lambda type_, **f: emitted.append((type_, f))
    engine._key = lambda x: x

    check("the window total matches what the gauge adds up",
          engine._context_total() == 575486, str(engine._context_total()))

    item = {"type": "contextCompaction", "id": "c1"}
    engine._on_item(False, item)
    engine._on_item(True, item)
    done = [f for t, f in emitted if t == "compaction" and f.get("state") == "done"]
    check("the notice carries the size that went in",
          bool(done) and done[0].get("pre_tokens") == 575486,
          str(done[0] if done else None))

    # One the user asked for was already in flight when the item arrived, so
    # nothing measured it on the way in and the notice does not invent a size.
    emitted.clear()
    engine._items = {}
    engine._item_keys = {}
    engine._begin_compaction(trigger="manual")
    engine._on_item(False, {"type": "contextCompaction", "id": "c2"})
    engine._on_item(True, {"type": "contextCompaction", "id": "c2"})
    done = [f for t, f in emitted if t == "compaction" and f.get("state") == "done"]
    check("a manual one claims no size it did not measure",
          bool(done) and not done[0].get("pre_tokens"),
          str(done[0] if done else None))


def main():
    home = tempfile.mkdtemp(prefix="caden-wiring-")
    keep = os.environ.get("CADEN_HOME")
    try:
        caden = load_daemon(home)
        caden.ensure_dirs()
        # `argv` refuses to build one without an installed codex.
        touch(os.path.join(caden.DIR_ENGINES, "codex", "native", "codex"))
        caden.link_bin(os.path.join(caden.DIR_ENGINES, "codex", "native", "codex"),
                      "codex")
        caden.TOOLCHAIN.refresh()

        test_argv_pins_routing(caden, os.path.join(home, "session"))
        test_compaction_limit(caden, os.path.join(home, "session"))
        test_compaction_reports_its_size(caden, os.path.join(home, "session"))
        test_companion_link(caden)
    finally:
        shutil.rmtree(home, ignore_errors=True)
        if keep is None:
            os.environ.pop("CADEN_HOME", None)
        else:
            os.environ["CADEN_HOME"] = keep

    if failed:
        print("engine_wiring_test: FAILED")
        for f in failed:
            print("  - %s" % f)
        return 1
    print("engine_wiring_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
