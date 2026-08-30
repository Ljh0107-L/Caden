# Architecture

## Why a daemon and not SSH commands

Driving a coding agent over `ssh host claude ...` breaks in three ways: the turn
dies with the connection, output is a terminal stream rather than structured
events, and there is no way to have two sessions that do not stomp each other's
state. Caden pushes a daemon onto the server instead, and everything follows from
that.

```
   Desktop                                      Server
┌──────────────┐                            ┌─────────────────────────────┐
│  Electron    │                            │  heartbeat (python3, stdlib)│
│   main.js    │   ssh -N -L 127.0.0.1:P    │                             │
│   server.js ─┼────────────────────────────┼─► HTTP :7838 (127.0.0.1)    │
│    (proxy)   │        (port-forward)      │     ├ SessionManager        │
│      ▲       │                            │     │   └ Session ──┐       │
│      │ HTTP  │                            │     ├ Installer     │       │
│  web/ (UI)   │◄───────────────────────────┼──── └ EventBus      ▼       │
│  transcript  │   sequence-numbered events │                 claude/codex│
└──────────────┘                            └─────────────────────────────┘
```

The renderer never holds the daemon token and never talks to the daemon
directly: `app/server.js` serves the UI on a loopback port and proxies
`/proxy/<serverId>/v1/...` upstream with the `Authorization` header injected.
Responses are piped, so SSE passes through unbuffered.

Provisioning (`scripts/provision.sh`) is three SSH round-trips: `mkdir`, copy
`heartbeat.py` and `bootstrap.sh`, run bootstrap. `bootstrap.sh` finds a usable
Python, starts the daemon, and prints one JSON line with the port and token. It
is idempotent — re-running it reuses a live daemon and its existing token.

The port comes from a pool kept in `$CADEN_HOME/heartbeat.ports`: the requested port
first, then whatever this home has bound before, and a new port only when every
one of them is taken at once. The alternative — walk forward from the requested
port until something is free — meant a restart landed one port higher every
time, because the socket the daemon had just released still read as busy. The
client writes down the port it is told, so each drift left it addressing a
daemon that had moved.

## Supervision

A daemon that only survives an ssh session closing is half the promise: the
box also reboots (kernel updates, cloud maintenance) and the daemon itself can
crash or be OOM-killed. `supervise.sh`, run by bootstrap with `--supervise`
(which provisioning always passes), installs whatever the host can support:

- **systemd user service** — `~/.config/systemd/user/heartbeat.service`,
  `Type=simple`, `Restart=always`, with `loginctl enable-linger` so it starts
  at boot without a login session. heartbeat runs under it in `--foreground`, so
  journald gets its logs and `systemctl stop` is a clean SIGTERM shutdown.
- **cron watchdog** — the fallback for hosts without a working systemd user
  bus (containers, minimal images): `@reboot` plus a once-a-minute line that
  re-runs bootstrap, which is a no-op while the daemon is alive. The port is
  baked into the crontab line, so a crash brings the daemon back on the same
  port the app's forward addresses; re-provisioning rewrites the line when the
  port ever moves. If neither systemd nor crontab exists, provisioning remains
  successful and records the daemon as unsupervised.

The install is idempotent: the unit is compared with what is on disk and only
restarted when it changed, and the crontab lines carry a `heartbeat-supervise`
tag so re-installing replaces rather than stacks.

Supervision changes who owns the lifecycle, and bootstrap knows it: when the
unit file exists, `--stop`/`--restart` route through `systemctl` instead of
signalling the process directly — killing a systemd daemon ourselves just
makes `Restart=always` bring it back on a path that then loses the port fight
to the copy we started. The one mixed state — a unit installed while a
pre-supervision daemon still holds the port — is handed off explicitly:
the foreign daemon is stopped before systemd is asked to start.

## Sessions

A session is a directory under `~/.caden/sessions/<id>/`:

```
meta.json        model, provider, cwd, permission mode, running totals
events.jsonl     the append-only transcript
engine/          CLAUDE_CONFIG_DIR or CODEX_HOME for this session alone
workspace/       default cwd when the user did not pick one
logs/            engine stderr and the exact argv of every spawn
images/          attachments staged for the engine
```

Isolation is the point of `engine/`. Two sessions on one box get separate
histories, separate MCP config and separate credentials. Caden seeds that
directory with the host's engine *config* only — `settings.json` / `CLAUDE.md`,
`config.toml` / `AGENTS.md` — and never with a credential. Every session
authenticates with the provider key it was created with; a session without one
is refused at creation rather than falling back to whatever login happens to
sit on the box, which would make the account a session bills to depend on who
last ran `claude login` there. Any credential file found in the engine home is
removed on the way through. There is no "shared" mode: pointing a session at
the host's own engine home would hand that login straight back to it.

A seeded config can substitute the account just as effectively as a login,
through a different file. Claude's `settings.json` carries an `env` block the
CLI applies *over* the environment Caden sets, and Codex's `config.toml` carries
`model_provider` and `model` outright — either one lets whoever set the box up
decide where a session's requests go and who they go as. The two are closed
differently, because the files are: the `env` block is rewritten on the way
through (`SEEDED_ENV_DENY`), while Codex's keys are pinned on the command line
at spawn, where `-c` outranks the file. Everything else in both files — MCP
servers, permissions, hooks, instructions — is the reason they are seeded and
is left alone.

## The event bus

Every session owns an `EventBus`: an append-only log where each event carries a
monotonic `seq`, is persisted to `events.jsonl`, and is pushed to live
subscribers. Clients subscribe with `?after=<seq>`.

This is what makes disconnection a non-event. The client holds a cursor; on
reconnect it asks for everything after it. A cold window replays the whole log
and arrives at the same transcript a window that was open the whole time has.

`turn.end` is written to the log *before* the session leaves the running state,
so anything that observes an idle session is guaranteed to be able to read that
turn's result.

## Engine adapters

Both CLIs are translated into one event vocabulary, so the client renders a
single transcript model regardless of which produced it.

**Claude Code** speaks a bidirectional NDJSON protocol
(`--print --output-format stream-json --input-format stream-json`), so Caden keeps
one long-lived process per session and writes turns into its stdin. The session
id is pinned by Caden (`--session-id`) rather than discovered, so a crashed
process can be resumed with `--resume`.

Because that process is long-lived, everything it baked in at spawn — model,
permission mode, provider environment, working directory — can only be changed
by replacing it. That replacement happens **when the next turn starts**, never
when the change is requested: a model switched mid-turn must not kill the turn
in flight. The engine keeps a signature of the arguments and environment it
spawned with and compares it against the session's current settings on the way
into a turn, so an unrelated change (a rename) reuses the process and a real one
replaces it. A retired process is detached before it is killed, so its exit is
not mistaken for the current engine dying.

Claude Code also compacts the conversation on its own once the window fills,
and that is the one thing it does that reads as a crash. It takes minutes, puts
nothing else on the wire while it runs, and says so only in message subtypes an
adapter has to opt into: `system/status` with `status: compacting` when it
starts, `system/compact_boundary` with the numbers when it lands. Ignoring both
cost a session two stalls of 105s and 167s that looked identical to a hang —
the first was interrupted, which threw the compaction away and made the next
turn start it over from zero. So both are translated into `compaction` events,
and an interrupt that lands mid-compaction reports itself as one.

### Making a declared context window real

A session's `context_window` is meant to be the whole story: whatever it says,
the engine should hold. Getting Claude Code to agree takes three levers, and
they were measured — `/context` reports the window and where it came from —
rather than inferred:

| Lever | What it actually does |
| --- | --- |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | ignored outright for any model id beginning `claude-`. It is for models the CLI does not recognise, and for refusing an over-long prompt. |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | the auto-compact threshold — but clamped to the window the CLI believes the model has, so alone it can only lower it. |
| `[1m]` on the model name | raises that ceiling to 1M, which is what lets the clamp land on the declared number. |

Only the first was being set, so a session that declared 800k was compacted at
167.5k — 200k less the reply buffer the CLI holds back — with its own number
sitting unread in the environment. All three are set now, so 800k declared is
800k held, on `claude-opus-5` and `claude-sonnet-4-5[1m]` alike. The suffix does
not reach the provider: the CLI strips it and sends the `context-1m-2025-08-07`
beta instead, confirmed on the wire against a capture endpoint. It has to be
used in both places the model is named — `argv` at spawn and the `set_model`
control between turns — or the first hot model switch drops it and quietly
takes the window back down.

Only ids the CLI keeps a window for get the suffix. A model it does not
recognise takes the declared number straight from
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` — `gpt-5` reports the full 800k with no suffix
— so adding one would buy nothing and put a 1M beta header in front of a
provider with no use for it.

The threshold itself is held to **100k–1M** whatever it is given, so a session
declaring 2M is compacted at 1M. Compaction also fires a little under whatever
it lands on — the CLI holds a buffer back for the reply, 33k at the time of
writing — and there is no lever that hands it that room separately. A declared
800k is therefore compacted at about 767k, and the gauge is still drawn against
800k: four percent nobody can see is not worth a second number on screen
explaining itself.

**Codex** has the same disease and a different cure. It resolves the window
from its model catalog, so a declared number reached it not at all: every entry
says 272k, the effective window is 95% of that, and a model the catalog has
never heard of — `gpt-5-codex` behind a gateway, say — gets "Model metadata not
found. Defaulting to fallback metadata" and the same 272k. `model_context_window`
looks like the lever and is not: it is a real `ConfigToml` key, and setting it
leaves the recorded window exactly where it was. What works is replacing the
catalog. `model_catalog_json` takes a path, so Caden reads the CLI's own catalog
back out of `codex debug models`, sets every window to what the session
declared, clones an entry for a model the catalog is missing, and points the
spawn at the result. The catalog's own `effective_context_window_percent` is
set to 100 on the way past, or the CLI charges for the reply a second time on
top of the headroom Caden has already left it.

An entry has twenty-five fields, which is why the catalog is patched rather
than written: inventing one invites a parse failure, and Codex refuses to start
on a `model_catalog_json` it cannot read. An install too old to render a
catalog logs and keeps its own window, rather than failing the session.

Codex compacts too, and says so in three places: `/compact` is a request Caden
makes itself, an automatic one arrives as a `contextCompaction` item whose
*start* is the signal that matters, and `thread/compacted` closes either. All
three now raise the same `compaction` events the Claude adapter does — the
phase belongs to `BaseEngine`, so one client vocabulary covers both. The item
carries no token counts, so a Codex compaction reports how long it took and
nothing else, and the row reads as a sentence either way.

Codex compacts at **nine tenths of its catalog window**, and takes no
instruction on the point. That was measured rather than assumed, in both
directions: on `codex-cli` 0.146.0 a catalog window of 100k resolved
`auto_compact_scope_limit=Some(90000)` with `model_auto_compact_token_limit`
set to 95000 on the command line, and again with `auto_compact_token_limit`
written into the catalog entry itself — a real field of the entry schema; a
0.149.1 on a devbox logged a limit of 748800 against a window of 832000. The
line to read is `post sampling token usage` in `$CODEX_HOME/logs_2.sqlite`,
which is where to re-measure this after a Codex release.

So the catalog window is not only what fits, it is where compaction lands, and
a window written as `declared + reserve` spent the reserve on the threshold
instead of the reply: 800k declared recorded 832000 and compacted at 748800,
51200 short, on every turn, with the gauge still drawing 800k. What is written
now is ten ninths of the declared number — 800k records 888889 — so Codex's own
tenth comes off it onto 800000 exactly, and the tenth above the compaction
point is the reply's room. `model_auto_compact_token_limit` is still set to the
declared number: nothing reads it today, and it names the same point the window
already puts the session at, so a build that starts reading it agrees rather
than moves anybody.

**Codex** is driven through `codex app-server`, the newline-delimited JSON-RPC
protocol the interactive Codex speaks — one long-lived process per session, as
above. The batch entry point (`codex exec`) was the obvious choice and the wrong
one: it hands its prompt straight to the model, so a slash command never reaches
a parser and `/compact` silently does nothing. app-server has
`thread/compact/start` as a method, streams reasoning and message deltas that
exec only ever delivered at the end of a turn, and takes the sandbox and model
per turn rather than baking them into a process.

It has `thread/goal/set|get|clear` too, and Caden uses exactly one of them:
`clear`, on every start, so that Codex's own goal loop cannot run alongside
Caden's. Goals are Caden's now — one set of states and one judgement whichever
CLI is underneath. See [GOALS.md](GOALS.md).

Two shapes for one decision, worth remembering: `thread/*` takes `sandbox` as a
mode string (`read-only`), `turn/*` takes `sandboxPolicy` as a tagged object
(`{"type": "readOnly"}`).

Approvals arrive as server-to-client requests. Nobody is sitting there to answer
them, so the adapter answers from the session's permission mode — which is
exactly why Caden asks for one when the session is created.

A third `mock` engine emits every event shape on demand; it is what the test
suite runs against.

### Event vocabulary

| Event | Payload | Meaning |
| --- | --- | --- |
| `session.init` | engine, model, native_id, tools, cwd | engine process came up |
| `user` | turn, text | a turn was submitted |
| `turn.start` / `turn.end` | turn, usage, context_usage, cost_usd, error | turn boundaries |
| `text` / `text.delta` | block, text | assistant output (final replaces deltas) |
| `thinking` / `thinking.delta` | block, text | reasoning |
| `tool.start` / `tool.end` | tool_id, name, title, input / output, is_error | tool calls |
| `todo` | items[] | plan updates |
| `compaction` | state, pre_tokens, post_tokens, duration_ms | the engine rewriting the conversation |
| `diff` | files[] | file changes |
| `status` | state | idle / running / error / stopped |
| `error` | message | surfaced failure |
| `queued` / `interrupted` | turn | queue and interrupt notices |

A turn is not one request. Claude Code re-sends the whole prefix on every
tool call, so `usage` — the turn's total, and what a bill is made of — is a
multiple of what the context window actually holds. `context_usage` is the
turn's *last* request, which is the number a window gauge wants. Claude Code
gives the total in its `result` event and the per-request figure on each
assistant message; Codex hands over both directly as `tokenUsage.total` and
`tokenUsage.last`.

`text.delta` and the final `text` share a `block` key. The reducer in
`app/web/transcript.js` keeps one entry per block and lets the final value
overwrite the streamed one, so a mid-turn reconnect never doubles text.

## Goals

A goal is an objective a session works toward across turns without being asked
again: *make every test in `tests/` pass*. After each turn Caden checks whether
it is finished, and if it is not, sends the next turn itself.

The loop is Caden's. Both CLIs have a `/goal` of their own and neither is
used — Codex's is a standing objective its own server drives, Claude Code's is
a stop condition inside the CLI that reaches the wire as nothing at all, and
one loop here means one vocabulary, one schema and the same behaviour whichever
engine is underneath.

### States

Four, and the absence of one. There is deliberately no terminal "achieved": a
goal that is met is deleted and the chip goes with it. Nothing is written down
about it either — the chip carries the objective, the state, the turn count and
the last check right up to the moment it goes, and a session that narrated all
of that into the transcript read as a log of Caden talking to itself.

| State | Meaning | Drives? | Engine reaped when idle? |
| --- | --- | --- | --- |
| `active` | in force, being worked on | yes | no |
| `paused` | in force, a person pulled the brake | no | yes |
| `blocked` | the same blocker three checks running | no | yes |
| `exhausted` | a budget ran out | no | yes |
| *(none)* | never set, cleared, or met | — | yes |

### Commands

`/goal` · `/goal <objective>` · `/goal clear` · `/goal pause` · `/goal resume` ·
`/goal budget <n>`. All answered by the session, none reaching the CLI, none
taking a turn, and all skipping the queue — a `/goal clear` that waits its turn
is a brake queued behind the wheel it is trying to stop.

Only two things put words in the transcript: `/goal` typed on its own, and a
command that could not do what it was asked. Everything that worked is already
on the chip. The three automatic stops — blocked, out of budget, and a check
that could not be made — do say so out loud, because they happen with nobody
watching and mean the goal is waiting on a person.

Two transitions are asymmetric on purpose. **Any user message returns a
`blocked` goal to `active`**: `blocked` means "this needs a person" and one has
just arrived. `paused` and `exhausted` are a decision and a ceiling, and an
unrelated question should overturn neither — so **`exhausted` refuses
`resume`**, and names the one thing that does work.

### What is stored

One goal per session in `meta["goal"]`, saved and reloaded with the rest of it:
`objective`, `status`, `set_at`, `turns_used`, `tokens_used`, `tokens_at_set`,
`token_budget`, `last_verdict`, `last_reason`, `blocked_streak`.

`tokens_used` is the session's own accounting less what it stood at when the
goal was set; nothing new is collected for it. `token_budget` has **no
default** — a goal runs until it is finished or stopped, and `/goal budget <n>`
is the answer when that matters. Tokens rather than turns because a bill is
denominated in them: a turn that reads three files and one that rewrites a
module cost two orders of magnitude apart. `turns_used` is a counter, not a
ceiling, and counts only turns Caden sent that actually started.

### The loop

Hung off the end of `finish_turn`, the only place a turn is known to be over.

1. Nothing to do unless the goal is `active`, the queue is empty and no turn is
   running. **A queued message goes first** — the loop stands aside for the
   person it is working for.
2. Over budget → `exhausted`.
3. Ask the judge — **except on the first step**, which drives without one. A
   goal set a moment ago has had no turn run against it, so asking spends a
   round trip being told what is already known, and it is the round trip
   somebody is watching.
4. `done` → delete the goal. The chip going is the report.
5. `blocked` → count it; three in a row stops and says what it is stuck on.
   Below that, carry on: the first sight of a blocker is usually the engine
   noticing it, and the turn after often walks around it.
6. Otherwise count the turn and send the drive message.

### The judge

A call Caden makes itself, with the session's own provider credentials — not a
question put to the engine, which is why the answer is the same on both sides
and why it costs no turn. It is shown the objective, the budget, and the tail
of the transcript **with tool output in it**: an assistant saying it finished is
a claim, and a judge given only claims is not auditing anything. It answers
with one line of JSON: `done`, `continue` or `blocked`, and a reason.

Uncertain resolves to `continue`. The failure that matters is not a loop that
runs one turn too many; it is a loop that stops on a plausible-sounding claim.
A check that cannot be made at all moves the goal to `blocked` rather than
being retried silently — a loop that cannot tell whether it is finished does
not know when to stop.

The drive message is an ordinary turn marked `driven`, carrying the objective
fenced as data (the task to pursue, not instructions with authority of their
own — it reaches the model as text, and a goal is somewhere a prompt injection
would love to live) and the budget as used, total and **remaining**. It writes
no `user` event, so none of it reaches the transcript: the turn opens, the work
appears in it, and the chip's turn count says where it came from.

Still open: whether "no budget by default" is right for a loop that can be left
overnight; whether a cheaper model should judge; whether the judge should get a
read-only tool channel; and Codex's second injection point — it also steers
*during* a long turn, and this only drives between them.

## Protocol → engine routing

`ModelProtocol.engine` is the single place the rule lives:
`anthropic-messages → claude`, `openai-responses → codex`,
`openai-chat → codex` (chat wire mode). The provider block on a session carries
`base_url`, headers and the API key; the daemon turns that into the right
environment for the chosen engine — `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`
for Claude Code, `-c model_providers.caden.*` overrides for Codex.

## Where the API key lives

Not in `config.json`: model API keys sit in the login keychain, under
`provider.<id>` accounts next to the daemon tokens. The renderer never holds
one — `/host/config` returns `hasKey` booleans, and a session create or
provider switch carries `key_ref: <providerId>` instead of a value. The proxy
in `server.js` swaps in the real key (`app/secret-inject.js`) on exactly those
two routes, the same injection point that adds the daemon bearer token, so the
secret crosses neither the renderer nor the config file. A key the keychain
does not have is forwarded keyless and rejected at the daemon by
`require_credential`, which is also where "Caden never falls back to the
server's own engine login" is enforced.

The key *is* persisted server-side, in the session's `meta.json`: a session
has to survive a daemon restart and keep billing to the same account, and the
daemon is the trust boundary (loopback bind, bearer token, 0700 home). Session
listings redact it before they leave the daemon.

`/host/providers` speaks a three-state protocol for the field: a non-empty
string sets or replaces the key, `null` deletes it, and absent/empty keeps
whatever the keychain holds — the renderer cannot send back what it cannot
see. Providers removed from the list take their keys with them, and a one-time
migration lifts plaintext keys written by older builds into the keychain,
stripping a key only after its keychain write succeeded.

## Engine installs

Everything an install writes lands under `$CADEN_HOME` — `engines/<engine>/` for
the payload, `bin/<engine>` for the symlink the session's PATH resolves, and
`runtime/node/` when a private Node is needed. Nothing needs root and nothing is
written outside that directory, so removing `~/.caden` removes every trace.

Both engines are published as self-contained native binaries, and both install
paths fetch exactly the same artifact for the server's reported `os/arch/libc`:

- **Claude Code** — the npm platform package
  `@anthropic-ai/claude-code-<platform>`, resolved through the registry API. Its
  payload is a single native binary, not JavaScript.
- **Codex** — the GitHub release asset for the architecture. Codex publishes
  static musl builds, which run on glibc hosts too, so there is one asset per
  architecture. It is really two binaries: the Code Mode host ships as its own
  asset, and without it Codex starts, answers, and cannot run a single command.

When the server has outbound network it resolves and downloads that artifact
itself. When it does not, the app is the transport: the artifact is cached
locally, uploaded in 4 MiB chunks with a SHA-256 check, and installed from the
upload. The installer recognises three artifact shapes: a
native payload inside an npm tarball, a release archive containing one binary,
and a whole `npm install --prefix` tree. A bare npm tarball with no binary inside
falls back to npm, which is the only path that needs Node.

Because installs are the step most likely to silently half-succeed, `finalize`
verifies the binary the chosen method claims it wrote, rather than whatever
`which` happens to find — otherwise a pre-existing copy on `PATH` would be
reported as a successful install.

Codex's second binary has to be linked into `bin/` as well as installed beside
the first. Codex resolves the Code Mode host as a sibling of the path it was
*launched* as, and macOS reports that path without following symlinks — so a
host installed only next to the real binary is invisible to a Codex started
through `bin/codex`, which is how every session starts it. The daemon relinks it
at startup, so an install that predates this repairs itself without a reinstall.

## HTTP surface

Base `http://127.0.0.1:<port>/v1`, normally reached through the ssh forward.
Every route except `GET /v1/ping` (and `/`, its alias) requires
`Authorization: Bearer <token>`. The token is generated on first start and
stored at `$CADEN_HOME/token`, 0600.

### Host

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/ping` | unauthenticated liveness + version |
| `GET` | `/v1/health` | host facts, engine versions; `?probe=1` adds a network probe |
| `GET` | `/v1/system` | health plus network probe and disk usage |
| `POST` | `/v1/network/probe` | `{hosts: [...]}` — TCP reachability check |
| `POST` | `/v1/exec` | `{command \| argv, cwd, timeout}` → `{code, stdout, stderr}` |
| `GET` | `/v1/fs?path=&hidden=` | directory listing for the workdir picker |
| `POST` | `/v1/shutdown` | stop the daemon; the reply is sent before it goes |

### Engines

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/engines?latest=1` | installed engines, arch, libc; `latest` adds the published version and `update_available` |
| `POST` | `/v1/engines/install` | `{engine, method, version?, artifact?}` → a job |

`method` is `auto` (probe the network and choose), `npm`, `native`, or `offline`
(requires `artifact`, a path returned by the upload endpoints).

### Jobs

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/jobs` | recent jobs |
| `GET` | `/v1/jobs/<id>` | one job |
| `GET` | `/v1/jobs/<id>/events` | SSE: `step`, `log`, `progress`, `done` |

### Sessions

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/sessions` | list |
| `POST` | `/v1/sessions` | create; see the spec below |
| `GET` | `/v1/sessions/<id>?after=N&limit=M` | session plus events after a cursor |
| `GET` | `/v1/sessions/<id>?tail=N` | session plus the last N events, walked back to a turn start |
| `PATCH` | `/v1/sessions/<id>` | title, model, provider, permission mode, cwd, archived |
| `DELETE` | `/v1/sessions/<id>` | delete and purge the directory |
| `POST` | `/v1/sessions/<id>/messages` | `{text, images?}` — queued if a turn is running |
| `POST` | `/v1/sessions/<id>/interrupt` | interrupt the running turn, drop the queue |
| `POST` | `/v1/sessions/<id>/stop` | kill the engine process; the session stays resumable |
| `GET` | `/v1/sessions/<id>/events?after=N&follow=1` | SSE transcript stream |
| `GET` | `/v1/sessions/<id>/events?tail=N&follow=0` | SSE tail window, streamed oldest first for a progressive open |
| `GET` | `/v1/sessions/<id>/logs?kind=stderr\|commands` | raw engine logs |

A backfill returns at most `limit` events (2000 by default) and sets
`truncated` when it stopped early. The cut is always from the front: fold what
you got, then subscribe from the last `seq` you saw and the event stream
delivers the rest.

`?tail=N` instead returns the **last** N events, for a cold open that wants
the conversation on screen now. The window is walked back to the nearest
turn boundary — a `user` event, or `turn.start` when it falls inside a stretch
of queued turns, whose `user` events were all emitted at queue time — so the
window never begins mid-block. `truncated` says whether older events exist;
a full backfill from `after=0` is how a client loads them on demand. N is
capped at 5000; windows within the daemon's in-memory ring (2048 events) cost
no file I/O.

The same window comes as a stream from
`/v1/sessions/<id>/events?tail=N&follow=0`: a `__tail_meta__` event arrives
first (carrying `truncated`), then the window's events oldest first, then
`eof`. A client folds them as they land and paints in one round trip instead
of waiting on the whole window.

Tail windows are **compacted for transport**: a `tool.end` whose `output`
exceeds 4096 chars keeps its first and last 2048, joined by a marker carrying
the elided count, and gains `output_truncated: true` plus `output_size`. The
full backfill is not compacted, so loading the rest restores every output.

`provider` is replaced wholesale, not merged: protocol, endpoint, headers and
key are one credential set, and a partial update would leave the previous
model's endpoint or key in place. The protocol may not change — it decides the
engine, and that binding is fixed for the life of the session (`409`).

Create spec:

```jsonc
{
  "title": "refactor the parser",
  "engine": "claude",                    // or omit and let provider.protocol decide
  "model": "claude-opus-4-5",
  "model_label": "Claude Opus 4.5",
  "provider": {
    "protocol": "anthropic-messages",    // openai-responses | openai-chat
    "base_url": "https://gateway.internal/v1",
    "wire_api": "responses",             // codex only
    "headers": {"X-Tenant": "acme"},
    "api_key": "..."                     // required; there is no host-login fallback
  },
  "cwd": "/srv/app",
  "create_cwd": true,
  "permission_mode": "bypassPermissions", // acceptEdits | plan
  "context_window": 256000,              // claude: enforced via CLAUDE_CODE_MAX_CONTEXT_TOKENS
  "env": {"FOO": "bar"},
  "engine_args": ["--effort", "high"],
  "fast": true,                          // codex only; see below
  "message": "optional first turn"
}
```

`fast` asks for Codex's `priority` service tier — the CLI's own name for it is
Fast, at 1.5x speed for increased usage. It is a field on `turn/start`, beside
`effort`, so it costs neither a new process nor the prompt cache and takes
effect on the turn after it is set. Which models have it comes from the
catalog `codex debug models` prints, read once per engine; a model that
catalog has never heard of — the ordinary case behind a gateway — is asked for
anyway, because the entry Caden clones for it carries the tier.

| Field | Meaning |
| --- | --- |
| `fast` | what was asked for |
| `fast_state` | `on` / `off` — whether the last turn carried a tier |
| `fast_reason` | `model_not_supported`, when the catalog says the model has none |

`PATCH` takes `fast` too. Claude Code's fast mode is deliberately not offered:
it is not a request parameter but a routing decision at Anthropic's end, so
through a relay the CLI reports it on while nothing upstream is quicker.

### Uploads

Chunked and resumable, used by the offline install path.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/uploads` | staged artifacts |
| `POST` | `/v1/uploads` | `{name, size, sha256}` → `{id, path}` |
| `PUT` | `/v1/uploads/<id>?offset=N` | raw bytes at an offset |
| `POST` | `/v1/uploads/<id>/complete` | verifies the checksum and commits |

### Event streams

Server-sent events, one JSON object per `data:` line, each with a monotonic
`seq`. Reconnect with `?after=<last seq>`; the daemon replays from the log.

Note for client authors: the daemon guarantees one complete JSON object per
`data:` line, so a client can dispatch per line and never has to buffer until a
blank one. Comment lines (`: ping`) are keepalives and carry no payload.
