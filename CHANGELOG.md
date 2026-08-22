# Changelog

Notable changes per release. Versions follow [semantic versioning](https://semver.org);
until 1.0 the minor number carries breaking changes.

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
