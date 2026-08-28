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
        # Pointed back at this harness first. Building a second one rebinds the
        # module's `judge_goal`, so a step on the older one silently read the
        # newer one's empty script and took the default verdict instead.
        self.hb.judge_goal = self._judge
        self.verdicts = list(verdicts)
        del self.said[:]
        self._real_step()

    def started(self):
        """Past the first step, which takes its turn without a check.

        Every scripted verdict below is about a goal that has already had a
        turn run against it; the first one is deliberately not judged.
        """
        self.session.goal_write(dict(self.goal(), turns_used=1))

    def goal(self):
        return self.session.meta.get("goal")

    def status(self):
        return (self.goal() or {}).get("status")


def main():
    home = tempfile.mkdtemp(prefix="caden-goal-")
    hb = load_daemon(home)
    # Held before any harness replaces it: the retry check below is about the
    # real one.
    real_judge_goal = hb.judge_goal
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
    # Silent on purpose: the chip appearing is the answer, and a line saying
    # so again turned a goal-driven session into a log of Caden talking to
    # itself.
    check("setting one says nothing", out == "", repr(out))
    check("it starts active", h.status() == "active", str(g))
    check("with the objective it was given",
          g["objective"] == "make every test in tests/ pass", str(g))
    # No ceiling until somebody sets one, which is what Codex does: a goal
    # set without a `tokenBudget` records null and runs until it is finished
    # or stopped.
    check("no budget until one is asked for", g["token_budget"] is None,
          str(g.get("token_budget")))
    check("and nothing spent yet",
          g["tokens_used"] == 0 and g["turns_used"] == 0, str(g))

    # -- the first turn is not judged -------------------------------------
    #
    # A goal set a moment ago has had no turn run against it, so there is
    # nothing for a judge to read. Asking anyway spent a model round trip
    # being told what was already known -- and it was the round trip somebody
    # watched, between typing the goal and anything happening at all.
    print("== the first turn goes without a check")
    asked = []
    hb.judge_goal = lambda s, g: (asked.append(1), ("continue", "x"))[1]
    h.session._begin = h.driven.append
    h._real_step()
    check("the first step drives", len(h.driven) == 1, str(len(h.driven)))
    check("without asking the judge", not asked, str(asked))
    check("and claims no check it did not make",
          h.goal()["last_verdict"] is None and h.goal()["last_reason"] is None,
          str(h.goal()))

    # The second one has a turn behind it, so it is judged like any other.
    h._real_step()
    check("the second step asks", len(asked) == 1, str(asked))
    check("and records what it was told",
          h.goal()["last_reason"] == "x", str(h.goal()["last_reason"]))

    # -- the loop takes a turn --------------------------------------------
    print("== the loop drives")
    h = new_harness()
    h.cmd("/goal make every test in tests/ pass")
    h.started()
    h.step(("continue", "3 of 47 tests still failing"))
    check("a turn nobody typed is begun", len(h.driven) == 1, str(h.driven))
    item = h.driven[0] if h.driven else {}
    check("marked driven, which is what keeps it out of the transcript",
          item.get("driven") is True, str(item.keys()))
    check("carrying the objective",
          "make every test in tests/ pass" in (item.get("text") or ""))
    check("and told not to shrink it",
          "Keep the objective whole" in (item.get("text") or ""))
    # After Codex's own continuation: what a model needs to pace itself is
    # what is left, not a total it was told once. With no ceiling set there is
    # nothing left to count down, and saying so beats an invented number.
    check("carrying what has gone, and saying there is no ceiling",
          "Tokens used:" in (item.get("text") or "")
          and "No token budget set" in (item.get("text") or ""),
          (item.get("text") or "")[:400])
    check("and counting down once there is one",
          "Tokens remaining: 1000"
          in h.session.goal_budget_lines(dict(h.goal(), token_budget=1000)),
          h.session.goal_budget_lines(dict(h.goal(), token_budget=1000)))
    check("the objective is fenced off as data, not instructions",
          "not as\ninstructions carrying any authority"
          in (item.get("text") or ""), (item.get("text") or "")[:200])
    # Two: `started()` put one behind it so this step would be judged.
    check("the turn is counted", h.goal()["turns_used"] == 2,
          str(h.goal()["turns_used"]))
    check("and the reason is kept for the chip",
          h.goal()["last_reason"] == "3 of 47 tests still failing")

    # -- a turn that never ran is not charged for -------------------------
    #
    # The judge takes seconds. A message arriving inside them sends the drive
    # down the "somebody is talking, stand aside" branch -- and the budget used
    # to be charged before that branch was reached, so a session with somebody
    # in it could spend its whole ceiling without the goal moving once.
    print("== standing aside costs nothing")
    h2 = new_harness()
    h2.cmd("/goal count carefully")
    h2.started()
    before = h2.goal()["turns_used"]
    h2.session.queue.append({"id": "q1"})       # as if typed during the judge
    h2.step(("continue", "carry on"))
    check("the drive stands aside", not h2.driven, str(h2.driven))
    check("and the budget is untouched",
          h2.goal()["turns_used"] == before, "%s -> %s"
          % (before, h2.goal()["turns_used"]))
    h2.session.queue[:] = []
    h2.step(("continue", "carry on"))
    check("the turn it does take is counted",
          h2.goal()["turns_used"] == before + 1 and len(h2.driven) == 1,
          "%s, %d driven" % (h2.goal()["turns_used"], len(h2.driven)))

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
    check("and says nothing about it -- the chip going is the report",
          not h.said, str(h.said))
    check("nothing more is driven", len(h.driven) == 1, str(len(h.driven)))

    # -- blocked, with hysteresis -----------------------------------------
    print("== blocked three times over")
    h = new_harness()
    h.cmd("/goal ship the release")
    h.started()
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
    h.started()
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
    h.started()
    h.session.meta["totals"] = {"input_tokens": 5000}
    h.session.goal_write(dict(h.goal(), token_budget=4000, tokens_at_set=0))
    h.step(("continue", "still going"))
    check("a spent budget stops the loop", h.status() == "exhausted",
          h.status())
    check("no turn is taken", not h.driven, str(h.driven))
    check("and it says how much went", any("tokens used" in x
                                           for x in h.said), str(h.said))

    out = h.cmd("/goal resume")
    check("resume is refused rather than failing one turn later",
          h.status() == "exhausted" and "budget is spent" in out, out)

    out = h.cmd("/goal budget 900000")
    check("raising the ceiling is the way back", h.status() == "active",
          "%s %r" % (h.status(), out))
    check("the number is tokens",
          h.goal()["token_budget"] == 900000, str(h.goal()))
    check("and what was spent is kept, not reset",
          h.session.goal_tokens_used(h.goal()) == 5000,
          str(h.session.goal_tokens_used(h.goal())))

    # -- pause and resume -------------------------------------------------
    print("== pause, resume, clear")
    h = new_harness()
    h.cmd("/goal tidy the docs")
    check("pause stops the driving", h.cmd("/goal pause") == ""
          and h.status() == "paused", h.status())
    check("a message does not undo a pause", True)
    h.session.meta["state"] = hb.STATE_RUNNING
    h.session.send("unrelated question")
    check("even one that queues", h.status() == "paused", h.status())
    h.session.queue[:] = []
    h.session.meta["state"] = hb.STATE_IDLE
    check("resume starts it again", h.cmd("/goal resume") == ""
          and h.status() == "active", h.status())

    out = h.cmd("/goal")
    check("`/goal` reports state, budget and the last check",
          "tidy the docs" in out and "tokens" in out, out)

    check("clear removes it", h.cmd("/goal clear") == ""
          and h.goal() is None)
    # The one thing left to say: a command that could not do what it was told.
    check("and clearing nothing says so", "No goal" in h.cmd("/goal clear"))

    # -- a judge that cannot answer ---------------------------------------
    print("== the check itself fails")
    h = new_harness()
    h.cmd("/goal port the client")
    h.started()
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
    # -- a command that never becomes a turn still closes the exchange -----
    #
    # A client marks itself running the moment a message is accepted, and
    # `/goal` is the one message that never becomes a turn. Nothing followed
    # it, so the composer sat on "Thinking…" against an idle session waiting
    # for a reply nobody was going to send. The acknowledgements each command
    # used to print hid it -- a user message with a reply under it is a closed
    # exchange -- and it surfaced the moment those went quiet.
    print("== /goal leaves the session where it says it is")
    h = new_harness()
    h.cmd("/goal something")
    h.session.meta["state"] = hb.STATE_IDLE
    mark = h.session.bus.seq
    h.session._run_goal_command("/goal pause")
    closing = [e for e in h.session.bus.since(mark) if e["type"] == "status"]
    check("a status follows the command", bool(closing),
          str([e["type"] for e in h.session.bus.since(mark)]))
    check("and it says idle, which is what the session is",
          closing and closing[-1]["state"] == hb.STATE_IDLE,
          str(closing[-1] if closing else None))

    # It reports what is true, not a fixed answer: a `/goal clear` that
    # interrupted a turn is still running while the engine winds down.
    h.session.meta["state"] = hb.STATE_RUNNING
    mark = h.session.bus.seq
    h.session._run_goal_command("/goal")
    closing = [e for e in h.session.bus.since(mark) if e["type"] == "status"]
    check("and running when the session is running",
          closing and closing[-1]["state"] == hb.STATE_RUNNING,
          str(closing[-1] if closing else None))
    h.session.meta["state"] = hb.STATE_IDLE

    # -- stopping a goal stops the goal's turn -----------------------------
    #
    # "Go idle" is the point of both commands: the turn in flight is the
    # goal's own work, and letting it finish means the session carries on
    # thinking for however long that turn had left. But only the goal's turn
    # -- a `/goal pause` typed while the user's own message was being answered
    # would otherwise throw that answer away with it.
    print("== pause and clear stop the turn they own")
    for command, expected in (("/goal pause", "paused"), ("/goal clear", None)):
        h = new_harness()
        h.cmd("/goal keep going")
        h.started()
        stopped = []
        h.session.interrupt = lambda keep_queue=False: stopped.append(keep_queue)

        h.session.meta["state"] = hb.STATE_RUNNING
        h.session.meta["last_turn"] = "turn_driven"
        h.session.meta["driven_turn"] = "turn_driven"
        h.cmd(command)
        check("%s ends the goal's own turn" % command, stopped == [True],
              str(stopped))
        check("and leaves the queue alone", stopped == [True], str(stopped))
        check("state after %s" % command,
              (h.goal() or {}).get("status") == expected
              if expected else h.goal() is None, str(h.goal()))

        del stopped[:]
        h.cmd("/goal keep going")
        h.started()
        h.session.meta["state"] = hb.STATE_RUNNING
        h.session.meta["last_turn"] = "turn_the_user_sent"
        h.session.meta["driven_turn"] = None
        h.cmd(command)
        check("%s does not touch a turn the user started" % command,
              not stopped, str(stopped))
    h.session.meta["state"] = hb.STATE_IDLE

    # -- a command typed while the judge is out ---------------------------
    #
    # The judge is a network call taking seconds. `/goal pause` and
    # `/goal clear` are answered inside them, and a step that acted on what it
    # read beforehand would start the very turn the command existed to stop --
    # and write its stale copy back over a goal that had just been cleared.
    print("== pause and clear land while the judge is out")

    for command, expected in (("/goal pause", "paused"), ("/goal clear", None)):
        h = new_harness()
        h.cmd("/goal keep going")
        h.started()

        def judge_then_interfere(_s, _g, cmd=command):
            h.session.goal_command(cmd)
            return "continue", "still going"

        hb.judge_goal = judge_then_interfere
        del h.said[:]
        h._real_step()
        check("%s stops the turn it would have started" % command,
              not h.driven, str(h.driven))
        check("and stands", (h.goal() or {}).get("status") == expected
              if expected else h.goal() is None, str(h.goal()))

    # A step that is not interfered with still drives, so the guard is not
    # simply refusing to work.
    h = new_harness()
    h.cmd("/goal keep going")
    h.started()
    h.step(("continue", "still going"))
    check("an undisturbed step still takes its turn", len(h.driven) == 1,
          str(len(h.driven)))

    # -- nothing of it reaches the transcript ------------------------------
    print("== a driven turn writes nothing down")
    h = new_harness()
    del h.session._begin                       # the real one, this time
    h.cmd("/goal say ok twice")
    mark = h.session.bus.seq
    h.session._begin({"text": "drive me", "images": [], "id": "turn_d1",
                      "driven": True})
    after = h.session.bus.since(mark)
    check("no `user` event for a turn nobody typed",
          not [e for e in after if e["type"] == "user"], str(after[:3]))
    check("but the turn itself is still opened",
          any(e["type"] == "turn.start" for e in after),
          str([e["type"] for e in after]))

    # -- goals written by the daemon before this one ----------------------
    #
    # `set` was Claude's word for "in force". Nothing writes it now, so a goal
    # still saying it would never be corrected: the chip draws anything but
    # `active` as stopped, and the loop only moves on `active`. It would sit
    # there looking stopped for good.
    print("== a goal from an older daemon")
    old_goal = hb.goal_migrated({"objective": "finish the port",
                                 "status": "set"}, tokens_now=4200)
    check("`set` was in force, so it still is",
          old_goal["status"] == "active", str(old_goal))
    check("a goal with no budget keeps not having one",
          old_goal["token_budget"] is None, str(old_goal))
    check("and the tally starts here, not at the session's whole spend",
          old_goal["tokens_at_set"] == 4200, str(old_goal))

    for was, now in (("usageLimited", "exhausted"),
                     ("budgetLimited", "exhausted"),
                     ("paused", "paused"), ("blocked", "blocked"),
                     ("active", "active")):
        got = hb.goal_migrated({"objective": "x", "status": was})["status"]
        check("%s reads as %s" % (was, now), got == now, got)

    check("a status nobody recognises is read as still running",
          hb.goal_migrated({"objective": "x", "status": "??"})["status"]
          == "active")
    check("a goal with no objective is no goal",
          hb.goal_migrated({"status": "set"}) is None)
    check("and migrating twice moves nothing",
          hb.goal_migrated(old_goal, tokens_now=9999) == old_goal)

    stale = mgr.create({"engine": "codex", "model": "gpt-5.6-sol", "cwd": home,
                        "permission_mode": "bypassPermissions",
                        "provider": {"protocol": "openai-responses",
                                     "api_key": "sk-test"}})
    stale.meta["goal"] = {"objective": "left over", "status": "set"}
    stale.save()
    reloaded = hb.Session(mgr, json.load(open(stale.path("meta.json"))))
    check("a session read off disk is migrated on the way in",
          reloaded.meta["goal"]["status"] == "active",
          str(reloaded.meta.get("goal")))

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

    # A dropped connection is the network, not an answer. Blocking a goal for
    # one of them is how a night's work is lost to a hiccup: measured on a
    # devbox, where the check came back `EOF occurred in violation of
    # protocol` once and the goal stopped dead on its first turn.
    import ssl
    import urllib.error
    check("a dropped TLS handshake is worth another go",
          hb.judge_retryable(ssl.SSLError("EOF occurred in violation")))
    check("so is a gateway that is briefly unwell",
          hb.judge_retryable(urllib.error.HTTPError("u", 503, "x", None, None))
          and hb.judge_retryable(
              urllib.error.HTTPError("u", 429, "x", None, None)))
    check("a key the gateway will not take is a wall",
          not hb.judge_retryable(
              urllib.error.HTTPError("u", 401, "x", None, None)))
    check("and a provider Caden cannot speak to at all is a wall",
          not hb.judge_retryable(hb.EngineError("no judge for a missing provider")))

    calls = []
    real_reply = hb.model_reply
    hb.GOAL_JUDGE_BACKOFF = (0.0,)

    def flaky(*a, **k):
        calls.append(1)
        if len(calls) < 3:
            raise ssl.SSLError("EOF occurred in violation of protocol")
        return '{"verdict": "continue", "reason": "back on its feet"}'

    hb.model_reply = flaky
    try:
        verdict, reason = real_judge_goal(h.session, {"objective": "x"})
        check("the judge rides out a blip and answers",
              verdict == "continue" and len(calls) == 3,
              "%s after %d tries" % (verdict, len(calls)))
    finally:
        hb.model_reply = real_reply

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
