#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""The engine must outlive the daemon.

Restarting the daemon used to kill every engine with it, and the cost landed
on the next turn: Claude Code redistributes its prompt-cache breakpoints when
it resumes, so the whole conversation is re-written into the cache, and any
tool call that was in flight is left in the transcript with no output. This
walks the transport through a daemon replacement and checks the engine is
still the same process, still reachable, and that nothing in its output was
lost or replayed.

  python3 tests/detach_test.py --home /tmp/caden-detach
"""
import json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "server"))

failed = []


def until(pred, timeout=8.0):
    """Wait for an asynchronous result instead of guessing how long it takes.

    The engine is a separate process that has to start before it can answer,
    and a fixed sleep either makes the suite slow or makes it flaky on a busy
    machine -- this one was flaky.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.05)
    return False


def check(label, ok, detail=""):
    print("  %s   %s%s" % ("ok  " if ok else "FAIL", label,
                           " — %s" % detail if detail else ""))
    if not ok:
        failed.append(label)


def main():
    home = "/tmp/caden-detach-test"
    for i, a in enumerate(sys.argv):
        if a == "--home" and i + 1 < len(sys.argv):
            home = sys.argv[i + 1]
    subprocess.run(["rm", "-rf", home], check=False)
    os.environ["CADEN_HOME"] = home

    import importlib
    heartbeat = importlib.import_module("heartbeat")
    heartbeat.ensure_dirs()

    # An "engine" that echoes what it is told, so the transport is what is
    # under test rather than any real CLI's behaviour.
    #
    # Written in Python with an explicit flush on purpose: a shell doing the
    # same thing block-buffers its stdout when it points at a file, which no
    # real engine does and which would make this test measure the double.
    script = os.path.join(home, "fake-engine")
    os.makedirs(home, exist_ok=True)
    with open(script, "w") as fh:
        fh.write("#!/usr/bin/env python3\n"
                 "import sys\n"
                 "# readline, not `for line in sys.stdin`: iteration reads\n"
                 "# ahead, which would hold a line back until more arrive.\n"
                 "while True:\n"
                 "    line = sys.stdin.readline()\n"
                 "    if not line:\n"
                 "        continue\n"
                 "    sys.stdout.write(line)\n"
                 "    sys.stdout.flush()\n")
    os.chmod(script, 0o755)

    heartbeat.SESSIONS = heartbeat.SessionManager()
    sess = heartbeat.SESSIONS.create({"engine": "mock", "model": "m", "title": "detach"})

    class Engine(heartbeat.BaseEngine):
        """Just enough of a real engine to exercise the staleness check: the
        signature is the session's model, so changing the model moves it."""
        def argv(self):
            return [script]

        refuse = False

        def spawn_signature(self, argv):
            return heartbeat.json_dumps({"argv": argv,
                                     "binary": self.binary_fingerprint(argv[0]),
                                     "model": self.session.meta.get("model")})

        def hot_settings(self):
            return {"effort": self.session.meta.get("effort")}

        def apply_hot_settings(self, want, have):
            if self.refuse:
                raise heartbeat.EngineError("too old to be told")
            self.write_line(heartbeat.json_dumps({"hot": want["effort"]}))

    seen = []
    eng = Engine(sess)
    eng.on_line = lambda line: seen.append(line)
    eng.spawn([script])
    eng.remember_signature([script])
    pid = eng.pid
    check("engine starts detached", heartbeat.pid_alive(pid), "pid %s" % pid)

    eng.write_line('{"n":1}')
    eng.write_line('{"n":2}')
    until(lambda: len(seen) >= 2)
    check("output reaches the daemon", seen == ['{"n":1}', '{"n":2}'], repr(seen))

    # --- the daemon goes away -------------------------------------------
    eng.shutdown()                       # detach: stop reading, leave running
    time.sleep(0.2)
    check("engine survives the daemon letting go", heartbeat.pid_alive(pid))

    # It keeps working with nobody listening: this is the turn-in-flight case.
    eng2_probe = heartbeat.BaseEngine(sess)
    eng2_probe.pid = pid
    eng2_probe.write_line('{"n":3}')
    until(lambda: os.path.getsize(eng.io_paths()[1]) >= 24)

    # --- a new daemon comes up ------------------------------------------
    seen2 = []
    eng2 = Engine(sess)
    eng2.on_line = lambda line: seen2.append(line)
    adopted = eng2.adopt()
    check("a new daemon adopts it", adopted and eng2.pid == pid)
    until(lambda: len(seen2) >= 1)
    check("output produced while nobody listened is not lost",
          seen2 == ['{"n":3}'], repr(seen2))

    eng2.write_line('{"n":4}')
    until(lambda: len(seen2) >= 2)
    check("the adopted engine is still writable",
          seen2 == ['{"n":3}', '{"n":4}'], repr(seen2))
    check("nothing is replayed twice", '{"n":1}' not in seen2)

    # --- settings ---------------------------------------------------------
    # An adopted engine still has to notice that the settings moved while it
    # was unattended; otherwise a model change made across a daemon restart
    # would never reach the process.
    check("an adopted engine is not stale on its own", eng2.stale() is False)
    sess.meta["model"] = "different"
    check("an adopted engine notices a settings change", eng2.stale() is True)
    sess.meta["model"] = "m"

    # --- a turn in flight survives the handover -----------------------------
    # Adoption restores the transport; without the turn id going with it, the
    # events that follow arrive unattributed and nothing closes the turn.
    sess.meta["state"] = heartbeat.STATE_RUNNING
    sess.meta["last_turn"] = "turn_inflight"
    sess.save()
    eng5 = Engine(sess)
    eng5.on_line = lambda line: None
    check("a running turn is carried across adoption",
          eng5.adopt() and eng5._turn == "turn_inflight")
    eng5.shutdown()
    sess.meta["state"] = heartbeat.STATE_IDLE
    sess.meta.pop("last_turn", None)
    sess.save()

    # --- identity -------------------------------------------------------
    sess.meta["engine_token"] = "not-the-same-process"
    eng3 = Engine(sess)
    check("a recycled pid is not adopted", eng3.adopt() is False)

    # --- settings that do not need a new process ----------------------------
    # The point of the split: effort moves without the process moving, so the
    # prompt cache survives a change the user makes between turns.
    check("what the process was told survives adoption",
          eng2._hot == {"effort": None}, repr(eng2._hot))
    sess.meta["effort"] = "high"
    check("a hot setting reconciles in place", eng2.reconcile() is True)
    check("reconciling did not replace the process", heartbeat.pid_alive(pid))
    until(lambda: '{"hot": "high"}' in seen2 or '{"hot":"high"}' in seen2)
    check("the engine was actually told", seen2[-1].replace(" ", "") == '{"hot":"high"}',
          repr(seen2[-1]))
    check("and the daemon recorded it",
          sess.meta.get("engine_hot") == {"effort": "high"},
          repr(sess.meta.get("engine_hot")))
    check("a hot setting does not make the engine stale", eng2.stale() is False)

    # Nothing applies settings on its own, so a change made while the engine
    # runs itself has to be visible as waiting rather than as done.
    sess.engine = eng2
    sess.meta["effort"] = "xhigh"
    check("a waiting change is reported as pending",
          sess.settings_pending() is True)
    eng2.reconcile()
    check("and stops being pending once it lands",
          sess.settings_pending() is False)
    sess.engine = None

    # An engine that will not take the change has to be replaced instead --
    # which is what an install too old to know the control subtype looks like.
    eng2.refuse = True
    sess.meta["effort"] = "max"
    check("a refused change asks for a new process", eng2.reconcile() is False)
    eng2.refuse = False
    sess.meta["effort"] = "high"

    # Upgrading the CLI leaves argv alone -- only the file behind it moves.
    # Last, because from here on the engine is stale for good.
    os.utime(script, (time.time() + 60, time.time() + 60))
    check("an adopted engine notices the binary being replaced",
          eng2.stale() is True)

    # --- an engine that dies unattended still gets the last word ------------
    # The output past the reader's offset is where a crash explains itself.
    # Adoption fails for a dead process, so nothing would ever read it.
    dying = heartbeat.SESSIONS.create({"engine": "mock", "model": "m", "title": "dying"})
    eng7 = Engine(dying)
    heard = []
    eng7.on_line = lambda line: heard.append(line)
    eng7.spawn([script])
    eng7.write_line('{"n":"seen"}')
    until(lambda: heard == ['{"n":"seen"}'])
    eng7.shutdown()                       # the daemon lets go, offset flushed
    # ...and the engine writes its last words with nobody listening, then dies.
    with open(eng7.io_paths()[1], "a") as fh:
        fh.write('{"n":"last words"}\n')
    eng7.kill()
    try:
        eng7.proc.wait(timeout=5)
    except Exception:
        pass

    recovered = []
    eng8 = Engine(dying)
    eng8.on_line = lambda line: recovered.append(line)
    check("a dead engine cannot be adopted", eng8.adopt() is False)
    check("but its last output is still recovered",
          eng8.drain_final_output() == 1 and recovered == ['{"n":"last words"}'],
          repr(recovered))
    again = Engine(dying)
    again.on_line = lambda line: recovered.append(line)
    check("and is not recovered twice", again.drain_final_output() == 0)
    heartbeat.SESSIONS.delete(dying.id)

    # --- idle engines are reaped ------------------------------------------
    # Detaching made engines outlive the daemon; without this they outlive
    # everything. What is spared matters as much as what is not, so this runs
    # on its own session -- reaping ends with a dead process.
    idle = heartbeat.SESSIONS.create({"engine": "mock", "model": "m", "title": "idle"})
    eng6 = Engine(idle)
    eng6.on_line = lambda line: None
    eng6.spawn([script])
    idle.engine = eng6
    pid6 = eng6.pid
    idle.meta["state"] = heartbeat.STATE_IDLE
    old_enough = heartbeat.now_ms() - (heartbeat.ENGINE_IDLE_SECONDS + 60) * 1000

    idle.meta["last_active_at"] = heartbeat.now_ms()
    check("a session used just now is left alone",
          heartbeat.SESSIONS.reap_idle_engines() == [])

    idle.meta["last_active_at"] = old_enough
    idle.meta["state"] = heartbeat.STATE_RUNNING
    check("a running turn is left alone however old",
          heartbeat.SESSIONS.reap_idle_engines() == [])

    idle.meta["state"] = heartbeat.STATE_IDLE
    idle.meta["goal"] = {"objective": "keep going", "status": "active"}
    check("a standing goal is left alone",
          heartbeat.SESSIONS.reap_idle_engines() == [])

    idle.meta["goal"] = None
    check("an idle engine past the cutoff is stopped",
          heartbeat.SESSIONS.reap_idle_engines() == [idle.id])
    try:
        eng6.proc.wait(timeout=5)
    except Exception:
        pass
    check("and the process is really gone", not heartbeat.pid_alive(pid6))
    check("with nothing left to adopt", idle.meta.get("engine_pid") is None)
    heartbeat.SESSIONS.delete(idle.id)

    # --- deleting a session takes its engine with it ------------------------
    # A separate session, so the one under test keeps its engine: deleting is
    # the one path where detaching would strand a process whose home is about
    # to be removed underneath it.
    doomed = heartbeat.SESSIONS.create({"engine": "mock", "model": "m",
                                    "title": "doomed"})
    eng4 = Engine(doomed)
    eng4.on_line = lambda line: None
    eng4.spawn([script])
    doomed.engine = eng4
    pid4 = eng4.pid
    heartbeat.SESSIONS.delete(doomed.id)
    try:
        eng4.proc.wait(timeout=5)   # reap, as with the zombie note below
    except Exception:
        pass
    check("deleting a session stops its engine", not heartbeat.pid_alive(pid4))

    eng2.kill()
    # This process is both the spawner and the killer, so the engine becomes a
    # zombie child of the test until it is reaped -- and a zombie still answers
    # `kill(pid, 0)`. A real adopting daemon is not the parent, so init reaps
    # it and the question does not arise; reap it here to ask the same one.
    try:
        eng.proc.wait(timeout=5)
    except Exception:
        pass
    check("kill really stops it", not heartbeat.pid_alive(pid))

    print("\ndetach-test: " + ("FAILED" if failed else "OK"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
