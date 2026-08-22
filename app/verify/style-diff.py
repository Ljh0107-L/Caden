#!/usr/bin/env python3
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

"""Diff two component-probe dumps and report rendering deltas.

Used for the de-vendoring parity loop: A is the pre-rewrite capture (Cursor's
stylesheet driving the page), B is the post-rewrite capture (Caden's own CSS).
Class lists are expected to differ wholesale -- the whole point of the rewrite
is that the hashed atomic names are gone -- so `cls` is ignored by default and
only the *rendered result* is compared.

  style-diff.py A.json B.json [--show-class] [--tol N]

Both files may be either a flat node list (whole-tree probe) or a
{component: [nodes]} map (component probe).
"""
import json
import sys

GEOM = {"x", "y", "w", "h"}
SKIP = {"path", "depth", "text", "data"}
# Nothing is noise. `cursor` used to be excluded here, which is exactly how a
# whole-app regression -- every clickable surface silently reverting from the
# hand to the arrow -- got past a run that otherwise reported full parity.
NOISE = set()


def load(p):
    d = json.load(open(p))
    if isinstance(d, list):
        d = {"_root": d}
    return {c: {n["path"]: n for n in nodes} for c, nodes in d.items()}


def main(argv):
    a_path, b_path = argv[0], argv[1]
    skip = set(SKIP) | set(NOISE)
    if "--show-class" not in argv:
        skip.add("cls")
    tol = 1.0
    if "--tol" in argv:
        tol = float(argv[argv.index("--tol") + 1])

    A, B = load(a_path), load(b_path)
    total = real = geom = 0
    for comp in sorted(set(A) | set(B)):
        if comp not in A or comp not in B:
            print(f"### component only in {'A' if comp in A else 'B'}: {comp}")
            continue
        a_nodes, b_nodes = A[comp], B[comp]
        lines = []
        for p in sorted(set(a_nodes) - set(b_nodes))[:10]:
            lines.append(f"  - missing in B: {p} <{a_nodes[p]['tag']}> "
                         f"{a_nodes[p].get('text','')!r}")
        for p in sorted(set(b_nodes) - set(a_nodes))[:10]:
            lines.append(f"  + extra in B:   {p} <{b_nodes[p]['tag']}> "
                         f"{b_nodes[p].get('text','')!r}")
        for p in sorted(set(a_nodes) & set(b_nodes)):
            a, b = a_nodes[p], b_nodes[p]
            diffs = []
            for k in sorted((set(a) | set(b)) - skip):
                va, vb = a.get(k), b.get(k)
                if va == vb:
                    continue
                total += 1
                if k in GEOM:
                    try:
                        if abs(float(va) - float(vb)) <= tol:
                            total -= 1
                            continue
                    except (TypeError, ValueError):
                        pass
                    geom += 1
                    diffs.append(f"[geom] {k}: {va} vs {vb}")
                else:
                    real += 1
                    diffs.append(f"{k}: {str(va)[:52]!r} vs {str(vb)[:52]!r}")
            if diffs:
                lines.append(f"  {p} <{a['tag']}> {a.get('text','')[:24]!r}")
                lines.extend("      " + d for d in diffs)
        if lines:
            print(f"### {comp}  ({len(a_nodes)} nodes)")
            print("\n".join(lines))
    print(f"\n=== {real} style deltas, {geom} geometry deltas "
          f"({total} total non-noise) ===")


if __name__ == "__main__":
    main(sys.argv[1:])
