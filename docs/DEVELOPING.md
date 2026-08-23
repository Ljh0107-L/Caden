# Developing Caden while using Caden

The problem this document solves: Caden is the thing you work in, and it is also
the thing you are working on. A change that wedges the daemon should not cost
you the session you were in the middle of.

The answer is two installs that share nothing.

## The two installs

| | production | development |
| --- | --- | --- |
| app | `Caden.app` | `Caden Dev.app` |
| bundle identifier | `app.caden.desktop` | `app.caden.dev` |
| config, keychain | `Application Support/Caden`, `app.caden.secrets` | `Application Support/Caden Dev`, `app.caden.dev.secrets` |
| local ports | from 7838 | from 7938 |
| daemon on a server | `~/.caden`, port 7838 | `~/.caden-dev`, port 7938 |
| systemd unit | `heartbeat.service` | `heartbeat-dev.service` |

All of it derives from one place — [`app/flavor.js`](../app/flavor.js). Production's
values are the historical literals rather than something derived from the name:
they are where every machine and key already set up can be found, and a tidier
scheme would stand all of them up empty.

**A source checkout has no flavor, and an undeclared flavor is development.**
`scripts/build-app.sh` writes a `flavor.json` into the bundle it builds; the
repository has none, so `npm start` is always the development install. The
direction is deliberate: forgetting to declare a flavor should leave you talking
to the install with nothing in it, never to the one holding your work.

`CADEN_FLAVOR=prod` overrides that when you genuinely need to reproduce
something against the real config. `CADEN_CONFIG` still points the config file
anywhere you like, on top of either flavor.

## Building the development app

```
scripts/build-app.sh --dev
```

`dist/Caden Dev.app` — drag it to /Applications and it sits beside the real one
with its own icon. No dmg by default (the dmg is the slow part and there is
nobody to hand it to); add `--dmg` if you want one.

For a faster loop, skip the bundle entirely:

```
npm start
```

Same flavor, same config, same daemon — just Electron running the checkout.

## Giving it something to talk to

**Locally.** `scripts/dev-seed.sh` starts a daemon in `~/.caden-dev`. It adds no
server: the app adds this machine itself, as `This Mac`, the first time it starts
against an empty config — the same `ensureLocalServer` path production runs, just
pointed at the development home. `--clean` stops the daemon and drops the config.

That the two look identical is the point. An earlier version of this script
seeded a server of its own called `localhost (dev)`, which stood in front of
`ensureLocalServer` and left the development install showing something production
has no equivalent of.

**On a real server**, one flag:

```
scripts/provision.sh --dev user@host
```

That installs a second daemon in `~/.caden-dev` on port 7938, with its own
sessions, its own engine binaries and its own token. The production daemon in
`~/.caden` beside it does not notice.

The two daemons cost a few hundred MB per server, because each home installs its
own `claude` and `codex`. That is the point: an engine upgrade you trigger while
testing cannot reach the sessions you are working in.

## Agents develop against the development install, never production

Anything with a shell — a coding agent working in this repository, a script it
writes, a `curl` it sends — belongs to `Caden Dev`, `~/.caden-dev` and port
7938. Not `~/.caden`, not port 7838, not `Application Support/Caden`, not
`app.caden.secrets`. [`CLAUDE.md`](../CLAUDE.md) states this where an agent
picks it up without being told.

The reason is not tidiness. A production session can be hours of work with a
large context behind it; restarting that daemon interrupts a live turn, and the
next section explains what rewriting `heartbeat.py` under it does. An agent
moves faster than the moment you would have caught it in.

Two things enforce it — a checkout resolves to the development flavor, and that
flavor refuses to provision `~/.caden` — and neither covers a hand-edited
config or a request aimed at the wrong port. When production data is needed,
copy it into the development home and work on the copy; see the last section.

## The one rule

**Only provision `~/.caden` from a checkout of a released tag.**

Writing `heartbeat.py` into a home takes effect even without `--restart`. The
supervisor's `ExecStart` names the file, not the build that put it there, so the
next crash or reboot brings the daemon back on whatever code is sitting at that
path — with your real sessions still in that home.

The development app refuses to provision `~/.caden` at all, so the UI cannot do
this to you. `scripts/provision.sh` can, because production is its default and
that is the documented way to set a machine up; it prints the home and the port
it is about to touch before it touches them.

Keep the released tag checked out somewhere, and upgrade production from there:

```
git worktree add ../caden-release v0.1.0
```

Before upgrading a production daemon, take the sessions with you. They are read
back in full when the daemon starts, so a format change wants a way back:

```
ssh host 'tar czf ~/caden-sessions-$(date +%F).tgz -C ~/.caden sessions'
```

## Branches and releases

`main` stays releasable. Work on a branch, open a PR, merge when CI is green —
`.github/workflows/ci.yml` runs the suite plus the Playwright end-to-end job on
every pull request. Squash on merge: the history is linear and the commit
messages are single sentences describing what changed, and a squashed PR title
lands in the same shape.

**Merging does not release.** `.github/workflows/release.yml` fires on a `v*` tag
and nothing else, so main can collect several branches before a release. When
one is due: bump the version in `package.json`, add its section to
`CHANGELOG.md`, then

```
git tag v0.2.0 && git push --tags
```

The workflow refuses a tag that does not match `package.json`, and refuses to
publish a release with no changelog section — both fail the run rather than
shipping something wrong.

Rolling back is reinstalling the previous dmg from the GitHub release and
re-provisioning the servers from that tag's worktree, so leave old release
assets alone.

## Reproducing a production session in development

The development daemon starts empty, on purpose. When you need a real session to
debug against, copy it across explicitly:

```
ssh host 'cp -r ~/.caden/sessions/<sid> ~/.caden-dev/sessions/'
```

Explicit is the feature. Nothing else moves between the two homes.

## Tests

```
npm test              # the full sweep; no model credentials needed
npm run test:e2e      # renderer in a real browser, mock engine
```

`tests/flavor_test.cjs` is the one guarding this document: it asserts that
production's paths have not moved and that every axis on which the two installs
could collide still differs. A new field in `flavor.js` that names a path or an
identifier belongs in its list.
