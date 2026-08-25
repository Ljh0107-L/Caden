#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""Fast mode reaches the engine, and says so honestly when it does not.

Claude Code's fast mode is the one session setting with no command-line flag
behind it. Everything else Caden puts in the composer -- model, permission
mode, effort -- is an argument, so a freshly spawned process already has it.
Fast mode is a `control_request` sent afterwards, and an SDK session reports
`sdk_opt_in_required` until it is asked for explicitly.

That difference is the whole of this file. Two things follow from it and both
were wrong first:

  * a spawn has to be recorded as fast-off whatever the session wanted, or
    `reconcile` sees nothing to do and the opt-in is never sent;
  * `apply_settings` runs at the top of a turn, before the engine exists on
    the first one, and returns early -- so the opt-in had to move to the
    spawn itself. Until it did, `fast` worked from the second message on,
    which is indistinguishable from a switch that does not work.

And wanting it is not having it: Sonnet reports `off` with no reason at all,
an unpaid plan reports one. What the CLI says is what gets stored, so the
composer can show the reason rather than a lit switch that does nothing.

    python3 tests/fast_mode_test.py
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
    spec = importlib.util.spec_from_file_location("hb_fast", SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def engine_for(hb, session):
    """A ClaudeEngine with the process replaced by a recording stub.

    Nothing here starts `claude`: the questions are about which control
    requests get sent and when, and a real CLI would answer them slower and
    less precisely.
    """

    class Stub(hb.ClaudeEngine):
        def __init__(self, sess):
            hb.ClaudeEngine.__init__(self, sess)
            self.sent = []
            self.spawned = 0
            self.refuse = False

        # Shadows BaseEngine's property, which reads a real pid. Dead until
        # spawned matters here: `ensure_started` returns early on a live
        # engine, so an always-alive stub would never reach the code under
        # test.
        @property
        def alive(self):
            return self.spawned > 0

        def spawn(self, argv, stdin_pipe=True):
            self.spawned += 1

        def argv(self):
            return ["claude", "--print"]

        def spawn_signature(self, argv):
            return "sig"

        def _control(self, subtype, timeout=20, **fields):
            if self.refuse:
                raise hb.EngineError("unknown subtype: %s" % subtype)
            self.sent.append((subtype, fields))
            return {}

        def emit(self, *a, **kw):
            pass

    return Stub(session)


def flag_settings(eng):
    """Every `apply_flag_settings` payload the engine was sent."""
    return [f.get("settings") for s, f in eng.sent if s == "apply_flag_settings"]


def main():
    home = tempfile.mkdtemp(prefix="caden-fast-")
    hb = load_daemon(home)

    mgr = hb.SessionManager()

    def new_session(**over):
        spec = {"engine": "claude", "model": "claude-opus-5",
                "cwd": home, "effort": "high", "permission_mode": "acceptEdits",
                "provider": {"protocol": "anthropic-messages",
                             "api_key": "sk-test"}}
        spec.update(over)
        return mgr.create(spec)

    # -- the wish survives being written down ------------------------------
    s = new_session(fast=True)
    check("a session created with fast on keeps it",
          s.meta.get("fast") is True, repr(s.meta.get("fast")))
    check("and reports it to the client",
          s.to_dict().get("fast") is True)
    check("a session created without it does not invent one",
          new_session().to_dict().get("fast") is False)

    # -- a fresh process has it off, whatever was asked for ----------------
    eng = engine_for(hb, s)
    check("the session's wish is fast on",
          eng.hot_settings().get("fast") is True)
    check("but a spawn is recorded as fast off",
          eng.spawn_hot_settings().get("fast") is False,
          "otherwise reconcile has nothing to do and the opt-in is never sent")

    # -- and the opt-in reaches it on the first turn, not the second -------
    eng.ensure_started()
    check("starting the engine spawns it", eng.spawned == 1)
    check("and opts in to fast mode straight away",
          {"fastMode": True} in flag_settings(eng),
          "sent: %r" % (flag_settings(eng),))
    check("the engine is now recorded as having it",
          eng._hot.get("fast") is True)
    check("so a second turn sends nothing further",
          eng.reconcile() is True and flag_settings(eng).count({"fastMode": True}) == 1)

    # -- a session that never asked is left alone --------------------------
    plain = engine_for(hb, new_session())
    plain.ensure_started()
    check("a session without fast mode sends no opt-in",
          not any("fastMode" in (fs or {}) for fs in flag_settings(plain)),
          "sent: %r" % (flag_settings(plain),))

    # -- turning it off mid-session is a request too -----------------------
    s.meta["fast"] = False
    s.save()
    eng.reconcile()
    check("turning it off sends the opposite",
          {"fastMode": False} in flag_settings(eng))

    # -- toggling it mid-session keeps the process, and the cache with it --
    # The reason fast mode is a hot setting at all. `stale()` is what forces a
    # respawn, and it compares the spawn signature -- argv, env, cwd. There is
    # no fast flag to appear in any of them, so the only way a toggle could
    # cost the process is `reconcile` failing, which is why the refusal below
    # matters.
    s.meta["fast"] = False
    s.save()
    check("a toggle does not make the process stale", eng.stale() is False)
    was = eng.spawned
    eng.reconcile()
    check("so turning it off keeps the running engine", eng.spawned == was)
    s.meta["fast"] = True
    s.save()
    eng.reconcile()
    check("and turning it back on keeps it too", eng.spawned == was)

    # -- a refusal costs the turn nothing ----------------------------------
    # `reconcile` returning False is how an engine says "replace me", which is
    # the right answer for a model or a permission mode and the wrong one for
    # this: an install that does not know the subtype would trade its warm
    # process for nothing, once per turn, forever.
    s.meta["fast"] = True
    s.save()
    eng.refuse = True
    check("an install too old to know the subtype does not fail the reconcile",
          eng.reconcile() is True)
    check("and the process is left alone", eng.spawned == 1)
    # A refusal for anything else still replaces the process, which is what
    # says the swallow above is specific rather than a hole.
    s.meta["permission_mode"] = "plan"
    s.save()
    check("but a refused permission mode still asks to be replaced",
          eng.reconcile() is False)

    # -- what the CLI says beats what was asked for ------------------------
    eng.refuse = False
    eng._note_fast({"fast_mode_state": "off",
                    "fast_mode_disabled_reason": "not_entitled"})
    check("the CLI's own answer is what gets stored",
          s.to_dict().get("fast_state") == "off"
          and s.to_dict().get("fast_reason") == "not_entitled")
    check("the wish is reported alongside it, not overwritten by it",
          s.to_dict().get("fast") is True,
          "the composer shows both: the switch, and why it did not take")
    # Sonnet's case: off, and no reason offered. A missing reason is a fact
    # about the answer, not an absence of one, so it has to replace the old.
    eng._note_fast({"fast_mode_state": "off"})
    check("a state with no reason clears the previous reason",
          s.to_dict().get("fast_reason") is None,
          repr(s.to_dict().get("fast_reason")))
    # An event that says nothing about fast mode -- every `result` before the
    # CLI grew the field -- must not read as "off".
    eng._note_fast({"fast_mode_state": "on"})
    eng._note_fast({"subtype": "success"})
    check("an event that is silent about fast mode changes nothing",
          s.to_dict().get("fast_state") == "on")

    print()
    if failed:
        print("FAILED: %s" % ", ".join(failed))
    else:
        print("all fast-mode checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
