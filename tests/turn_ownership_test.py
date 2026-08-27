#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""Who owns the turn when an engine works past the end of one.

Two engines, one failure. Codex starts a turn of its own after `/goal resume`,
and its `turn/started` can overtake the response to the RPC that caused it.
Claude never announces anything: when a stop hook blocks its stop it simply
keeps going past the `result` Caden already closed the turn on.

Both look the same from outside -- the session drops to `idle` while the
engine works for minutes -- and both cost more than appearances: interrupt
looks for a running turn, so there is no way to stop what is running.
"""
import importlib.util, json, os, shutil, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
failed = []


def until(pred, timeout=5.0):
    """Wait on something a background thread does, rather than guess at it."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.05)
    return False


def check(label, ok, detail=""):
    print("  %-6s %s%s" % ("ok" if ok else "FAIL", label,
                           (" — " + detail) if detail else ""))
    if not ok:
        failed.append(label)


def load(home):
    os.environ["CADEN_HOME"] = home
    spec = importlib.util.spec_from_file_location(
        "heartbeat_ct", os.path.join(ROOT, "server", "heartbeat.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    home = tempfile.mkdtemp(prefix="caden-codex-turn-")
    heartbeat = load(home)
    heartbeat.SESSIONS = heartbeat.SessionManager()
    sess = heartbeat.SESSIONS.create(
        {"engine": "codex", "model": "m", "title": "t",
         "provider": {"protocol": "openai-responses", "api_key": "test-key"}})
    sess.meta["native_id"] = "thread_1"

    eng = heartbeat.CodexEngine(sess)
    sess.engine = eng
    started = {"n": 0}
    eng.session.adopt_turn = lambda: (started.update(n=started["n"] + 1)
                                      or "turn_server")

    def notify(method, params):
        eng.on_line(json.dumps({"jsonrpc": "2.0", "method": method,
                                "params": params}))

    # --- the notification overtakes the response --------------------------
    # A slash command is mid-RPC: Caden's own turn is open. Set up by hand
    # rather than through `submit`, which would start a real codex.
    sess.meta["state"] = heartbeat.STATE_RUNNING
    sess.meta["last_turn"] = "turn_a"
    eng._turn = "turn_a"
    eng._turn_closed = False
    eng._server_took_over = False
    notify("turn/started", {"turn": {"id": "native_1"}})

    check("the server's run does not open a second turn", started["n"] == 0)
    check("the slash command's turn stays open", eng._turn_closed is False)
    check("and is marked as taken over", eng._server_took_over is True)

    # What `_slash_command` does at the end, with the guard in place.
    if not eng._server_took_over:
        eng._close_turn(error=None)
    check("so the command does not close it",
          sess.meta.get("state") == heartbeat.STATE_RUNNING,
          "state=%s" % sess.meta.get("state"))

    notify("turn/completed", {"turn": {"id": "native_1"}})
    check("the server's own completion closes it",
          eng._turn_closed and sess.meta.get("state") == heartbeat.STATE_IDLE,
          "state=%s" % sess.meta.get("state"))

    # --- the response comes back first ------------------------------------
    # The other order still has to work: Caden closes its turn, then the
    # server's run arrives with nothing open and is adopted.
    sess.meta["state"] = heartbeat.STATE_RUNNING
    sess.meta["last_turn"] = "turn_b"
    eng._turn = "turn_b"
    eng._turn_closed = False
    eng._server_took_over = False
    if not eng._server_took_over:
        eng._close_turn(error=None)
    check("closing first leaves nothing open", eng._turn_closed is True)
    notify("turn/started", {"turn": {"id": "native_2"}})
    check("and the server's run is adopted instead", started["n"] == 1)
    check("under the adopted turn id", eng._turn == "turn_server")

    # --- an engine that just keeps going ----------------------------------
    # Claude past a blocked stop: no notification, no new turn, just work
    # arriving after the turn it belonged to was closed.
    quiet = heartbeat.SESSIONS.create(
        {"engine": "claude", "model": "m", "title": "q",
         "provider": {"protocol": "anthropic-messages", "api_key": "k"}})
    eng2 = heartbeat.ClaudeEngine(quiet)
    quiet.engine = eng2
    quiet.meta["state"] = heartbeat.STATE_IDLE
    eng2._turn = None

    eng2.emit("usage", context_usage={})
    check("housekeeping does not conjure a turn",
          quiet.meta.get("state") == heartbeat.STATE_IDLE and eng2._turn is None)

    eng2.emit("tool.start", tool_id="t", name="Bash")
    check("work after the turn ended opens one",
          eng2._turn is not None and quiet.meta.get("state") == heartbeat.STATE_RUNNING,
          "turn=%s state=%s" % (eng2._turn, quiet.meta.get("state")))

    opened = eng2._turn
    eng2.emit("text", text="still going")
    check("and the work that follows lands in it", eng2._turn == opened)

    events = quiet.bus.since(0)
    tools = [e for e in events if e["type"] == "tool.start"]
    check("nothing is left unattributed",
          bool(tools) and all(e.get("turn") == opened for e in tools),
          repr([e.get("turn") for e in tools]))

    # --- a turn nothing will ever close ------------------------------------
    # Observed on a real codex session: a command finished after the turn it
    # belonged to had already ended. The item arrived with no turn open, one
    # was opened for it, and then nothing -- `turn/completed` only ever closes
    # a turn the *server* started, and the server had not started this one.
    # The session read "Thinking…" for as long as it was left alone, and stop
    # had no turn id to name so it signalled the app-server dead (exit -2).
    stray = heartbeat.SESSIONS.create(
        {"engine": "codex", "model": "m", "title": "s",
         "provider": {"protocol": "openai-responses", "api_key": "k"}})
    stray.meta["native_id"] = "thread_2"
    eng3 = heartbeat.CodexEngine(stray)
    stray.engine = eng3
    eng3.ORPHAN_QUIET_SECONDS = 1.0
    stray.meta["state"] = heartbeat.STATE_IDLE
    eng3._turn = None
    eng3._turn_closed = True
    eng3._native_turn = None
    stray.meta.pop("native_turn", None)

    eng3._on_item(False, {"type": "commandExecution", "id": "c1",
                          "command": "echo hi"})
    check("a stray command still opens a turn to hold it",
          eng3._turn is not None
          and stray.meta.get("state") == heartbeat.STATE_RUNNING,
          "turn=%s state=%s" % (eng3._turn, stray.meta.get("state")))
    opened3 = eng3._turn

    check("which stays open while the command runs",
          not until(lambda: eng3._turn_closed, timeout=1.6),
          "closed early")

    eng3._on_item(True, {"type": "commandExecution", "id": "c1",
                         "command": "echo hi", "exitCode": 0})
    # Both, in one wait. The engine's flag is set on the way into the close
    # and the session's state on the way out of it, so waiting on the first
    # and reading the second lands in the gap between them -- rarely alone,
    # reliably under the load of the whole suite.
    check("and closes once it is done and nothing follows",
          until(lambda: eng3._turn_closed
                and stray.meta.get("state") == heartbeat.STATE_IDLE,
                timeout=6.0),
          "closed=%s state=%s" % (eng3._turn_closed, stray.meta.get("state")))
    ends = [e for e in stray.bus.since(0) if e["type"] == "turn.end"]
    check("closed cleanly, not as a failure",
          len(ends) == 1 and not ends[0].get("error"), repr(ends))

    # The other half of the same fault: the card is keyed by tool id, and the
    # id used to be recomputed per event off whatever turn was open. An item
    # that opened its own turn got one id on the way in and another on the way
    # out, so the command sat in the transcript with no output for good.
    evs = stray.bus.since(0)
    starts = [e["tool_id"] for e in evs if e["type"] == "tool.start"]
    stops = [e["tool_id"] for e in evs if e["type"] == "tool.end"]
    check("the command's output reaches the card it started",
          starts and starts == stops, "start=%s end=%s" % (starts, stops))

    # Stopping one of these must not reach for the signal: there is no turn
    # for the server to interrupt, and the signal ends the whole app-server.
    stray.meta["state"] = heartbeat.STATE_IDLE
    eng3._turn = None
    eng3._turn_closed = True
    eng3._items = {}
    eng3._on_item(False, {"type": "commandExecution", "id": "c2",
                          "command": "sleep 1"})
    eng3._on_item(True, {"type": "commandExecution", "id": "c2",
                         "command": "sleep 1", "exitCode": 0})
    signalled = {"n": 0}
    eng3.terminate = lambda *a, **k: signalled.update(n=signalled["n"] + 1)
    eng3.interrupt()
    check("stopping it closes the turn instead of signalling",
          signalled["n"] == 0 and eng3._turn_closed is True,
          "signals=%d closed=%s" % (signalled["n"], eng3._turn_closed))

    # --- interrupting without losing what is queued ------------------------
    # Interrupt normally means "not this, and not what I lined up either".
    # The queued notice offers the other intent, and dropping the message
    # there would discard the very thing being hurried along.
    q = heartbeat.SESSIONS.create(
        {"engine": "mock", "model": "m", "title": "q2"})
    q.meta["state"] = heartbeat.STATE_RUNNING
    q.queue = [{"text": "next", "images": [], "id": "turn_queued"}]
    q.interrupt()
    check("a plain interrupt clears the queue", q.queue == [])

    q.meta["state"] = heartbeat.STATE_RUNNING
    q.queue = [{"text": "next", "images": [], "id": "turn_queued"}]
    q.interrupt(keep_queue=True)
    check("keep_queue leaves the next message in place",
          [i["id"] for i in q.queue] == ["turn_queued"])

    shutil.rmtree(home, ignore_errors=True)
    print("\nturn-ownership-test: " + ("FAILED" if failed else "OK"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
