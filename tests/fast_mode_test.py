#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""The fast tier rides on the turn, and says so when the model has none.

Codex calls the `priority` service tier "Fast" -- 1.5x speed, increased usage
-- and it is a field of `TurnStartParams`, beside `effort` and
`sandboxPolicy`. That is the whole reason Caden offers this one and not Claude
Code's fast mode: a per-turn parameter travels through a gateway as part of
the request, and switching it costs neither the process nor its prompt cache.

Which models have the tier is Codex's catalog to say. Caden reads it rather
than keeping a list, because the list moves with every CLI release. The one
case Caden decides is a model the catalog has never heard of -- the ordinary
case behind a gateway -- and it decides to ask: `write_model_catalog` clones
the catalog's first entry for such a model, and that entry carries the tier.

    python3 tests/fast_mode_test.py
"""

import importlib.util
import json
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


# A catalog shaped like the one `codex debug models` prints: the first entry
# carries the tier, one further down does not.
CATALOG = json.dumps({"models": [
    {"slug": "gpt-5.6-sol", "context_window": 400000,
     "service_tiers": [{"id": "priority", "name": "Fast",
                        "description": "1.5x speed, increased usage"}]},
    {"slug": "gpt-5.4-mini", "context_window": 400000, "service_tiers": []},
]})


def engine_for(hb, session, catalog=CATALOG):
    """A CodexEngine with the catalog subprocess replaced and no process.

    Nothing here starts `codex`: the question is which fields land on
    `turn/start`, and a real app-server would answer it slower and no more
    precisely.
    """

    class Stub(hb.CodexEngine):
        def __init__(self, sess):
            hb.CodexEngine.__init__(self, sess)
            self.requests = []
            self.catalog_reads = 0

        def _catalog_json(self):
            self.catalog_reads += 1
            return catalog

        def _request(self, method, params=None, **kw):
            self.requests.append((method, params or {}))
            return {}

        # The turn is the subject; getting a process up to receive it is not.
        def ensure_started(self):
            self.session.meta.setdefault("native_id", "th_test")

        def _await_goal_probe(self, timeout=1.0):
            pass

        def emit(self, *a, **kw):
            pass

    return Stub(session)


def turn_params(eng):
    return [p for m, p in eng.requests if m == "turn/start"]


def main():
    home = tempfile.mkdtemp(prefix="caden-fast-")
    hb = load_daemon(home)
    mgr = hb.SessionManager()

    def new_session(**over):
        spec = {"engine": "codex", "model": "gpt-5.6-sol", "cwd": home,
                "effort": "high", "permission_mode": "acceptEdits",
                "provider": {"protocol": "openai-responses",
                             "api_key": "sk-test"}}
        spec.update(over)
        return mgr.create(spec)

    # -- the wish survives being written down ------------------------------
    s = new_session(fast=True)
    check("a session created with fast on keeps it", s.meta.get("fast") is True)
    check("and reports it to the client", s.to_dict().get("fast") is True)
    check("a session created without it does not invent one",
          new_session().to_dict().get("fast") is False)

    # -- it lands on the turn, beside effort -------------------------------
    eng = engine_for(hb, s)
    eng.submit("t1", "hello")
    p = turn_params(eng)[0]
    check("the turn carries the fast tier", p.get("serviceTier") == "priority",
          repr(p.get("serviceTier")))
    check("alongside the settings that were already there",
          p.get("effort") == "high" and "sandboxPolicy" in p)
    check("and the session reports the tier it got",
          s.to_dict().get("fast_state") == "on"
          and s.to_dict().get("fast_reason") is None)

    # -- nobody asked, nothing is sent -------------------------------------
    plain = new_session()
    pe = engine_for(hb, plain)
    pe.submit("t1", "hello")
    check("a session without it sends no tier",
          "serviceTier" not in turn_params(pe)[0])
    check("and is not reported as refused",
          plain.to_dict().get("fast_reason") is None,
          "nobody asked, so there is nothing to explain")

    # -- a model the catalog says has no tier ------------------------------
    mini = new_session(model="gpt-5.4-mini", fast=True)
    me = engine_for(hb, mini)
    me.submit("t1", "hello")
    check("a model without the tier does not get one",
          "serviceTier" not in turn_params(me)[0])
    check("and the session says why",
          me.session.to_dict().get("fast_state") == "off"
          and me.session.to_dict().get("fast_reason") == "model_not_supported")

    # -- a model the catalog has never heard of ----------------------------
    # The ordinary case behind a gateway. `write_model_catalog` clones the
    # catalog's first entry for it, and that entry carries the tier, so
    # refusing here would refuse every model that is not on OpenAI's own list.
    relay = new_session(model="my-gateway-model", fast=True)
    re_ = engine_for(hb, relay)
    re_.submit("t1", "hello")
    check("an unknown model is asked for anyway",
          turn_params(re_)[0].get("serviceTier") == "priority")

    # -- no catalog at all -------------------------------------------------
    blind = new_session(fast=True)
    be = engine_for(hb, blind, catalog=None)
    be.submit("t1", "hello")
    check("an install that cannot list its models is still asked",
          turn_params(be)[0].get("serviceTier") == "priority",
          "too old to list is also too old to be trusted to have dropped it")

    # -- toggling costs nothing --------------------------------------------
    # The reason this one is offered and Claude Code's is not. A per-turn
    # field has no process to replace: `stale()` reads the spawn signature,
    # and there is no fast flag in argv to appear in it.
    check("the tier is not part of the spawn signature",
          "serviceTier" not in eng.spawn_signature(["codex", "app-server"]))
    s.meta["fast"] = False
    s.save()
    eng.submit("t2", "again")
    check("turning it off just stops sending it",
          "serviceTier" not in turn_params(eng)[1])
    check("and says so", s.to_dict().get("fast_state") == "off")
    s.meta["fast"] = True
    s.save()
    eng.submit("t3", "and back")
    check("turning it back on sends it again",
          turn_params(eng)[2].get("serviceTier") == "priority")

    # -- the catalog is read once ------------------------------------------
    # It is a subprocess with a 30s timeout, and both the window patch and the
    # tier want it. The real `_catalog_json` is the thing under test here, so
    # this one stubs the layer below it instead.
    counted = new_session(fast=True)
    real = hb.CodexEngine(counted)
    calls = []
    hb.run_capture = lambda argv, **kw: (calls.append(argv), (0, CATALOG, ""))[1]
    hb.TOOLCHAIN.binary_for = lambda name: "/nowhere/codex"
    for _ in range(3):
        real._catalog_json()
    check("the catalog subprocess runs once per engine", len(calls) == 1,
          "%d runs" % len(calls))
    # And a failure is remembered as a failure, rather than retried every turn.
    again = hb.CodexEngine(counted)
    calls[:] = []
    hb.run_capture = lambda argv, **kw: (calls.append(argv), (1, "", "boom"))[1]
    for _ in range(3):
        again._catalog_json()
    check("an install with no catalog is not asked three times",
          len(calls) == 1 and again._catalog_json() is None,
          "%d runs" % len(calls))

    print()
    if failed:
        print("FAILED: %s" % ", ".join(failed))
    else:
        print("all fast-tier checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
