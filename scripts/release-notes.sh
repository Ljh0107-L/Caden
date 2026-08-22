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

cat <<EOF
$BODY

---

**First launch is blocked by Gatekeeper.** The app is ad-hoc signed, not
notarized: open it once, dismiss the warning, then System Settings → Privacy &
Security → *Open Anyway*. The
[README](https://github.com/Ljh0107-L/Caden#installing-a-build) walks through it.
EOF
