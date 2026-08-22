#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""`/goal` against a Codex app-server that runs turns of its own.

Every failure here was a real one, and they share a shape: a goal-driven run
never stops long enough for anything else to get a word in.

  * `/goal clear` travelled as an ordinary message, so it queued -- and once a
    goal is set the server starts its next turn milliseconds after the last
    one ends, leaving no idle slot for the queue to drain into. The one
    command whose job is to stop the loop lost the race to the loop, forever
    against a real codex. What showed on screen was a turn divider (the turn
    that just ended) followed by more thinking (the next one).
  * Running it off the queue instead put it in the gap between two of the
    server's turns, where the engine holds no turn of its own -- and emitting
    into no turn makes the session adopt one, which nothing is then left to
    close. The session stuck at `running` for good, taking the queue with it.
  * Two `/goal` replies inside one turn shared a block id, so the second
    overwrote the first.
  * Saving session meta from the control thread while the reader thread saved
    it too raced on a scratch file named after the pid alone.

The stand-in below is the smallest app-server that reproduces the setting: it
answers the goal RPCs, and while a goal is set it runs turns back to back,
each one long enough that only an explicit `turn/interrupt` cuts it short.

  python3 tests/goal_test.py [--home DIR] [--port N]
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
failed = []

FAKE_CODEX = r'''#!/usr/bin/env python3
"""Stand-in for `codex app-server`, written by tests/goal_test.py."""
import sys, json, threading, time, itertools

if len(sys.argv) > 1 and sys.argv[1] == 'debug':
    sys.exit(1)                      # no model catalog; codex keeps its window

out_lock = threading.Lock()
def send(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj) + '\n')
        sys.stdout.flush()

goal = None
loop_stop = threading.Event()
abort = threading.Event()
seq = itertools.count(1)

def run_turn(tag):
    tid = 't%d' % next(seq)
    abort.clear()
    send({'jsonrpc': '2.0', 'method': 'turn/started', 'params': {'turn': {'id': tid}}})
    # Long, and deaf to the goal being cleared: a real agent turn only stops
    # when it is interrupted.
    for i in range(20):
        if abort.is_set():
            send({'jsonrpc': '2.0', 'method': 'turn/completed',
                  'params': {'turn': {'id': tid, 'status': 'aborted'}}})
            return
        send({'jsonrpc': '2.0', 'method': 'item/reasoning/summaryTextDelta',
              'params': {'itemId': 'r1', 'delta': '%s %d. ' % (tag, i)}})
        time.sleep(0.1)
    send({'jsonrpc': '2.0', 'method': 'turn/completed',
          'params': {'turn': {'id': tid, 'status': 'completed', 'durationMs': 2000}}})

def goal_loop():
    while not loop_stop.is_set():
        run_turn('goal')
        time.sleep(0.02)             # the gap the queue drain has to win

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    method, rid, p = msg.get('method'), msg.get('id'), msg.get('params') or {}
    result = {}
    if method in ('thread/start', 'thread/resume'):
        result = {'thread': {'id': 'th_fake'}}
    elif method == 'thread/goal/set':
        if p.get('objective'):
            goal = {'objective': p['objective'], 'status': 'active',
                    'tokensUsed': 10, 'tokenBudget': 100000}
        elif goal:
            goal = dict(goal, status='active')
        result = {'goal': goal}
    elif method == 'thread/goal/get':
        result = {'goal': goal}
    elif method == 'thread/goal/clear':
        goal = None
        loop_stop.set()
    elif method == 'turn/interrupt':
        abort.set()
    if rid is not None:
        send({'jsonrpc': '2.0', 'id': rid, 'result': result})
    if method == 'turn/start':
        threading.Thread(target=run_turn, args=('user',), daemon=True).start()
    elif method == 'thread/goal/set' and goal:
        loop_stop.clear()
        threading.Thread(target=goal_loop, daemon=True).start()
'''


def check(label, ok, detail=""):
    print("  %s   %s%s" % ("ok  " if ok else "FAIL", label,
                           (" — " + detail) if detail else ""))
    if not ok:
        failed.append(label)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main():
    args = sys.argv[1:]
    home = None
    port = None
    for i, a in enumerate(args):
        if a == "--home" and i + 1 < len(args):
            home = args[i + 1]
        if a == "--port" and i + 1 < len(args):
            port = int(args[i + 1])
    home = home or tempfile.mkdtemp(prefix="caden-goal-")
    port = port or free_port()

    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(os.path.join(home, "bin"))
    shutil.copy(os.path.join(ROOT, "server", "heartbeat.py"), home)
    # $CADEN_HOME/bin heads the toolchain's search path, so this wins over any
    # codex installed on the machine running the suite.
    fake = os.path.join(home, "bin", "codex")
    with open(fake, "w") as fh:
        fh.write(FAKE_CODEX)
    os.chmod(fake, 0o755)

    daemon = subprocess.Popen(
        [sys.executable, os.path.join(home, "heartbeat.py"),
         "--foreground", "--port", str(port)],
        cwd=home, env=dict(os.environ, CADEN_HOME=home),
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        base = "http://127.0.0.1:%d" % port
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "/v1/ping", timeout=2)
                break
            except Exception:
                time.sleep(0.2)
        token = open(os.path.join(home, "token")).read().strip()

        def api(method, path, body=None):
            req = urllib.request.Request(base + path, method=method)
            req.add_header("authorization", "Bearer " + token)
            data = None
            if body is not None:
                req.add_header("content-type", "application/json")
                data = json.dumps(body).encode()
            with urllib.request.urlopen(req, data, timeout=30) as r:
                return json.loads(r.read() or b"{}")

        def new_session(title):
            return api("POST", "/v1/sessions", {
                "title": title, "cwd": home, "engine": "codex", "model": "m",
                "provider": {"api_key": "test-key",
                             "base_url": "http://127.0.0.1:1"}})["session"]["id"]

        def send(sid, text):
            api("POST", "/v1/sessions/%s/messages" % sid, {"text": text})

        def sess(sid):
            return api("GET", "/v1/sessions/%s?events=0" % sid)["session"]

        def events(sid):
            """The whole log, not the first page of it.

            `?events=1` answers with one page and says so in `truncated`; a
            hammering test outruns a page in well under a second, and reading
            only the first one made a check that counts replies look like a
            dropped reply.
            """
            out, after = [], 0
            for _ in range(200):
                page = api("GET", "/v1/sessions/%s?events=1&after=%d" % (sid, after))
                got = page.get("events", [])
                out.extend(got)
                if not got or not page.get("truncated"):
                    break
                after = got[-1]["seq"]
            return out

        def wait_idle(sid, limit=15.0):
            deadline = time.time() + limit
            start = time.time()
            while time.time() < deadline:
                if sess(sid)["state"] != "running":
                    return time.time() - start
                time.sleep(0.05)
            return None

        def replies(evs):
            return [e for e in evs if e["type"] == "text"]

        def mark_seq(sid):
            """Where to start reading from, as a sequence number.

            Not a list length: the log keeps growing while the mark is being
            taken, so an index-based window slid by an event or two and a
            reply that had arrived fell outside it.
            """
            evs = events(sid)
            return evs[-1]["seq"] if evs else 0

        def since(sid, seq):
            return [e for e in events(sid) if e["seq"] > seq]

        def until(pred, timeout=20.0):
            deadline = time.time() + timeout
            while time.time() < deadline:
                if pred():
                    return True
                time.sleep(0.05)
            return False

        sid = new_session("goal")
        send(sid, "/goal alpha")
        time.sleep(1.0)
        goal = sess(sid).get("goal")
        check("a goal set from idle takes",
              bool(goal) and goal.get("objective") == "alpha", json.dumps(goal))
        check("and is acknowledged",
              any("Goal set" in (e.get("text") or "") for e in replies(events(sid))))
        check("the server's own run shows as running",
              sess(sid)["state"] == "running", sess(sid)["state"])

        # The command that used to queue behind the run it exists to steer.
        mark = mark_seq(sid)
        send(sid, "/goal")
        until(lambda: any("Current goal" in (e.get("text") or "")
                          for e in replies(since(sid, mark))))
        fresh = since(sid, mark)
        check("a query mid-run is not queued",
              not any(e["type"] == "queued" for e in fresh),
              str([e["type"] for e in fresh]))
        check("and answers with the current goal",
              any("Current goal" in (e.get("text") or "") for e in replies(fresh)))

        # Forty of them, so some land in the gap between the server's turns --
        # where there is no turn of ours to emit into.
        mark = mark_seq(sid)

        def answered():
            return [e for e in replies(since(sid, mark))
                    if "Current goal" in (e.get("text") or "")]

        for _ in range(40):
            send(sid, "/goal")
            time.sleep(0.025)
        until(lambda: len(answered()) >= 40)
        answers = answered()
        blocks = [e.get("block") for e in answers]
        check("every query across the turn boundaries is answered",
              len(answers) == 40, "%d/40" % len(answers))
        check("no two answers share a block",
              len(set(blocks)) == len(blocks),
              "%d unique of %d" % (len(set(blocks)), len(blocks)))
        check("none of them opened a turn of their own",
              not any((b or "").startswith("t:") for b in blocks),
              str([b for b in blocks if (b or "").startswith("t:")][:3]))

        # Clearing stops the run now, not after the turn in flight. Nothing
        # is queued behind it on purpose: a message waiting its turn would
        # start one the moment the run stopped, which is correct and would
        # read here as the run never having stopped.
        send(sid, "/goal clear")
        took = wait_idle(sid)
        # Generous on purpose: what this separates is "stops" from "never
        # stopped", and a loaded machine is allowed to be slow about it.
        check("clearing stops the run", took is not None and took < 5.0,
              "%s" % ("%.0f ms" % (took * 1000) if took else "never"))
        time.sleep(2.0)
        check("and it stays stopped", sess(sid)["state"] != "running",
              sess(sid)["state"])
        check("the goal is gone", not sess(sid).get("goal"),
              json.dumps(sess(sid).get("goal")))

        # A normal message still waits its turn: the bypass is for control
        # calls, not for work. On a session of its own, so the turn it goes on
        # to start cannot be mistaken for the goal run failing to stop.
        queued = new_session("goal-queue")
        send(queued, "/goal beta")
        time.sleep(0.6)
        mark = mark_seq(queued)
        send(queued, "an ordinary message")
        until(lambda: any(e["type"] == "queued" for e in since(queued, mark)))
        check("an ordinary message still queues",
              any(e["type"] == "queued" for e in since(queued, mark)),
              str([e["type"] for e in since(queued, mark)]))
        send(queued, "/goal clear")

        # The forms that touch no running turn still behave. Waited for by
        # their answer, not by the session going idle: a control call takes no
        # turn, so there is never a running state to fall out of.
        other = new_session("goal-idle")
        send(other, "/goal clear")
        check("clearing with no goal set is answered",
              until(lambda: any("cleared" in (e.get("text") or "").lower()
                                for e in replies(events(other)))))
        mark = mark_seq(other)
        send(other, "/goal resume")
        check("resume is answered",
              until(lambda: any("resumed" in (e.get("text") or "").lower()
                                for e in replies(since(other, mark)))))
        check("neither left the session running",
              sess(other)["state"] != "running", sess(other)["state"])

        # Nothing raced the meta file into an unreadable state.
        meta = os.path.join(home, "sessions", sid, "meta.json")
        try:
            json.load(open(meta))
            readable = True
        except Exception as exc:
            readable = False
            check("session meta survived the concurrent saves", False, str(exc))
        if readable:
            check("session meta survived the concurrent saves", True)
        leftovers = [f for f in os.listdir(os.path.dirname(meta)) if ".tmp." in f]
        check("no scratch files left behind", not leftovers, str(leftovers))
    finally:
        daemon.terminate()
        daemon.wait(timeout=10)

    print("\n%s" % ("goal: OK" if not failed
                    else "goal: %d failed" % len(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
