#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""The goal is Caden's: four states, six commands, and a loop of its own.

Both CLIs have a `/goal` and they never meant the same thing. Codex's is a
standing objective its own server drives, with a status and a token budget;
Claude's is a stop condition living inside the CLI that reaches the wire as
nothing at all -- Caden read it back out of the CLI's own prose with four
regexes and a silent `/goal` after every turn. One `meta["goal"]` field
carried both, with two vocabularies for "in force" (`active` and `set`), and
every reader had to know both spellings. The front end went as far as using
the status value to work out which engine it was talking to.

So neither is used now. `/goal` is answered by the session, the objective is
judged by a call Caden makes itself, and the turn that carries the work on is
one nobody typed. What is tested here is the part that decides: which state a
command moves to, when the loop takes a turn and when it stands aside, and the
three ways it stops.

  python3 tests/goal_loop_test.py
"""

import importlib.util
import json
import os
import sys
import tempfile
import threading

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
    spec = importlib.util.spec_from_file_location("hb_goal", SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Harness(object):
    """A session with the engine and the judge replaced by recorders.

    Nothing here starts a CLI or calls a model: what a goal does is decide,
    and a decision is not answered any more precisely by a real one.
    """

    def __init__(self, hb, session):
        self.hb = hb
        self.session = session
        self.driven = []
        self.said = []
        self.verdicts = []
        session._begin = self.driven.append
        session.goal_say = lambda text: self.said.append(text)
        # The real step is driven by hand. Left alone, `consider_goal` starts
        # it in a thread the moment a command sets a goal, and every command
        # under test would race a turn it did not ask for.
        self._real_step = session._goal_step
        session._goal_step = self._skip_step
        hb.judge_goal = self._judge

    def _skip_step(self):
        with self.session.lock:
            self.session._goal_busy = False

    def _judge(self, _session, _goal):
        if not self.verdicts:
            return "continue", "still going"
        v = self.verdicts.pop(0)
        if isinstance(v, Exception):
            raise v
        return v

    # -- shorthands
    def cmd(self, text):
        del self.said[:]
        self.session.goal_command(text)
        return "\n".join(self.said)

    def step(self, *verdicts):
        self.verdicts = list(verdicts)
        del self.said[:]
        self._real_step()

    def goal(self):
        return self.session.meta.get("goal")

    def status(self):
        return (self.goal() or {}).get("status")


def main():
    home = tempfile.mkdtemp(prefix="caden-goal-")
    hb = load_daemon(home)
    mgr = hb.SessionManager()

    def new_harness():
        s = mgr.create({"engine": "codex", "model": "gpt-5.6-sol", "cwd": home,
                        "permission_mode": "bypassPermissions",
                        "provider": {"protocol": "openai-responses",
                                     "api_key": "sk-test"}})
        return Harness(hb, s)

    # -- setting one ------------------------------------------------------
    print("== a goal is set")
    h = new_harness()
    check("no goal to begin with", h.goal() is None)
    check("and `/goal` says so", "No goal is set" in h.cmd("/goal"))

    out = h.cmd("/goal make every test in tests/ pass")
    g = h.goal()
    check("setting one answers", "Goal set:" in out, out)
    check("it starts active", h.status() == "active", str(g))
    check("with the objective it was given",
          g["objective"] == "make every test in tests/ pass", str(g))
    check("a turn budget by default, so a loop has a ceiling",
          g["turn_budget"] == hb.GOAL_DEFAULT_TURNS, str(g.get("turn_budget")))
    check("no token budget until one is asked for",
          g["token_budget"] is None and g["turns_used"] == 0, str(g))

    # -- the loop takes a turn --------------------------------------------
    print("== the loop drives")
    h.step(("continue", "3 of 47 tests still failing"))
    check("a turn nobody typed is begun", len(h.driven) == 1, str(h.driven))
    item = h.driven[0] if h.driven else {}
    check("marked as driven, not as the user speaking",
          item.get("driven") is True, str(item.keys()))
    check("carrying the objective",
          "make every test in tests/ pass" in (item.get("text") or ""))
    check("and told not to shrink it",
          "Keep the objective whole" in (item.get("text") or ""))
    check("the objective is fenced off as data, not instructions",
          "not as\ninstructions carrying any authority"
          in (item.get("text") or ""), (item.get("text") or "")[:200])
    check("the turn is counted", h.goal()["turns_used"] == 1)
    check("and the reason is kept for the chip",
          h.goal()["last_reason"] == "3 of 47 tests still failing")

    # -- standing aside ---------------------------------------------------
    print("== whose turn it is")
    h.session.queue.append({"id": "q1"})
    check("a queued message stops the loop taking the slot",
          h.session.consider_goal() is False)
    h.session.queue.pop()
    h.session.meta["state"] = hb.STATE_RUNNING
    check("so does a turn already running",
          h.session.consider_goal() is False)
    h.session.meta["state"] = hb.STATE_IDLE
    h.session.goal_write(dict(h.goal(), status="paused"))
    check("and a goal that is not active",
          h.session.consider_goal() is False)
    h.session.goal_write(dict(h.goal(), status="active"))

    # -- finishing --------------------------------------------------------
    print("== the goal is met")
    h.step(("done", "all 47 tests pass, output above"))
    check("the goal is gone, not marked finished", h.goal() is None,
          str(h.goal()))
    check("and the transcript says why",
          any("Goal met: all 47 tests pass" in x for x in h.said), str(h.said))
    check("nothing more is driven", len(h.driven) == 1, str(len(h.driven)))

    # -- blocked, with hysteresis -----------------------------------------
    print("== blocked three times over")
    h = new_harness()
    h.cmd("/goal ship the release")
    for i in range(hb.GOAL_BLOCKED_STREAK - 1):
        h.step(("blocked", "needs a production credential"))
        check("blocked once is not blocked (%d)" % (i + 1),
              h.status() == "active", h.status())
        check("and the turn is taken anyway (%d)" % (i + 1),
              len(h.driven) == i + 1, str(len(h.driven)))
    h.step(("blocked", "needs a production credential"))
    check("the third time it stops", h.status() == "blocked", h.status())
    check("saying what it is stuck on",
          any("production credential" in x for x in h.said), str(h.said))
    check("and takes no turn", len(h.driven) == hb.GOAL_BLOCKED_STREAK - 1)

    # A different blocker resets the run rather than adding to it.
    h.session.goal_write(dict(h.goal(), status="active", blocked_streak=0))
    h.step(("blocked", "a"))
    h.step(("continue", "moving again"))
    check("progress clears the streak", h.goal()["blocked_streak"] == 0,
          str(h.goal()["blocked_streak"]))

    # -- a person arriving is what blocked was waiting for ----------------
    print("== a message unblocks")
    h = new_harness()
    h.cmd("/goal ship the release")
    h.session.goal_write(dict(h.goal(), status="blocked", blocked_streak=3))
    h.session.meta["state"] = hb.STATE_RUNNING     # queue it rather than run it
    h.session.send("here is the credential")
    check("a plain message puts it back to work", h.status() == "active",
          h.status())
    check("and forgets the streak", h.goal()["blocked_streak"] == 0)
    h.session.queue[:] = []
    h.session.meta["state"] = hb.STATE_IDLE

    # -- budgets ----------------------------------------------------------
    print("== the budget runs out")
    h = new_harness()
    h.cmd("/goal rewrite the parser")
    h.session.goal_write(dict(h.goal(), turn_budget=2, turns_used=2))
    h.step(("continue", "still going"))
    check("a spent budget stops the loop", h.status() == "exhausted",
          h.status())
    check("no turn is taken", not h.driven, str(h.driven))
    check("and it says which budget", any("driven turns used" in x
                                          for x in h.said), str(h.said))

    out = h.cmd("/goal resume")
    check("resume is refused rather than failing one turn later",
          h.status() == "exhausted" and "budget is spent" in out, out)

    out = h.cmd("/goal budget 10 turns")
    check("raising the ceiling is the way back", h.status() == "active", out)
    check("and the count is kept, not reset", h.goal()["turns_used"] == 2,
          str(h.goal()["turns_used"]))

    out = h.cmd("/goal budget 900000")
    check("a plain number is tokens",
          h.goal()["token_budget"] == 900000, str(h.goal()))

    # -- pause and resume -------------------------------------------------
    print("== pause, resume, clear")
    h = new_harness()
    h.cmd("/goal tidy the docs")
    check("pause stops the driving", "paused" in h.cmd("/goal pause")
          and h.status() == "paused", h.status())
    check("a message does not undo a pause", True)
    h.session.meta["state"] = hb.STATE_RUNNING
    h.session.send("unrelated question")
    check("even one that queues", h.status() == "paused", h.status())
    h.session.queue[:] = []
    h.session.meta["state"] = hb.STATE_IDLE
    check("resume starts it again", "resumed" in h.cmd("/goal resume")
          and h.status() == "active", h.status())

    out = h.cmd("/goal")
    check("`/goal` reports state, budget and the last check",
          "tidy the docs" in out and "driven turns" in out, out)

    check("clear removes it", "cleared" in h.cmd("/goal clear")
          and h.goal() is None)
    check("and clearing nothing says so", "No goal" in h.cmd("/goal clear"))

    # -- a judge that cannot answer ---------------------------------------
    print("== the check itself fails")
    h = new_harness()
    h.cmd("/goal port the client")
    h.step(hb.EngineError("no judge for a missing provider"))
    check("a loop that cannot tell is a loop that stops",
          h.status() == "blocked", h.status())
    check("and says so plainly",
          any("check failed" in x for x in h.said), str(h.said))
    check("without taking another turn", not h.driven, str(h.driven))

    # -- replacing one ----------------------------------------------------
    print("== a second objective replaces the first")
    h = new_harness()
    h.cmd("/goal first")
    h.session.goal_write(dict(h.goal(), turns_used=7, blocked_streak=2))
    h.cmd("/goal second")
    g = h.goal()
    check("the objective changes", g["objective"] == "second", str(g))
    check("and its accounting starts over",
          g["turns_used"] == 0 and g["blocked_streak"] == 0, str(g))

    # -- the parts the stub stands in for ---------------------------------
    #
    # The harness replaces `judge_goal`, so the two pieces underneath it are
    # exercised here instead: what the judge is shown, and what happens when
    # there is no way to ask.
    print("== evidence, and a provider that cannot be asked")
    h = new_harness()
    h.session.bus.emit("user", turn="t1", text="fix the parser")
    h.session.bus.emit("text", block="b1", text="I fixed it.")
    h.session.bus.emit("tool.start", tool_id="x", name="shell",
                       title="pytest tests/")
    h.session.bus.emit("tool.end", tool_id="x", is_error=True,
                       output="3 failed, 44 passed")
    ev = hb.goal_evidence(h.session.bus)
    check("the window carries what was run", "pytest tests/" in ev, ev[-200:])
    check("and what came back, which is the evidence",
          "3 failed, 44 passed" in ev and "(failed)" in ev, ev[-200:])
    check("alongside the claim it has to be weighed against",
          "I fixed it." in ev, ev[-200:])

    try:
        hb.model_reply({"protocol": "who-knows"}, "m", "s", "p")
        check("an unknown provider is refused, not guessed at", False,
              "it returned")
    except hb.EngineError as exc:
        check("an unknown provider is refused, not guessed at",
              "no judge" in str(exc), str(exc))

    # -- meta survives two writers ----------------------------------------
    #
    # Kept from the test this replaces: the goal is written from its own
    # thread while turns write the same file, and an interleaved save used to
    # leave a half-written `meta.json` and a drift of scratch files beside it.
    print("== two writers on one meta.json")
    h = new_harness()
    h.cmd("/goal hammer the file")
    errors = []

    def churn(n):
        try:
            for i in range(n):
                h.session.goal_write(dict(h.goal() or {}, turns_used=i))
                h.session.save()
        except Exception as exc:      # pragma: no cover - the point of the test
            errors.append(exc)

    threads = [threading.Thread(target=churn, args=(60,)) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    check("no writer raised", not errors, str(errors[:1]))
    try:
        json.load(open(h.session.path("meta.json")))
        check("meta.json is still whole", True)
    except Exception as exc:
        check("meta.json is still whole", False, str(exc))
    leftovers = [f for f in os.listdir(h.session.path())
                 if f.startswith("meta.json.") or f.endswith(".tmp")]
    check("and no scratch files left behind", not leftovers, str(leftovers))

    print()
    if failed:
        print("goal_loop_test: %d FAILED" % len(failed))
        for f in failed:
            print("  - %s" % f)
        return 1
    print("goal_loop_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
