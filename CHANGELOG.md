# Changelog

Notable changes per release. Versions follow [semantic versioning](https://semver.org);
until 1.0 the minor number carries breaking changes.

## 0.2.5

`/goal` is Caden's own now, and four things that were quietly not what they
claimed to be: a window, a handshake, a folder name and a model name.

- **`/goal` no longer reaches either CLI.** The two commands were never the
  same thing. Codex's is a standing objective its own server drives —
  `thread/goal/set`, and app-server starts a turn, then another, with
  milliseconds in between. Claude Code's is a stop condition living inside the
  CLI, and nothing structured about it reaches the wire at all: Caden read it
  back out of the CLI's own prose with four regexes and sent a silent `/goal`
  after every turn to find out whether it still held. Both wrote one
  `meta["goal"]`, so the field carried two vocabularies — "in force" was
  `active` on one side and `set` on the other — and the front end went as far
  as testing the status value to work out which engine it was talking to, with
  the session's own `engine` sitting on the same object. The states, the
  judgement and the turn that carries the work on are all Caden's now, so both
  engines behave the same and the next one will too. Four states — `active`,
  `paused`, `blocked`, `exhausted` — and no terminal "achieved": a goal that is
  met is deleted and the chip goes with it. Six commands, none of which reaches
  the CLI, none of which takes a turn, and all of which skip the queue, because
  a `/goal clear` that waits its turn is a brake queued behind the wheel it is
  trying to stop. After each turn Caden asks a judge of its own — the session's
  provider rather than the engine, shown the objective and a window of the
  transcript with tool output in it, since an assistant saying it finished is a
  claim and a judge given only claims is not auditing anything — and drives the
  next turn itself when the answer is that it is not finished.
  [docs/GOALS.md](https://github.com/Ljh0107-L/Caden/blob/main/docs/GOALS.md)
  is the design.
- **A Codex session compacts at the window it declared, not nine tenths of
  it.** A session that asked for 800k was being compacted at 748,800 — 51,200
  short, on every turn, with the gauge still drawing 800k. Codex's threshold
  comes off the catalog window, not off `model_auto_compact_token_limit`, which
  moves nothing at all: four runs against a mock endpoint, reading the resolved
  number back out of Codex's own log, and 69 rows on a live devbox agreeing at
  a ratio of 0.9000. The reserve that was supposed to leave the reply somewhere
  to go was therefore being spent on the compaction point instead — a fix for
  the right symptom that under-corrected, 631k to 748.8k and never 800k. The
  catalog window is ten ninths of the declared number now, which puts the
  compaction point exactly on it, and the reply's room is the tenth above.
- **A handshake that timed out is finished on the next turn, not skipped for
  good.** On a box at load 197 the `initialize` after a respawn took longer
  than sixty seconds, and every message sent afterwards came back
  `thread not found` within milliseconds — forever, with the session's 63MB
  rollout sitting on disk the whole time. `ensure_started` spawns, initializes
  and then resumes the thread, and its re-entry guard was `if self.alive`;
  `alive` is true from the moment the process exists, which is before either of
  the other two has happened. So the timeout left a live process that had never
  been asked to open the thread, and nothing ran the handshake again while it
  was up. The guard is the handshake now rather than the process, a live
  process with an unfinished one is sent the resume it never got instead of
  being replaced, and a resume that times out no longer reads as "the thread is
  gone" and starts the conversation over.
- **A sidebar section is one directory on one machine.** Sessions were bucketed
  by working directory alone and the section titled with its basename, which
  went wrong in both directions. Two servers laid out the same way — what
  happens when the same person sets both of them up — shared a section, and the
  `+` on its heading ("new session here") started the session on whichever of
  them happened to own the most recently touched row. Two *different* paths
  ending in the same name were two sections with the same title and one fold
  state between them, so folding one folded both. Keyed by server and path now:
  the heading carries the machine's name whenever more than one server is
  connected, and enough of the path when one machine has two directories of the
  same name. Archived stays machine-wide — it is where sessions go to stop
  being looked at, and splitting that by machine is two places to not look.
- **The model picker ticks the row the session is actually on.** A model id is
  unique to a provider, not to the console, so two gateways in front of the
  same upstream put one model in the list twice under one alias — and the tick
  was the model id, so both rows carried one. The composer's footer showed that
  alias alone, which is the same string either way, so nothing on screen said
  which gateway a session was talking to. A session records the provider entry
  it was created from now, the tick tests that, and the name is qualified by
  the provider — `GPT 5.6 Sol · Seed` — when the name alone does not identify
  it. A session set up before the id was recorded is matched by its endpoint,
  which separates any two gateways without waiting for the model to be picked
  again.

## 0.2.2

Two hosts that cannot supervise, and the two ways that went wrong.

- **A crontab that refuses no longer throws away a daemon that started.** With
  no systemd user bus on the host, `supervise.sh` falls back to a cron
  watchdog, and it has always given up gracefully when there was no `crontab`
  to install one with. A container image whose `/usr/bin/crontab` has lost its
  setgid bit is not that host: the binary is there, `command -v` finds it, and
  the write comes back `/var/spool/cron/: mkstemp: Permission denied`. Under
  `set -e` that ended the script, so bootstrap called it `supervision install
  failed` and never printed the line the Mac reads — and the daemon it had
  started a moment earlier, listening and healthy, was reported as "Daemon:
  not installed", with the forward closed and both engines unknown. Every
  retry reached the same wall, so the server could not be set up at all. A
  crontab that will not have us is now the same answer as no crontab: the
  supervisor comes back `none`, the card says the daemon will not restart by
  itself, and the rest of the provisioning stands.
- **A systemd rung that dies with the last login is declined rather than
  taken.** The tunnel ladder took the systemd rung wherever `systemctl --user`
  answered, wrote the unit, started it and reported a supervised tunnel. An
  account that cannot enable lingering — `loginctl enable-linger` answers
  `Access denied` — has a `systemd --user` that stops with the last login
  session and takes `caden-tunnel.service` with it. That failure has an
  unusually mean shape: an ssh session is what keeps the user manager alive,
  so the tunnel is up whenever anyone is looking at the machine and gone by
  the time they reach the console — every check from a terminal found the unit
  running while the phone went on getting a 502. Availability and durability
  are different questions and the rung asks both now, a bus *and* lingering.
  Where lingering is refused it has nothing the rungs below it do not, so it
  stands aside and lets them have the tunnel.

## 0.2.1

Two things a devbox found.

- **Whatever a machine has, the tunnel gets held open by it.** Caden wrote a
  systemd user unit, called `systemctl --user restart`, and took the failure
  as the end of the story. A container-shaped devbox has no user bus at all —
  `systemctl --user` answers "Failed to connect to bus: No medium found" — and
  some of those have no `crontab` either, so on those hosts the tunnel
  silently did not exist while provisioning reported success and the console
  showed a 502 with nothing anywhere saying why. It is a ladder now: systemd,
  then a cron `@reboot` line with a watchdog beside it, then the process
  started bare. A rung that cannot apply is skipped; one that applies and
  fails falls through to the next. `supervise.sh` has always done exactly this
  for the daemon, down to giving up gracefully when neither exists — the
  tunnel simply never learned it.
- **The last rung restarts itself.** It has to: on a machine with no systemd
  user session and no cron there is nothing else to run it again, and the
  first attempt is not always the one that works. A server whose egress drops
  half its outbound connections took the ladder correctly down to the bottom
  rung, failed to connect once, and that was the end of it — a tunnel that
  never existed on a machine where the mechanism had been chosen correctly.
  It loops now, and the ssh it runs gives up on a dead path in ten seconds
  rather than waiting out the default. When no rung takes at all, that is an
  error in the pane naming every one that was tried, rather than a silence to
  be discovered later as a 502.
- **The Servers and Web panes stop asking one question at a time.** Every
  reachability check is an ssh round trip, and a server whose tunnel is down
  costs a three-second curl on top; run in sequence across four servers, plus
  the password and certificate checks, that is a pane sitting on "Checking…"
  long enough to read as broken. None of them depend on each other. Web went
  from that to 1.7s, and a server's own status from 26s to 1.9s.
- **A server that cannot reach the gateway is told so before anything is
  installed.** The tunnel is dialled from the server, so a machine with no
  outbound network of its own — a devbox reachable inbound through a corporate
  proxy and nothing more — can never open one. It got a key, an authorisation
  on the gateway and a service anyway, waited out the whole probe window, and
  failed with "nothing answered", which is true about the wrong thing. It is
  three quick connection attempts up front now, and a refusal that names the
  address and the reason. Three rather than one because the two failures do
  not look alike: a machine with no route says so instantly and always, and a
  machine whose egress drops connections times out and then works — only the
  first is worth refusing.
- **Reasoning is on screen while it is arriving.** A fold starts closed —
  `open` is the set the reader has opened by hand — so a reasoning block
  streamed into a collapsed one, and the body a delta appends to is only built
  when the fold opens. So the deltas had nowhere to land: not hidden, not
  rendered, rebuilt from scratch on the first click. What a long think looked
  like was a chevron and a header that never changed, which is exactly what a
  turn that has stopped looks like — and on a model that reasons for a minute
  before its first visible word, that is the whole turn. The live block is open
  now and grows in place, and folds away when the header stops saying
  "Thinking…" and starts saying how long it took.
- **A turn with nothing back yet says it is waiting, not working.** "Working…"
  was drawn whenever a tool had run earlier in the turn — earlier, not now — so
  a turn stalled on the network claimed progress it was not making. Before
  anything at all has arrived the honest word is that we are waiting, and past
  three quarters of a minute of silence the row says so rather than leaving the
  reader to compare two timestamps.
- **A wait that is going somewhere says how long it has been.** The bottom rung
  retries, so the probe window has to be long enough to let it, and a minute of
  one unchanging line reads as a hang in exactly the case where it is not one.
- **The two installs stop sharing ports they were never meant to share.** The
  flavor split gives each install its own config, keychain, daemon home and
  daemon port, and says in as many words that the bases have to be far enough
  apart that neither walk reaches the other's. Two allocators had been left out
  of that. Tunnel ports on the web gateway started at a hardcoded 7901 for
  both, so on a gateway they share — the ordinary arrangement, since the
  gateway is somebody's server — development's second server and production's
  third both came out as 7903; whichever tunnel bound it first owned it, and
  the other console reached a daemon holding a different token. That reads as
  "bad or missing token" on a server that is running perfectly, and it was
  happening on both consoles at once. Local forward ports had the same shape
  and had not bitten yet: the walk starts at the daemon port and had no upper
  bound, so a hundredth server on the production side would have taken 7938 —
  the port the development daemon listens on — and stopped development working
  because of how many servers production happened to have. Each install now
  has a closed block for both, and a port recorded before the split is dropped
  so the next connect allocates inside it. Which install is "just development"
  does not make the interference acceptable in either direction.
- **The Web pane draws itself before the answers arrive.** Almost everything on
  it is already on this machine — the address, which machine runs the proxy,
  which daemon serves the console, the list of servers — and only the ticks
  beside them need asking. Waiting on the asking left the whole pane blank for
  as long as the slowest check took. It fills in from the config first, in
  about seven milliseconds, and the rows that need an answer say so until they
  have one. A server with a tunnel reads as "checking…" rather than as "not on
  the web", which would have offered an Add button for a server already on it.
- **A dropped connection no longer takes the app down.** Provisioning writes
  its payload to ssh's stdin, and `child.on('error')` is the process's error,
  not the pipe's — so when the far end went away mid-write, `stdin` emitted
  EPIPE with nobody listening, which is an uncaught exception, which in
  Electron is a dialog over the whole app and a main process that stops. Two
  servers sat on "uploading daemon files…" for good, because the thing that
  was going to tell them otherwise had died. This was survivable while the
  payload was three small text files and the write finished before anything
  could close it; 0.2.0 started pushing the whole console through the same
  pipe, a third of a megabyte, and made a mid-write close ordinary rather than
  rare. It is a failed run now, and the step that failed says EPIPE.
- **Setting a server up is not publishing it.** Provisioning ended by wiring
  the new server into the web gateway, so adding a machine reached out to a
  third host, and a gateway that was down turned into a warning on an
  operation that had otherwise gone perfectly. Adding a server and putting it
  on the web are different things to want, and they are two decisions now: the
  Servers pane gets a machine talking to this Mac, and the Web pane is where
  you pick which of them the phone can reach. `scripts/provision.sh` stops at
  the same place, so both ways round still agree on what "provisioned" means.

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
- **A forward proves which daemon is on the other end of it.** Every daemon
  answers `/v1/ping`, and answers it identically — so a daemon of this Mac's
  own, holding the port a server's forward was configured for, was
  indistinguishable from that forward working. `startTunnel` reported it
  reused, never opened anything, and the app addressed the wrong machine for
  the rest of the session while reporting the right one as connected. It
  surfaced as a server that would not take a daemon upgrade: the revision it
  reported belonged to somebody else. The token is what tells two daemons
  apart, so that is what gets checked. And when the configured local port is
  held by something that is not ours, the forward takes the next free one
  rather than failing — or, as before, quietly using whatever answered.
- **Renaming the gateway takes the old address down.** Changing the hostname
  and applying left the previous site enabled, still answering, still renewing
  a certificate for a name nobody uses. The old site and its web root go once
  the new one is up and nginx has accepted it. The certificate is left alone —
  deleting one is not a thing to do without being asked — and the step says
  the command that removes it.
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
- **Removing a server removes its way in.** Dropping the entry left the proxy
  still routing to it, the console still listing it and — the part that
  matters — a key of its own still authorised to open a tunnel into the
  gateway. "I removed that server" has to mean the server can no longer get
  in. The key is withdrawn from the gateway first, because that is the end
  which grants access and it works whether or not the machine still answers.
  Its daemon is left running: it is your machine, and there may be work on it.
- **A server set up while a gateway exists is on the phone when it finishes.**
  The proxy needs a route to each daemon, and only the one running on the
  gateway itself is already reachable. Provisioning now gives the others a key
  of their own, authorises it on the gateway for forwarding and nothing else
  (`restrict,port-forwarding` — no shell, no agent, no pty), installs a service
  that holds the tunnel open, and brings the proxy's configuration in line. The
  server dials the gateway, never the reverse, so it needs no public address
  and the gateway holds no key for it. The Web pane lists what the proxy can
  reach and why, with a button for servers that predate the gateway and for
  repairing one that has stopped. Failing to wire the proxy does not fail the
  provision — the daemon is up either way, and it says what did not happen.
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

And two that were not about any of this:

- **The composer can ask for Codex's fast tier.** Codex has a `priority`
  service tier — its own name for it is Fast, at 1.5x speed for increased
  usage — and it is a field on `turn/start`, beside `effort`. That is what
  makes it worth offering: a per-turn parameter travels as part of the
  request, so a relay can pass it on, and switching it costs neither the
  process nor the prompt cache. Which models have it comes from the catalog
  the CLI ships rather than a list here, which would be wrong by the next
  release; a model that catalog has never heard of is asked for anyway,
  because behind a gateway that is every model and the entry Caden clones for
  it carries the tier. Claude Code's fast mode is deliberately not offered.
  It is not a parameter at all — it asks for Opus to be routed to faster
  hardware — so through a relay the CLI reports it on while nothing upstream
  is any quicker, which is a switch that lies.
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
