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
- **A phone held sideways is still a phone.** The rules that wrap rather than
  truncate were keyed on `max-width: 760px`, so a landscape handset — 844px
  across, and with no more hover than it had a moment ago — got the desktop's
  ellipses. The width was never the reason; the missing hover was. They are
  keyed on both now, so a narrow desktop window wraps too, and an iPad stops
  hiding the ends of its own sentences.
- **Nothing hangs off the side of the box it is drawn in.** The composer's
  outer row wraps; the group inside it holding model, permission and effort
  did not, so on a 390px screen the last chip went over the edge of the card.
  That is a third kind of overflow, distinct from the page scrolling sideways
  and from text being clipped — nothing was clipping, the chip was simply
  outside. The narrow walk checks for all three now.
- **The one accent colour works in the light theme.** `.srv-btn.accent` — the
  button that says an engine has an update — was a hex pair chosen against the
  dark canvas: pale blue text on translucent blue. In the light theme that is
  pale blue on pale blue, and the button read as disabled. Everything else in
  the stylesheet derives from `--base` and flips with the scheme; this does
  now too.
- **Nothing on a phone ends in an ellipsis.** Truncation is a desktop bargain:
  a line that does not fit costs less than the rows around it going ragged,
  and the rest is a hover away. Neither half holds on a phone — there is no
  hover, and vertical space is the one thing there is plenty of. The pane
  intro, the server URL and the engine detail wrap now, and the detail takes
  the next line whole rather than sharing 150px with a label and a button.
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

- **The Servers pane fills itself in from the daemon when there is no host to
  ask.** `/host/servers/<id>/status` is the Mac answering questions only it
  can — is the forward up, does the keychain hold a token. Behind a proxy that
  route does not exist, and an nginx with a single-page fallback answers it
  with `index.html`, so the pane read "Daemon: not installed" over a JSON
  parse error on a daemon that was running perfectly. It asks the daemon
  directly now: it knows its own version and its engines, and having answered
  at all is the liveness the host was relaying second-hand.
- **The generated proxy config rate-limits and the docs say how to ban.** The
  password on the proxy is the only door in front of a service that runs
  commands and holds model keys. bcrypt at `htpasswd`'s default cost verifies
  in ~10ms and nginx does it as fast as it is asked, so a guessable one falls
  in days — and raising the cost is the wrong lever, since a browser sends
  basic auth on every stylesheet and font. Capping the rate costs the person
  who knows the password nothing and caps everyone else at two a second;
  fail2ban ends the attempt outright.
- **`scripts/web-gateway.cjs` writes the proxy configuration.** Point it at a
  hostname and it prints the nginx block, an `ssh -R` unit for each server and
  the `host/config` the console reads, with every daemon's token already in
  place. The tokens are why it exists: 44 characters of base64 per server, and
  one character wrong is a 401 from a daemon that is running perfectly.
  [docs/WEB.md](docs/WEB.md) has the arrangement — the tunnels point outward,
  so no server needs a public address and the gateway needs no key for any of
  them.
- **Attachments work without a native file panel.** The `+` button raised the
  macOS open panel and sent the path it returned; a browser has no path to
  give, and behind a reverse proxy there is no `/host/*` to send it to. Where
  there is no panel the button now opens the browser's own picker and uploads
  the bytes straight to the daemon — which is the endpoint the Mac route ends
  up calling anyway, so what lands in the message is the same server path. The
  rule about what counts as an image the model can read is copied from the Mac
  side rather than re-decided: a photo picked on a phone and one dropped on
  the desktop have to become the same thing.
- **The daemon can resolve a provider key itself.** The renderer has never
  held a model API key — it sends the provider's id and the Mac's host server
  swaps in the value from the login keychain. A reverse proxy cannot do that;
  it can add a header, not rewrite a JSON body. So provisioning now syncs the
  Mac's keys to `~/.caden/providers.json` (0600, created that way rather than
  narrowed afterwards) and the daemon does the swap when nothing in front of
  it did. The wire protocol is unchanged. A run that reads no keys at all —
  a locked keychain — leaves the ones already on the server alone instead of
  replacing them with nothing.
- **Two installs can share a gateway without sharing anything on it.** The
  development build and the real one already keep separate config, keychain
  items, ports and daemon homes; the gateway had one place they collided,
  `/srv/caden-web/host/config`, where each wrote the server list the console
  reads and whichever applied last decided what the other's console saw. One
  directory per hostname now. What they do share — the rate limit and the ban
  rule — is shared on purpose: the jail watches the whole access log, so it
  covers both.
- **The gateway checks the address before spending a certificate on it.** A
  wrong A record is the likeliest thing to get wrong here, and it surfaces as
  a certbot failure — which costs one of Let's Encrypt's five certificates a
  week for that name. The address is resolved from the gateway and compared
  with the address the gateway answers on, before anything is written, and the
  message names the IP to point at.
- **The Web pane sets the gateway up.** Under Models in the desktop app: it
  asks for the three facts only a person knows — the hostname, which machine
  runs the proxy, which server's daemon serves the console — and does the rest
  over ssh with its steps streaming, the way provisioning does. The
  certificate, the nginx block with each daemon's 44-character token in it,
  the rate limit, the ban rule. Apply is also how you change any of it later:
  the configuration is rewritten each time, tested, and rolled back if nginx
  refuses it. The password goes straight through to the daemon and is not kept
  anywhere on this Mac. The pane is not offered to a console reached through
  the gateway, which would be offering to reconfigure the thing you arrived
  through.
- **The composer does not default to a mode the server will refuse.** On a
  daemon running as root the configured default is Full access, which Claude
  Code will not run there — so every new session began with a refusal. A
  refusal is the right answer to an explicit choice and the wrong one to a
  default nobody made, so the default steps down to Workspace write. Choosing
  Full access by hand still gets the explanation. Read from the daemon's own
  health, which arrives when the server connects: the readiness report is only
  gathered while the Servers pane is open, and the composer needs an answer
  before that.
- **A root daemon says so before the turn, not during it.** `bypassPermissions`
  is `--dangerously-skip-permissions` underneath, and Claude Code refuses it
  under a uid of 0 — so on a daemon provisioned as root the default permission
  mode produced "engine exited unexpectedly" and a line about a flag Caden
  never showed anyone. It is refused at session creation now, with a message
  naming the cause and both ways out. Caden does not work around the check:
  an agent that runs arbitrary commands should not be running them as root,
  least of all on a machine a browser can reach. `docs/WEB.md` sets the daemon
  up as an ordinary user.
- **The console has a sign-in of its own.** A bearer token is the right
  credential for a program and the wrong one for a person — a browser cannot
  put a header on the navigation that loads a page — so reaching one through a
  proxy meant HTTP basic auth, whose dialog belongs to the browser rather than
  to Caden, appears before anything has rendered, and gets re-prompted by
  Safari on its own schedule, ending any event stream open at the time. There
  is a password, a session cookie and a page now. nginx checks it through
  `auth_request`, which is where it has to live: a gateway fronts several
  daemons, and `/proxy/<other>/…` never reaches the one that owns the session.
  Sessions are stored hashed, last thirty days, survive a daemon restart, and
  are all revoked by changing the password or by `POST /v1/web/logout-all`.
- **The console hides what its host cannot do.** `/host/config` now says what
  the thing serving the page is able to do on the renderer's behalf — add a
  server, provision one over ssh, open a forward, pick a file with a native
  dialog. The Mac app declares all of it. A console served by a daemon behind
  a reverse proxy declares none, and the pane drops the buttons and the copy
  describing them rather than offering something that would 404. Absent means
  none, so a hand-written config for that arrangement does not have to know
  the list in order to be safe. What the pane still does is report — hiding
  the actions must not hide the diagnosis.
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
