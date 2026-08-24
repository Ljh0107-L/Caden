# Changelog

Notable changes per release. Versions follow [semantic versioning](https://semver.org);
until 1.0 the minor number carries breaking changes.

## 0.2.0

Caden on a phone.

Three of these were only true on a desktop.

- **The console works on a phone.** The stylesheet had exactly one media query
  in it, for dark mode, and at 375px the main column's 424px floor pushed the
  composer off the side of the screen. Below 760px the sidebar is now an
  overlay over the canvas instead of a column beside it — the same two states
  the desktop toggle already had, laid over each other rather than side by
  side — and picking a session puts it away again. Nothing new to install:
  the renderer was always a plain web page.
- **Hover-only controls are reachable with a finger.** Archive and pin on a
  session row were `opacity: 0` *and* `pointer-events: none` until the pointer
  hovered, so on a phone they could not be reached at all — the only way in
  was a long press nothing advertises. On a pointer that cannot hover they are
  shown outright, along with the chevron that says a tool call opens.
- **A session's files belong to whoever started the daemon.** `sessions/` was
  0755 and every `meta.json` under it 0644, with the provider's API key in
  clear — meta is written verbatim, and the key has to persist for a session
  to resume after a restart. The tree is 0700 and the meta files 0600 now, and
  a home provisioned by 0.1.0 is narrowed on the way up rather than left as it
  was found.

Groundwork for reaching a daemon through a browser rather than an ssh
forward:

- **Provisioning sends the console with the daemon.** The payload was three
  text files in a heredoc, chosen so a minimal container with no `tar` and no
  `base64` could still be provisioned. The renderer is 258K of text, which
  goes the same way — but a woff2 does not survive a heredoc, so the two fonts
  are base64 and guarded by `command -v base64`. A host without it gets a
  working console in the fallback mono rather than a provisioning run that
  fails over a typeface. The tree is swapped in whole, so a run that dies
  partway leaves the console that was already working.
- **The daemon serves the console itself.** Dropped into `~/.caden/web` by
  provisioning, behind the same token as everything else, with ETags so that
  340K of renderer and fonts is not re-fetched on every open over a phone
  connection. A daemon without that directory is unchanged — `/` is still the
  ping alias it always was. The file path is built from a URL in a process
  that also runs commands, so the half that matters is the refusals: `..`, the
  percent-encoded version of `..`, and a symlink inside the tree pointing out
  of it are all 403.
- **The daemon says less to a stranger, and answers a wrong token more
  slowly.** An unauthenticated `/v1/ping` named the software, the version and
  the exact source revision — the first line of a scanner's report, on a port
  that is one proxy misconfiguration away from the internet. It reports
  liveness now and nothing else; `/v1/health` carries the same fields for a
  caller holding the token, which is where the app reads them. The comparison
  is constant-time, and a failed one costs 250ms.

And one that was not about any of this:

- **Tearing down one daemon home's supervision no longer takes another's with
  it.** The watchdog's crontab lines are tagged, and every home outside the
  `~/.caden-<flavor>` convention carries the *same* tag as `~/.caden` — so
  uninstalling supervision for a second home grepped production's two lines
  out along with its own, and then removed the whole crontab because nothing
  was left. A line is matched on the home it names now, not on the tag alone.
  Found because `tests/supervise_test.py` could reach the real `crontab` from
  its systemd walk, which no walk can do any more.

## 0.1.0

First release.

### The shape of it

- **The agent lives on the server.** Caden provisions a small stdlib-only
  Python daemon (`heartbeat`) under `~/.caden` over ssh, and reaches it through
  a port-forward. The daemon owns the CLI processes, the workspaces and the
  transcripts; the desktop app is a console over them and can be closed
  mid-turn without stopping the work.
- **Engines outlive the daemon.** Restarting `heartbeat` — or replacing it —
  leaves the running CLIs alone: they are detached, hold their own stdio, and
  are re-adopted on the way back. A turn in flight survives an upgrade.
- **The protocol picks the engine.** A model declares the wire protocol it
  speaks and Caden starts the matching CLI: Anthropic Messages runs Claude
  Code, OpenAI Responses and Chat Completions run Codex. Each session gets its
  own engine home, workspace and credentials.
- **Events, not polling.** The daemon serves a sequence-numbered SSE stream
  the client folds into a transcript. A reconnect replays from a cursor, so a
  closed laptop or a dropped tunnel costs nothing but the gap.

### In the window

- Transcript with streamed reasoning and message deltas, tool calls as
  collapsible rows with their output, todo lists, file diffs, and a hairline
  per turn carrying its elapsed time.
- A context gauge drawn against the window the session declared, with a tray
  breaking the occupancy into cached prompt, cache write, input and output.
- `/goal` and `/compact` on both engines, with the differences between them
  handled rather than papered over: Codex's goal is a standing objective the
  server works toward, Claude's is a condition it checks before it stops.
- Per-session model, permission mode and thinking effort, changeable without
  restarting the engine where the CLI allows it.
- Background work, queued messages, interrupts, and the phases that used to
  read as a hang — compaction especially — named on screen.

### On the server

- Provisioning finds a usable `python3`, starts the daemon, and returns a
  token; re-running it is idempotent and reuses both the daemon and the port.
- Supervision through a systemd user service where there is one, and a cron
  watchdog where there is not.
- Engine installs from the npm CDN, from GitHub releases, or offline from an
  uploaded artifact — none of which need Node on the server.

### Known limits

- macOS only, Apple silicon, and **ad-hoc signed rather than notarized**: the
  first launch needs the Privacy & Security "Open Anyway" dance. The README
  walks through it.
- Engine installs have no UI yet; the daemon's HTTP surface is the way in.
- Claude Code keeps a reply buffer of its own — about 33k — that no setting
  hands it separately, so a session that declares 800k is compacted a few
  percent under that. Codex is handed the reserve explicitly and compacts at
  the declared figure.
