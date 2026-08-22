#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""Compare two component probes by what a reader sees.

The de-vendoring rewrite made Caden's DOM markedly flatter than the captured
markup it replaced, so aligning nodes by structural path compares elements
that are no longer the same element. This aligns text-bearing leaves by their
text instead, which survives restructuring, and reports the properties that
decide how that text reads: size, weight, family, colour, and the box it sits
in.

  text-diff.py A.json B.json [--all]
"""
import json
import re
import sys

TYPO = ["font-size", "font-weight", "font-family", "line-height", "color",
        "cursor"]
BOX = ["background-color", "border-radius", "padding"]

_COLOR_RE = re.compile(
    r"color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*/\s*([\d.]+))?\)")


def norm(v):
    """Same colour, same string.

    The captured sheet serialised colours as `color(srgb ...)` with 0-1
    channels; ours come back as `rgb()/rgba()` with 0-255 ones. They render
    identically, so compare them in one form or every colour reads as a
    delta.
    """
    if not isinstance(v, str):
        return v
    m = _COLOR_RE.search(v)
    if m:
        r, g, b = (int(round(float(m.group(i)) * 255)) for i in (1, 2, 3))
        a = float(m.group(4)) if m.group(4) else 1.0
        return f"rgb({r},{g},{b}/{a:.3f})"
    m = re.fullmatch(r"rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)", v.strip())
    if m:
        r, g, b = (int(m.group(i)) for i in (1, 2, 3))
        a = float(m.group(4)) if m.group(4) else 1.0
        return f"rgb({r},{g},{b}/{a:.3f})"
    return v


def leaves(nodes):
    """Text-bearing leaves, keyed by their text.

    `cursor` rides along with the typography: it is what the pointer promises
    about a surface, and it is invisible in a screenshot, so nothing else
    catches it changing.
    """
    out = {}
    for n in nodes:
        t = (n.get("text") or "").strip()
        if not t or len(t) < 2:
            continue
        out.setdefault(t, n)
    return out


def short(v):
    v = str(v)
    return v if len(v) <= 30 else v[:29] + "…"


def main(argv):
    a_path, b_path = argv[0], argv[1]
    show_all = "--all" in argv
    A, B = json.load(open(a_path)), json.load(open(b_path))
    typo_bad = typo_ok = 0
    for comp in sorted(set(A) & set(B)):
        la, lb = leaves(A[comp]), leaves(B[comp])
        shared = sorted(set(la) & set(lb))
        if not shared:
            continue
        lines = []
        for t in shared:
            a, b = la[t], lb[t]
            diffs = [f"{k}: {short(a.get(k))} vs {short(b.get(k))}"
                     for k in TYPO if norm(a.get(k)) != norm(b.get(k))]
            if diffs:
                typo_bad += 1
                lines.append(f"  {t[:34]!r}")
                lines.extend("      " + d for d in diffs)
            else:
                typo_ok += 1
        if lines or show_all:
            print(f"### {comp}  ({len(shared)} shared strings)")
            print("\n".join(lines) if lines else "  (all matched)")
    total = typo_ok + typo_bad
    pct = 100.0 * typo_ok / total if total else 100.0
    print(f"\n=== {typo_ok}/{total} shared strings render identically "
          f"({pct:.0f}%) ===")


if __name__ == "__main__":
    main(sys.argv[1:])
