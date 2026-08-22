#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""A stream must not end before the event that says it ended.

`EventBus.wait` drains before it reports a close, on purpose -- checking
`closed` first drops the last event for every subscriber that had not caught
up. The SSE loop then read `bus.closed` itself, straight after writing what
`wait` handed back, which put the same hazard back one level up: anything
emitted in the gap between those two lines was written to the log, never sent,
and the stream closed as if it had been.

The event most likely to land in that gap is the last one, because closing is
what follows it -- a job's `done`, a session's `turn.end`. Observed as an
install whose events all arrived and which then reported "stream ended without
a result", roughly one run in four.

    python3 tests/stream_close_test.py
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
    os.environ["CADEN_HOME"] = home
    spec = importlib.util.spec_from_file_location("heartbeat_stream_test", SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Sink(object):
    """The socket half of a Handler, kept in memory."""

    def __init__(self):
        self.chunks = []
        self.wfile = self
        self.close_connection = False

    def write(self, data):
        self.chunks.append(data.decode("utf-8"))

    def flush(self):
        pass

    def send_response(self, *a):
        pass

    def send_header(self, *a):
        pass

    def end_headers(self):
        pass

    def text(self):
        return "".join(self.chunks)


def racy_bus(caden, path):
    """A bus that finishes in exactly the window the loop used to ignore.

    The terminal event is emitted and the bus closed *after* `wait` has picked
    its return value and *before* the caller looks at `closed` again -- which
    is what a job thread doing `emit("done"); close()` does to a subscriber
    that is mid-write.
    """
    class Racy(caden.EventBus):
        def __init__(self, p):
            caden.EventBus.__init__(self, p)
            self.primed = False

        def wait(self, after, timeout):
            if not self.primed:
                self.primed = True
                self.emit("step", text="working")
            events = caden.EventBus.wait(self, after, timeout)
            if events and not self.closed:
                self.emit("done", ok=True, result={"engine": "codex"})
                self.close()
            return events

    return Racy(path)


def events_in(text):
    out = []
    for line in text.splitlines():
        if not line.startswith("data: "):
            continue
        try:
            ev = json.loads(line[6:])
        except ValueError:
            continue
        if isinstance(ev, dict) and ev.get("type"):
            out.append(ev)
    return out


def main():
    home = tempfile.mkdtemp(prefix="caden-stream-")
    keep = os.environ.get("CADEN_HOME")
    try:
        caden = load_daemon(home)
        caden.ensure_dirs()
        bus = racy_bus(caden, os.path.join(home, "jobs", "j_test.jsonl"))
        sink = Sink()
        # `after=0`, the cold subscribe every client does.
        caden.Handler.stream_events(sink, bus, 0, follow=True, idle_timeout=600)
        text = sink.text()
        got = events_in(text)
        kinds = [e["type"] for e in got]

        check("the events written before the close are delivered",
              "step" in kinds, str(kinds))
        check("the terminal event is delivered too",
              "done" in kinds, str(kinds))
        check("and it carries its result",
              any(e["type"] == "done" and e.get("result") for e in got),
              str([e for e in got if e["type"] == "done"]))
        check("the stream still ends", "event: eof" in text)
        # Ordering matters as much as delivery: a client that folds `eof`
        # first has already given up by the time `done` arrives.
        check("the close comes last",
              text.rindex("event: eof") > text.rindex('"type":"done"')
              if '"type":"done"' in text else False)
    finally:
        shutil.rmtree(home, ignore_errors=True)
        if keep is None:
            os.environ.pop("CADEN_HOME", None)
        else:
            os.environ["CADEN_HOME"] = keep

    if failed:
        print("stream_close_test: FAILED")
        for f in failed:
            print("  - %s" % f)
        return 1
    print("stream_close_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
