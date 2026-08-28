#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""Getting an app-server up is three things, and a session needs all three.

`ensure_started` spawns the process, sends `initialize`, and resumes (or
starts) the thread that turns go on. Its re-entry guard used to be `alive`
alone -- true from the moment the process exists, which is before any of the
rest of it has happened.

A worker running a training job at a load average of 197 found what that
costs. app-server was signalled, respawned, and took just over two minutes to
answer `initialize`; Caden gave up at sixty seconds, having already spawned
it. From then on every submit hit the early return, skipped the resume it had
never reached, and sent `turn/start` for a thread the new process had never
been asked to open:

    {"error":{"code":-32600,"message":"thread not found: 01a03774-..."},"id":2}
    {"error":{"code":-32600,"message":"thread not found: 01a03774-..."},"id":3}
    {"error":{"code":-32600,"message":"thread not found: 01a03774-..."},"id":4}

Instantly, on every message, with the 63MB rollout sitting on disk the whole
time. Nothing recovers it, because nothing runs the handshake again while the
process is alive.

The other half is the same machine seen from the resume: a `thread/resume`
that times out means the box is busy, not that the thread is gone, and the
branch that starts a fresh thread must not be reached by it.

    python3 tests/codex_handshake_test.py
"""

import importlib.util
import os
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
    os.environ["CADEN_HOME"] = home
    spec = importlib.util.spec_from_file_location("hb_handshake", SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def engine_for(hb, session, script):
    """A CodexEngine whose process and RPCs are both bookkeeping.

    `script` maps a method to a callable that returns its result or raises.
    Nothing here launches `codex`: what is under test is which calls are made
    after a failure, which is not something a real app-server answers any more
    precisely -- only more slowly.
    """

    class Stub(hb.CodexEngine):
        def __init__(self, sess):
            hb.CodexEngine.__init__(self, sess)
            self.calls = []
            self.spawns = 0
            self._fake_alive = False

        @property
        def alive(self):
            return self._fake_alive

        def die(self):
            self._fake_alive = False

        # -- the process, reduced to a counter
        def write_model_catalog(self):
            pass

        def argv(self):
            return ["codex", "app-server"]

        def spawn(self, argv, stdin_pipe=True):
            self.spawns += 1
            self._fake_alive = True

        def remember_signature(self, argv):
            pass

        # -- the protocol, reduced to a list
        def _request(self, method, params=None, timeout=None):
            self.calls.append((method, params or {}))
            fn = script.get(method)
            return fn(params or {}) if fn else {}

        def fast_tier(self):
            return (None, None)

        def _note_fast(self, tier, why):
            pass

        def emit(self, *a, **kw):
            pass

    return Stub(session)


def methods(eng, since=0):
    return [m for m, _ in eng.calls[since:]]


def params_of(eng, method):
    for m, p in eng.calls:
        if m == method:
            return p
    return None


def timed_out(method):
    def raise_it(_params):
        raise EngineErrorRef[0]("%s timed out" % method, timeout=True)
    return raise_it


def refused(message):
    def raise_it(_params):
        raise EngineErrorRef[0](message)
    return raise_it


EngineErrorRef = [None]


def main():
    home = tempfile.mkdtemp(prefix="caden-handshake-")
    hb = load_daemon(home)
    EngineErrorRef[0] = hb.EngineError
    mgr = hb.SessionManager()

    def new_session(native_id=None):
        s = mgr.create({"engine": "codex", "model": "gpt-5.6-sol", "cwd": home,
                        "permission_mode": "bypassPermissions",
                        "provider": {"protocol": "openai-responses",
                                     "api_key": "sk-test"}})
        if native_id:
            s.meta["native_id"] = native_id
        return s

    # -- the wedge -------------------------------------------------------
    #
    # One slow `initialize`, and then everything the session does afterwards.
    print("== an initialize that timed out after the spawn")
    script = {"initialize": timed_out("initialize")}
    s = new_session("01a03774-6eda-7090-86f6-ee20ce821015")
    eng = engine_for(hb, s, script)

    try:
        eng.submit("t1", "hello")
        check("the first submit fails", False, "it did not raise")
    except hb.EngineError as exc:
        check("the first submit fails", "timed out" in str(exc), str(exc))
    check("the process was spawned once", eng.spawns == 1, eng.spawns)
    check("and it got no further than initialize",
          methods(eng) == ["initialize"], methods(eng))
    check("so the handshake is not recorded as done",
          eng._handshake_done is False)

    # The app-server was only slow: it is up now and answers.
    mark = len(eng.calls)
    script["initialize"] = refused("initialize failed: Already initialized")
    script["thread/resume"] = lambda p: {"thread": {"id": p["threadId"]}}
    eng.submit("t2", "hello again")

    check("the next submit does not replace a live process", eng.spawns == 1,
          eng.spawns)
    # A second one comes back `Already initialized` from a real app-server, so
    # sending it is not a harmless retry -- it is the failure all over again.
    check("nor sends initialize a second time",
          "initialize" not in methods(eng, mark), methods(eng, mark))
    # `thread/goal/clear` rides along with every start: Codex drives a goal
    # of its own if one is set, and Caden drives one now too.
    check("it resumes the thread it was wedged on",
          methods(eng, mark) == ["thread/resume", "thread/goal/clear",
                                 "turn/start"],
          methods(eng, mark))
    check("with the id the session was holding",
          params_of(eng, "thread/resume").get("threadId")
          == "01a03774-6eda-7090-86f6-ee20ce821015")
    check("and the turn goes on that same thread",
          params_of(eng, "turn/start").get("threadId")
          == "01a03774-6eda-7090-86f6-ee20ce821015")
    check("the session kept its thread throughout",
          s.meta.get("native_id") == "01a03774-6eda-7090-86f6-ee20ce821015",
          repr(s.meta.get("native_id")))

    # -- a busy box is not a missing thread ------------------------------
    print("== a resume that timed out")
    s = new_session("th_keep")
    eng = engine_for(hb, s, {"thread/resume": timed_out("thread/resume")})
    try:
        eng.submit("t1", "hello")
        check("the submit fails rather than inventing a thread", False,
              "it did not raise")
    except hb.EngineError as exc:
        check("the submit fails rather than inventing a thread", exc.timeout,
              str(exc))
    check("no new thread was started", "thread/start" not in methods(eng),
          methods(eng))
    check("and the thread id is still there for the next attempt",
          s.meta.get("native_id") == "th_keep", repr(s.meta.get("native_id")))

    # -- a server that answers is believed -------------------------------
    #
    # Unchanged behaviour, and the reason the branch above has to be narrow:
    # a wiped engine home really does mean start again.
    print("== a resume the server refused")
    s = new_session("th_gone")
    eng = engine_for(hb, s, {
        "thread/resume": refused("thread/resume failed: thread not found: th_gone"),
        "thread/start": lambda p: {"thread": {"id": "th_new"}}})
    eng.submit("t1", "hello")
    check("a refused resume starts a new thread",
          "thread/start" in methods(eng), methods(eng))
    check("and the session moves to it", s.meta.get("native_id") == "th_new",
          repr(s.meta.get("native_id")))

    # -- the happy path still costs one call -----------------------------
    print("== a handshake that finished")
    s = new_session()
    eng = engine_for(hb, s, {"thread/start": lambda p: {"thread": {"id": "th_1"}}})
    eng.submit("t1", "hello")
    check("a fresh session initializes and starts a thread",
          methods(eng) == ["initialize", "thread/start", "thread/goal/clear",
                           "turn/start"],
          methods(eng))
    mark = len(eng.calls)
    eng.submit("t2", "again")
    check("the turn after it is only a turn",
          methods(eng, mark) == ["turn/start"], methods(eng, mark))

    # A process that dies is a handshake to do again, all of it.
    eng.die()
    mark = len(eng.calls)
    eng.submit("t3", "and again")
    check("a process that died is greeted from the start",
          methods(eng, mark) == ["initialize", "thread/resume",
                                 "thread/goal/clear", "turn/start"],
          methods(eng, mark))
    check("respawned once", eng.spawns == 2, eng.spawns)

    print()
    if failed:
        print("codex_handshake_test: %d FAILED" % len(failed))
        for f in failed:
            print("  - %s" % f)
        return 1
    print("codex_handshake_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
