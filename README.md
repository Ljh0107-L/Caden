<div align="center">

<img src="app/icon.png" width="120" alt="Caden">

# Caden

**A desktop console for running Claude Code and Codex on your servers.**

[![CI](https://github.com/Ljh0107-L/Caden/actions/workflows/ci.yml/badge.svg)](https://github.com/Ljh0107-L/Caden/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: macOS arm64](https://img.shields.io/badge/platform-macOS%20arm64-lightgrey.svg)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

<div align="center">
  <img src="docs/screenshots/session.png" alt="A session in Caden: the request, the agent's plan, a shell call, and the answer" width="880">
</div>

Caden inverts the usual remote-development flow. Instead of

```
Local CLI  →  ssh  →  a shell on the server  →  commands
```

you get

```
Electron app (UI only)  →  HTTP  →  agent daemon on the server  →  the CLI  →  commands
```

The agent lives on the server. The desktop window is a console: it dispatches
turns, renders the transcript, and can be closed at any time without stopping
the work.

## Two ideas

**1. The agent is server-side; the app is just the front end.**
Caden installs a small daemon (`heartbeat`) under `~/.caden` on the server. That daemon
owns the CLI processes, the workspaces and the transcripts. The app reaches it
over HTTP through an SSH port-forward, subscribes to a sequence-numbered event
stream, and reconnects with a cursor. Shut the laptop mid-turn and the turn keeps
running; reopen it and the transcript replays exactly where it left off.

**2. The protocol picks the engine.**
Every model in Caden's registry declares the wire protocol it speaks:

| Model speaks | Caden drives it with |
| --- | --- |
| Anthropic Messages | `claude` (Claude Code) |
| OpenAI Responses | `codex` (Codex) |
| OpenAI Chat Completions | `codex`, in chat wire mode |

Pick a model, and Caden starts the right CLI with the right environment, base URL
and credentials. The protocol is bound to the session when it is created — the
two CLIs keep history in incompatible formats, so a model on the other protocol
needs a new session. Sessions are otherwise isolated from each other: each one
gets its own engine home (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), its own workspace
and its own credentials.

## Getting started

```bash
npm install
npm start
```

`npm run dev` serves the same UI at `http://127.0.0.1:8790` for a plain browser.

## Installing a build

Grab `Caden-<version>-arm64.dmg` from the [latest release](https://github.com/Ljh0107-L/Caden/releases),
open it, and drag Caden into Applications.

Caden is ad-hoc signed and **not notarized** — there is no Apple Developer
account behind it — so the first launch is blocked by Gatekeeper:

1. Open Caden once; macOS says it "cannot check it for malicious software".
2. **System Settings → Privacy & Security** — a security notice about Caden is
   at the bottom of the page.
3. Click **Open Anyway** and confirm. From then on it launches normally.

The warning is expected, and it is the whole cost of skipping the $99/year
certificate: the app is signed, just not by an identity Apple has on file.
The terminal escape hatch does the same thing in one line:

```bash
xattr -dr com.apple.quarantine /Applications/Caden.app
```

The DMG is Apple silicon only. On Intel, or to track development, run from
source (`npm install && npm start` above) — a locally built app is never
quarantined, so Gatekeeper never enters into it.

## Connecting to a server

**A new server** — `provision.sh` copies the daemon over, starts it, registers
the server locally and stores its token in your login keychain:

```bash
scripts/provision.sh user@host
```

It needs only **Python 3.6+** on the far end. No pip, no Node, no root. Re-run it
any time to upgrade a server to a newer `heartbeat.py`.

Provisioning also installs a **supervisor** so the daemon comes back after a
crash or a server reboot: a systemd user service (`Restart=always`, linger on)
when the box has a working systemd user bus, otherwise a cron watchdog —
`@reboot` plus a once-a-minute check that re-runs bootstrap, which is a no-op
while the daemon is alive. On minimal hosts with neither mechanism, Caden still
installs the daemon and reports that it is unsupervised. Everything stays in
the user's own account; `supervise.sh uninstall` removes both where present.

**Then open the forward** — nothing is exposed to the network; the app reaches
the daemon through `ssh -L`:

```bash
ssh -N -L 7838:127.0.0.1:7838 user@host
```

The app does not manage the forward itself yet, so keep that running (or use an
`autossh` / `ControlMaster` setup of your own).

<div align="center">
  <img src="docs/screenshots/servers.png" alt="The Servers pane: what is installed on each machine, and what is left to do" width="880">
</div>

**No server at all** — run everything locally:

```bash
scripts/dev-seed.sh
```

## Installing the engines

Neither engine has to be there to install the daemon — a session only fails when
its first turn tries to start one. The daemon installs them itself, two ways:

- **from the server** — it probes each source and prefers the platform package
  on the npm CDN, unpacking the native payload directly without requiring Node;
  GitHub releases remain a fallback.
- **offline** — for servers with no outbound network: resolve the build for the
  server's reported `os/arch/libc` (`linux-x64`, `linux-arm64-musl`,
  `darwin-arm64`, …), upload it in chunks, install from the artifact.

Both engines ship as self-contained native binaries, so **neither path needs Node
on the server**. Everything lands under `~/.caden`; nothing else on the box is
touched.

**There is no UI for this yet** — the renderer covers sessions only. Until there
is, ask the daemon directly through the forward:

```bash
curl -X POST http://127.0.0.1:7838/v1/engines/install \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"engine": "claude", "method": "auto"}'
```

`GET /v1/engines` reports what is installed, and `GET /v1/jobs/<id>/events`
streams the install log.

## Using it

Start a session: pick a model, browse the server's filesystem for a working
directory, choose a permission mode, and go. The transcript renders assistant
text as markdown, tool calls as collapsible cards with their output, todo lists,
file changes and per-turn token/cost summaries.

Every model needs its own API key — Caden never falls back to a `claude login`
sitting on the server, because that would make the account a session bills to
depend on who last logged in there.

Attachments go by what they are, not by how you attached them: paste a
screenshot or pick it with `+` and it rides in the turn as an image the model
reads; anything else — an archive, a video, a 40 MB png — is pushed to the
server and the message carries the path the agent can open. Attachments are
capped at 50 MB.

## Layout

```
package.json           the Electron app
app/main.js            main process: the window, and closing the forwards on quit
app/server.js          local host server — serves the renderer and proxies the
                       daemon with the token injected, so the renderer never
                       holds a secret and never fights CORS
app/host.js            the control plane behind /host/*: the app's config file,
                       the server list, provisioning, the SSH forwards and the
                       readiness checks — everything the renderer cannot do for
                       itself because it needs the filesystem, ssh or the keychain
app/web/               the renderer: plain HTML/CSS/JS, no framework, no bundler
app/verify/            tooling for diffing Caden's DOM against a live Cursor
server/heartbeat.py    the daemon: sessions, engines, SSE, installs (stdlib only)
server/bootstrap.sh    provisioning: finds python3, starts heartbeat, returns a token
server/supervise.sh    crash/reboot supervision: systemd user service or cron watchdog
scripts/               build-app.sh, provision.sh, dev-seed.sh, screenshots.mjs,
                       release-notes.sh (the notes a release carries, from CHANGELOG.md)
tests/                 run-all.sh, the client suite and the offline-install suite
docs/ARCHITECTURE.md   how the pieces fit, and the event vocabulary
docs/API.md            the daemon's HTTP surface
docs/DESIGN.md         the visual system
```

## Development

```bash
scripts/dev-seed.sh    # runs a local daemon and points the app at it
npm test               # full sweep
scripts/dev-seed.sh --clean
```

The test suite needs no model credentials: the session pipeline is exercised
through a built-in mock engine and the installer through synthetic artifacts.

The end-to-end suite drives the real renderer in a browser against the mock
engine; it runs in CI, and locally after a one-time browser download:

```bash
npx playwright install chromium
npm run test:e2e
```

The front end has no third-party assets and no build step: `app/web/` is plain
ES modules, one stylesheet, and an inline SVG icon set (`icons.js`).
`docs/DESIGN.md` is the spec `styles.css` and `templates.js` implement — the
alpha ladder, the type scale, the radius scale and the row geometry all come
from there, so a visual change starts by changing the document.

`app/verify/` holds the parity tools: `text-diff.py` compares two style probes
by what a reader sees (aligning text-bearing nodes by their text, which
survives restructuring), and `style-diff.py` compares them node by node.
Capture a probe by running the app with `CADEN_VERIFY=1` and posting the walk to
`/host/stage`, which lands it in `app/verify/baseline/`. Captures are local and
gitignored: a probe records whatever the window was showing, so it is yours to
take, not something to ship.

`app/web/fonts/` holds JetBrains Mono (latin subset, regular and bold) under
the SIL Open Font License 1.1 — `fonts/LICENSE` is the licence it ships under.
The files are committed rather than built, so the app packages without an
`npm install`; `@fontsource/jetbrains-mono` is a devDependency only, to record
where they came from and to make a version bump reproducible:

```bash
npm install --save-dev @fontsource/jetbrains-mono@latest
cp node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2 \
   app/web/fonts/jetbrains-mono-400.woff2
cp node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2 \
   app/web/fonts/jetbrains-mono-700.woff2
cp node_modules/@fontsource/jetbrains-mono/LICENSE app/web/fonts/LICENSE
```

## Security notes

- The daemon binds `127.0.0.1` and requires a bearer token; the token is
  generated on the server and stored in your login keychain.
- **Token file** — a server can instead name a file to read its token from,
  for teams whose secrets are managed by other tooling.
- Model API keys live in your login keychain, never in `config.json`. The
  renderer only ever sees a `hasKey` boolean; the local host server injects
  the real value when a session create or provider switch is proxied to the
  daemon, the same way it injects the daemon token. Keys are passed to the
  engine as process environment and never written into a session's own
  engine config (the session's `meta.json` does carry them, server-side, so a
  session can resume after a daemon restart).
- `POST /v1/exec` and the agents themselves run commands on the server. That is
  the product, not a bug — treat a Caden server as a machine you have handed the
  agent. Default permission mode is full access; the composer can drop a session
  to workspace-write or read-only.

## Links

- [linux.do](https://linux.do) — the community this project hangs around in.

## License

Caden is released under the [MIT License](LICENSE).

The bundled JetBrains Mono font files in `app/web/fonts/` are copyright their
authors and shipped under the SIL Open Font License 1.1; see
`app/web/fonts/LICENSE`.
