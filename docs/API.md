# heartbeat HTTP API

This is the daemon's surface. The desktop app has one of its own —
`/host/*`, served by `app/host.js` on a loopback port — which owns the config
file, the server list, provisioning and the SSH forwards. The renderer never
talks to a daemon directly: it goes through `/proxy/<serverId>/v1/...`, which
injects the bearer token.

Base: `http://127.0.0.1:<port>/v1`, normally reached through an SSH port-forward.
All routes except `GET /v1/ping` require `Authorization: Bearer <token>`.
The token is generated on first start and stored at `$CADEN_HOME/token` (0600).
The app keeps its copy in the login keychain, or in a file named by the server
profile's **Token file** setting.

## Host

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/ping` | unauthenticated liveness + version |
| `GET` | `/v1/health` | host facts, engine versions; `?probe=1` adds a network probe |
| `GET` | `/v1/system` | health plus network probe and disk usage |
| `POST` | `/v1/network/probe` | `{hosts: [...]}` — TCP reachability check |
| `POST` | `/v1/exec` | `{command \| argv, cwd, timeout}` → `{code, stdout, stderr}` |
| `GET` | `/v1/fs?path=&hidden=` | directory listing for the workdir picker |
| `POST` | `/v1/shutdown` | stop the daemon; the reply is sent before it goes |

## Engines

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/engines?latest=1` | installed engines, arch, libc; `latest` adds the published version and `update_available` |
| `POST` | `/v1/engines/install` | `{engine, method, version?, artifact?}` → a job |

`method` is `auto` (probe the network and choose), `npm`, `native`, or `offline`
(requires `artifact`, a path returned by the upload endpoints).

## Jobs

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/jobs` | recent jobs |
| `GET` | `/v1/jobs/<id>` | one job |
| `GET` | `/v1/jobs/<id>/events` | SSE: `step`, `log`, `progress`, `done` |

## Sessions

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
  "fast": true,                          // claude only; see below
  "message": "optional first turn"
}
```

`fast` asks Claude Code for fast mode, which has no flag: the daemon sends
`apply_flag_settings {"fastMode": true}` on the control channel as soon as the
process is up, because an SDK session reports `sdk_opt_in_required` until
something asks. Asking is not getting — it needs an Opus model and a plan that
carries it — so the session also reports what the engine said:

| Field | Meaning |
| --- | --- |
| `fast` | what was asked for |
| `fast_state` | `on` / `off`, as the CLI last reported it |
| `fast_reason` | why not, when the CLI gives one (`sdk_opt_in_required`, …) |

`PATCH` takes `fast` too, and it applies at the start of the next turn like
every other setting.

## Uploads

Chunked and resumable, used by the offline install path.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/uploads` | staged artifacts |
| `POST` | `/v1/uploads` | `{name, size, sha256}` → `{id, path}` |
| `PUT` | `/v1/uploads/<id>?offset=N` | raw bytes at an offset |
| `POST` | `/v1/uploads/<id>/complete` | verifies the checksum and commits |

## Event streams

Server-sent events, one JSON object per `data:` line, each with a monotonic
`seq`. Reconnect with `?after=<last seq>`; the daemon replays from the log.

Note for client authors: the daemon guarantees one complete JSON object per
`data:` line, so a client can dispatch per line and never has to buffer until a
blank one. Comment lines (`: ping`) are keepalives and carry no payload.
