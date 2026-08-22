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
spawn at the result. 800k declared then records as 760k — the catalog's own
`effective_context_window_percent`, which is left alone because that 5% is the
CLI's reply headroom, the same idea as Claude Code's 33k buffer.

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

Codex needs no such approximation: its catalog window is set to the declared
number **plus `CODEX_REPLY_RESERVE`**, its own percentage cut is disabled, and
`model_auto_compact_token_limit` is set to the declared number itself. The reply
gets the reserve, the conversation gets exactly what was asked for.

**Codex** is driven through `codex app-server`, the newline-delimited JSON-RPC
protocol the interactive Codex speaks — one long-lived process per session, as
above. The batch entry point (`codex exec`) was the obvious choice and the wrong
one: it hands its prompt straight to the model, so a slash command never reaches
a parser and `/compact` silently does nothing. app-server has `thread/compact/start`
and `thread/goal/set|get|clear` as methods, streams reasoning and message deltas
that exec only ever delivered at the end of a turn, and takes the sandbox and
model per turn rather than baking them into a process.

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
