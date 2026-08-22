#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""A message must reach the engine whole, however big it is.

Engine input goes down a FIFO opened non-blocking, and a non-blocking write
takes only what fits in the pipe and reports how much. A single os.write()
therefore truncates silently at the pipe buffer -- 64 KiB on Linux -- and the
engine receives half a line of JSON.

That is one pasted screenshot: base64 inflates by a third, so a ~48 KB image
already goes over. What the user saw was Claude Code printing "Error parsing
streaming input line", exiting 1, and the session sitting on "Thinking…" until
it gave up. Nothing in the daemon noticed, because the write had "succeeded".

  python3 tests/engine_write_test.py
"""
import ast
import errno
import os
import re
import select
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "server", "heartbeat.py")

failed = []


def check(label, ok, detail=""):
    print("  %s   %s%s" % ("ok  " if ok else "FAIL", label,
                           " — %s" % detail if detail else ""))
    if not ok:
        failed.append(label)


def load(name):
    """Pull one function out of heartbeat.py without importing the whole daemon."""
    src = open(SRC, encoding="utf-8").read()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            body = ast.get_source_segment(src, node).replace("@staticmethod\n", "")
            ns = {"os": os, "errno": errno, "select": select, "time": time,
                  "EngineError": RuntimeError, "clip": _clip}
            exec(body, ns)
            return ns[name]
    raise SystemExit("%s not found in heartbeat.py" % name)


def _clip(text, limit=8000):
    if text is None:
        return ""
    if len(text) <= limit:
        return text
    keep = limit // 2
    return text[:keep] + ("\n... [%d chars elided] ...\n" % (len(text) - limit)) + text[-keep:]


def main():
    write_all = load("_write_all")
    readable_stderr = load("readable_stderr")

    d = tempfile.mkdtemp()
    fifo = os.path.join(d, "stdin.fifo")
    os.mkfifo(fifo)
    # The engine's launcher holds the FIFO read-write (`exec 3<>`), so there is
    # always a reader; reproduce that here or the open would fail outright.
    holder = os.open(fifo, os.O_RDWR)

    got = bytearray()
    stop = threading.Event()

    def drain():
        os.set_blocking(holder, False)
        while not stop.is_set():
            try:
                chunk = os.read(holder, 8192)
                if chunk:
                    got.extend(chunk)
                else:
                    time.sleep(0.001)
            except OSError:
                time.sleep(0.001)

    threading.Thread(target=drain, daemon=True).start()

    # Either side of the pipe buffer, then the sizes a pasted image actually
    # reaches. 4 MB is a full-screen retina PNG once base64 has had it.
    for size in (1000, 65535, 65536, 500_000, 4_000_000):
        got.clear()
        payload = (b"x" * size) + b"\n"
        fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
        try:
            write_all(fd, payload, time.time() + 60)
        finally:
            os.close(fd)
        deadline = time.time() + 10
        while len(got) < len(payload) and time.time() < deadline:
            time.sleep(0.005)
        check("%9d bytes arrive whole" % size,
              bytes(got) == payload,
              "got %d of %d" % (len(got), len(payload)))

    stop.set()

    # A write with nobody draining must give up rather than block a turn for
    # ever: the engine can die mid-message.
    d2 = tempfile.mkdtemp()
    fifo2 = os.path.join(d2, "stuck.fifo")
    os.mkfifo(fifo2)
    holder2 = os.open(fifo2, os.O_RDWR)   # reader that never reads
    fd = os.open(fifo2, os.O_WRONLY | os.O_NONBLOCK)
    t0 = time.time()
    try:
        write_all(fd, b"y" * 200_000 + b"\n", time.time() + 1)
        raised = False
    except Exception:
        raised = True
    finally:
        os.close(fd)
        os.close(holder2)
    check("a full pipe times out instead of hanging", raised and time.time() - t0 < 5,
          "took %.1fs" % (time.time() - t0))

    # The error a user is shown must survive the engine echoing its input back.
    blob = "A" * 80_000
    raw = ('Error parsing streaming input line: {"type":"user","data":"' + blob + "\n"
           "No conversation found with session ID: 0e3f5147\n")
    out = readable_stderr(raw)
    check("echoed payload is elided from the error",
          len(out) < 1000 and "Error parsing streaming input line" in out
          and "No conversation found" in out,
          "%d chars" % len(out))

    print()
    if failed:
        print("FAILED: %s" % ", ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
