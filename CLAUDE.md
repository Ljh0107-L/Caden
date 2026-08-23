# Working on Caden

Caden is the tool this repository's author works in. It is also what you are
changing. The rule below exists because those two facts collide.

## Develop against the development install. Never against production.

Caden installs twice — see [docs/DEVELOPING.md](docs/DEVELOPING.md). Everything
you run, test, provision or break belongs to the **development** install:

| | yours to use | never touch |
| --- | --- | --- |
| app | `Caden Dev.app`, or `npm start` from the checkout | `/Applications/Caden.app` |
| config | `~/Library/Application Support/Caden Dev` | `~/Library/Application Support/Caden` |
| keychain | `app.caden.dev.secrets` | `app.caden.secrets` |
| daemon home | `~/.caden-dev`, port 7938 | `~/.caden`, port 7838 |
| on a server | `~/.caden-dev` (`scripts/provision.sh --dev host`) | `~/.caden` |

A production session may be hours of work with a large context behind it.
Restarting that daemon interrupts a live turn, and rewriting `heartbeat.py`
under it changes what comes back after the next crash — the supervisor's
`ExecStart` names the file, not the build that put it there.

Two things already enforce this, and neither is a reason to stop being careful:

- A checkout carries no `flavor.json`, so anything you run from source resolves
  to the development flavor.
- The development flavor refuses to provision `~/.caden` at all.

Neither covers a stray `ssh host 'rm ...'`, a hand-edited config, or a `curl` at
`127.0.0.1:7838`. Read the port and the path before you send the request.

**If you need production data** — a real session to reproduce a bug against —
copy it into the development home explicitly and work on the copy:

```
ssh host 'cp -r ~/.caden/sessions/<sid> ~/.caden-dev/sessions/'
```

**If a task genuinely requires touching production**, say so and ask first.
Do not decide on your own that this one is fine.

## House style

Read a few neighbouring functions before writing. Comments explain *why*, in
prose, usually with the concrete history that made the code look like this —
match that density rather than adding a comment per line. Commit subjects are
one sentence describing the new behaviour, no `feat:`/`fix:` prefix.

`npm test` is the full sweep and needs no model credentials. Anything that
touches paths, ports or identifiers belongs in `tests/flavor_test.cjs`.
