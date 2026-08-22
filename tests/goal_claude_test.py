#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""What Caden believes about a Claude goal, and why it believes it.

Claude's `/goal` is a stop condition living inside the CLI, and the CLI tells
stream-json almost nothing about it.  Measured end to end against a real
session: a goal that was met cleared itself and left no event, no attachment
and no metadata on the wire -- the only way to find out was to ask again.  So
Caden's picture is built from two things, and this covers both.

  * The CLI's own answers, which arrive as assistant messages it made up
    itself, marked `model: "<synthetic>"`.  Their wording is the contract.
  * A silent `/goal` after each turn, which is how a goal that ended on its
    own ever disappears.  It costs nothing: measured `num_turns: 0`, no API
    call, no change in the session's bill.

The refusals matter as much as the successes.  Caden writes the goal
optimistically when the command is sent -- otherwise the chip would not move
until the turn ended, which for a goal-driven turn is minutes -- so a command
the CLI turns down has to take that guess back.

  python3 tests/goal_claude_test.py
"""
import importlib.util, os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
failed = []


def check(label, ok, detail=""):
    print("  %s   %s%s" % ("ok  " if ok else "FAIL", label,
                           (" — " + detail) if detail else ""))
    if not ok:
        failed.append(label)


def load(home):
    os.environ["CADEN_HOME"] = home
    spec = importlib.util.spec_from_file_location(
        "heartbeat_goal", os.path.join(ROOT, "server", "heartbeat.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    home = tempfile.mkdtemp(prefix="caden-claude-goal-")
    heartbeat = load(home)
    heartbeat.SESSIONS = heartbeat.SessionManager()
    sess = heartbeat.SESSIONS.create(
        {"engine": "claude", "model": "m", "title": "t",
         "provider": {"protocol": "anthropic-messages", "api_key": "test-key"}})
    eng = heartbeat.ClaudeEngine(sess)
    sess.engine = eng

    def reply(text):
        """One synthetic answer from the CLI."""
        return eng._absorb_goal_reply(text)

    def goal():
        return sess.meta.get("goal")

    # -- what the CLI says when a goal is set and asked about ---------------
    check("a set is taken from the CLI's own words",
          reply("Goal set: ship the tests") and
          goal() == {"objective": "ship the tests", "status": "set"},
          repr(goal()))

    # The query answer is the rich one: how many turns it has been checked
    # for, and why the last check said no.
    reply("Goal active: ship the tests (3 turns)\nLast check: two are red")
    check("a query fills in how long it has been running",
          goal() and goal().get("checked") == "3 turns", repr(goal()))
    check("and why it has not been met",
          goal() and goal().get("last_reason") == "two are red", repr(goal()))

    reply("Goal active: ship the tests (not yet evaluated)")
    check("a goal not yet checked says so",
          goal() and goal().get("checked") == "not yet evaluated"
          and goal().get("last_reason") is None, repr(goal()))

    # -- the three ways it ends --------------------------------------------
    check("`No goal set` clears it",
          reply("No goal set. Usage: `/goal <condition>`") and goal() is None,
          repr(goal()))

    reply("Goal set: ship the tests")
    check("`Goal cleared:` clears it",
          reply("Goal cleared: ship the tests") and goal() is None, repr(goal()))

    reply("Goal set: ship the tests")
    check("the CLI giving up on it clears it too",
          reply('Goal cleared after an unrecoverable error (context limit): '
                '"ship the tests". Run /goal again to continue.')
          and goal() is None, repr(goal()))

    # -- a refusal takes the optimistic guess back -------------------------
    # `_note_goal` writes the goal when the command is sent and remembers what
    # was there before; these are the answers that mean it never happened.
    eng._note_goal("/goal " + "x" * 4200)
    check("the guess is on screen while the command is in flight",
          goal() is not None, repr(goal()))
    check("too long puts it back",
          reply("Goal condition is limited to 4000 characters (got 4200)")
          and goal() is None, repr(goal()))

    reply("Goal set: keep going")
    eng._note_goal("/goal something else")
    check("an untrusted workspace puts back what was there",
          reply("/goal is only available in trusted workspaces. Restart, "
                "accept the trust dialog, and try again.")
          and goal() == {"objective": "keep going", "status": "set"},
          repr(goal()))

    # -- anything else is not an answer about the goal ---------------------
    before = goal()
    check("an ordinary reply is not mistaken for one",
          reply("Sure -- the goal here is to keep the tests green.") is False
          and goal() == before, repr(goal()))
    check("nor is a slash command's answer about something else",
          reply("Set effort level to high (this session only): Comprehensive")
          is False and goal() == before, repr(goal()))

    # -- a stop hook that could not evaluate goes in the same slot ---------
    # Not a status of its own: that had two authors, and they overwrote each
    # other every turn.
    reply("Goal set: keep going")
    eng._note_hook_error("hook exited 1")
    check("a failed stop hook is recorded as the last check",
          goal() == {"objective": "keep going", "status": "set",
                     "last_reason": "hook exited 1"}, repr(goal()))
    check("and the CLI's next answer replaces it",
          reply("Goal active: keep going (2 turns)\nLast check: still red")
          and goal().get("last_reason") == "still red", repr(goal()))

    # -- the probe is only sent when there is something to ask about -------
    sess.meta["goal"] = None
    eng._goal_probe = False
    eng._probe_goal()
    check("no goal, no question", eng._goal_probe is False)

    sess.meta["goal"] = {"objective": "x", "status": "set"}
    eng._turn = "turn_1"
    eng._probe_goal()
    check("nor while a turn of its own is open", eng._goal_probe is False)
    eng._turn = None

    sess.meta["state"] = heartbeat.STATE_RUNNING
    eng._probe_goal()
    check("nor into a running session", eng._goal_probe is False)
    sess.meta["state"] = heartbeat.STATE_IDLE

    print("\n%s" % ("claude goal: OK" if not failed
                    else "claude goal: %d failed" % len(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
