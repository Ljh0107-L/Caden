#!/bin/bash
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

# The release notes for one version, read out of CHANGELOG.md.
#
#   scripts/release-notes.sh 0.1.0    ->  stdout
#
# The changelog is the source. A release that restates it in the workflow drifts
# from it by the second release, so the workflow reads it instead.
#
# The Gatekeeper paragraph is appended rather than kept in the changelog: it is
# about the download, not about the version, and stays true of every build until
# one is notarized.
#
# The output is reflowed to one line per paragraph. GitHub renders a release
# body with hard breaks on -- a single newline is a <br>, the way it is in a
# comment -- so the changelog's 76-column wrapping would show up as a ragged
# break after every line. The file stays wrapped for reading in the repo.
set -euo pipefail
cd "$(dirname "$0")/.."

V="${1:?usage: scripts/release-notes.sh <version>}"

# awk rather than sed: the section runs from its own `## <version>` heading to
# the next `## `, and awk carries that state without a second pass. Leading and
# trailing blank lines are dropped, interior ones kept -- `pending` holds blanks
# back until a real line arrives, so a run of them at the end never prints.
BODY=$(awk -v v="## $V" '
  $0 == v            { inside = 1; next }
  inside && /^## /   { exit }
  inside {
    if ($0 ~ /^[[:space:]]*$/) { if (started) pending = pending "\n"; next }
    printf "%s%s\n", pending, $0
    pending = ""; started = 1
  }
' CHANGELOG.md)

if [ -z "$BODY" ]; then
  echo "release-notes: CHANGELOG.md has no '## $V' section" >&2
  exit 1
fi

# Rejoin what the changelog wrapped. A blank line, a heading and the start of a
# list item each begin something new; anything else is a continuation of the
# line above and is folded into it. Fenced code is passed through untouched --
# its line breaks are the point.
cat <<EOF | awk '
  function flush() { if (buf != "") { print buf; buf = "" } }
  /^[[:space:]]*```/                             { flush(); fence = !fence; print; next }
  fence                                          { print; next }
  /^[[:space:]]*$/                               { flush(); print ""; next }
  /^#+ /                                          { flush(); print; next }
  /^[[:space:]]*([-*+]|[0-9]+\.)[[:space:]]/     { flush(); buf = $0; next }
  { line = $0; sub(/^[[:space:]]+/, "", line); buf = (buf == "" ? line : buf " " line) }
  END { flush() }
'
$BODY

---

**First launch is blocked by Gatekeeper.** The app is ad-hoc signed, not
notarized: open it once, dismiss the warning, then System Settings → Privacy &
Security → *Open Anyway*. The
[README](https://github.com/Ljh0107-L/Caden#installing-a-build) walks through it.
EOF
