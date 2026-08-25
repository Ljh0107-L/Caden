# Reaching Caden from a phone

The desktop app is a console over daemons that run somewhere else. That is the
whole design, and it has an obvious consequence nobody had collected on: if the
work lives on the server, you should be able to look at it without the Mac.

This is how. Nothing here is a second Caden — it is the same renderer, served
by the daemon instead of by the app, reached through a proxy instead of an ssh
forward.

## The shape

```
   phone ──── https ────▶  gateway  ──┬─▶ 127.0.0.1:7901 ──╮
                          nginx       │                    │  ssh -R, opened
                       TLS + password └─▶ 127.0.0.1:7902 ──┤  by each server
                                                           │
                                              server A ────╯
                                              server B ────╯
```

**The arrows point outward from the servers.** The gateway never connects to
them, needs no key for them, and does not have to be able to reach them. Each
server opens a tunnel to the gateway and holds it open. So no server needs a
public address, and none needs a hole in a firewall.

The gateway does need a public address and a name in DNS. One machine, one
record.

## Both installs on one gateway

Caden installs twice — the build you use and a development one beside it —
and they are meant to share nothing. They can share a machine to be proxied
through; they must not share a hostname. A session cookie is per origin, so
one address would mean one sign-in covering both, one server list holding
both, and one install's nginx block being rewritten by the other's.

So: `caden.example.net` for the real one, `caden-dev.example.net` for the
other, both pointing at the same box. What that separates, and what it does
not:

| | |
| --- | --- |
| daemon home, port, keychain | separate — from `app/flavor.js` |
| systemd unit | `heartbeat.service` / `heartbeat-dev.service` |
| nginx site, web root | per hostname |
| rate limit | shared, and should be — it counts per source address |
| fail2ban | shared, and should be — it watches the whole access log |

Changing the hostname and applying takes the old site down. The certificate
is left, because deleting one is not a thing to do without being asked;
`certbot delete --cert-name <old>` when you want it gone.

## Provision the daemon as an ordinary user

Not as root. The daemon runs the agents, and the agents run arbitrary commands
— on a machine a browser can now reach. Claude Code enforces half of this
itself: `bypassPermissions` is `--dangerously-skip-permissions` underneath and
the CLI refuses it under a uid of 0, so the default permission mode simply
does not work on a root daemon. Caden says so when the session is created
rather than letting the engine die on its first line.

```
adduser --disabled-password --gecos "Caden agent" caden
install -d -m 700 -o caden -g caden /home/caden/.ssh
cp ~/.ssh/authorized_keys /home/caden/.ssh/          # so provisioning can reach it
chown caden:caden /home/caden/.ssh/authorized_keys
loginctl enable-linger caden                         # its service starts at boot
```

Then `scripts/provision.sh caden@your-host`. An ssh alias for that user is
worth adding, since every later upgrade goes the same way.

## What runs where

| | |
| --- | --- |
| **gateway** | nginx: TLS, one password, and `/proxy/<id>/` routed to the right tunnel with that daemon's token added. Also `/srv/caden-web`, the console's files. |
| **each server** | the daemon it already ran, plus an `ssh -R` unit. Nothing else changes. |
| **your Mac** | still the place you add servers, provision them and set keys — and still reaches them over its own ssh forwards, unaffected by any of this. |

## Setting it up

**From the app: the Web pane**, under Models. It asks for the three facts only
you know — the hostname, which machine runs the proxy, which server's daemon
serves the console — and does the rest over ssh, streaming what it is doing:
the certificate, the nginx block with each daemon's token in it, the rate
limit, the ban rule. Apply is also how you change any of it later; the
configuration is rewritten each time, and rolled back if nginx refuses it.

The password is set from the same pane and goes straight through to the
daemon. Caden does not keep a copy: the only thing that needs it is the
process being asked to check it.

**From a terminal**, if you would rather read it before it happens:

```
scripts/web-gateway.cjs caden.example.net
```

It prints the same nginx block, a systemd unit per tunnelled server, and the
`host/config` the console reads, with the tokens filled in. It applies
nothing; read it, then paste it.

The tokens are the reason the script exists. They are 44 characters of base64,
one per server, and a character wrong gives you a 401 from a daemon that is
running perfectly. **Its output contains those tokens in clear**, which is
unavoidable — the proxy has to inject them — so treat the output as a secret.

Four things it cannot do for you:

1. **DNS.** An `A` record for the name, pointing at the gateway.
2. **A certificate.** `certbot --nginx -d caden.example.net`, which needs port
   80 reachable for the challenge.
3. **A password.** `htpasswd -B -c /etc/nginx/caden.example.net.htpasswd you` —
   and generate it with a password manager rather than inventing one. It is
   the only door.
4. **The console's files.** `rsync -a --delete app/web/ gateway:/srv/caden-web/`.

## The one that will bite you

```nginx
proxy_buffering off;
proxy_read_timeout 3600s;
```

Caden is an event stream from end to end. nginx buffers responses by default,
and a buffered stream does not fail — it hangs. The console sits there looking
exactly like a daemon that died, and nothing in any log says otherwise. The
generated block includes both lines; if you write your own, do not drop them.

## What the console does differently over there

It asks what its host can do (`capabilities` in `/host/config`) and stops
offering what it cannot. Behind a proxy that means no adding servers, no
provisioning, no opening forwards, no `~/.ssh/config` — all of those need a Mac
with ssh and a keychain. The Servers pane still reports what it finds, because
hiding the actions should not hide the diagnosis.

Attachments work. There is no native file panel, so the `+` button opens the
browser's own and uploads the bytes straight to the daemon — which is the
endpoint the Mac route calls anyway, so the message ends up carrying the same
server-side path.

## Credentials

Session creation sends a provider id, not a key. On the Mac the app swaps in
the real value from the login keychain; a proxy cannot, because it can add a
header but not rewrite a JSON body. So provisioning syncs your keys to
`~/.caden/providers.json` on each server (0600) and the daemon resolves the
reference itself.

**This means every server you provision holds a copy of your model API keys.**
That was already half true — a session's `meta.json` has always carried the key
it runs under, so it could resume after a restart — but it is now systematic,
and worth knowing before you provision a machine you share with someone.

Rotating a key means re-provisioning the servers that use it. Nothing pushes on
its own.

## If you would rather not run a gateway

The gateway exists to solve one problem: your servers have no public address.
Two other things solve it, with different costs.

- **Tailscale.** Put the phone and the servers on one tailnet and each daemon
  is reachable by name, with a certificate, with no public port anywhere. It is
  the least infrastructure of the three. The cost is an app on the phone.
- **Cloudflare Tunnel.** Each server dials out, no gateway and no public
  address, and the phone installs nothing. The cost is that Cloudflare
  terminates your TLS: transcripts and API keys are in clear at their edge.

Both leave everything above intact — the daemon serves the console the same
way. Only the thing in front of it changes.

## Signing in

The daemon's bearer token is the right credential for a program and the wrong
one for a person: a browser cannot put a header on the navigation that loads a
page. HTTP basic auth covered that and cost too much — the dialog belongs to
the browser rather than to Caden, it appears before anything has rendered, and
Safari re-prompts on its own schedule, which ends any event stream open at the
time.

So the console owns its sign-in. Set the password on the gateway's daemon,
from stdin so it does not survive in a shell history:

```
printf '%s\n' 'your password' | python3 ~/.caden/heartbeat.py --set-web-password
```

What nginx does with it is `auth_request`: before serving anything it asks the
daemon whether the request carries a valid session, and sends it to the login
page if not. That check has to live at the proxy rather than in a daemon,
because a gateway fronts several of them — `/proxy/<other>/…` never reaches
the process that owns the session.

Three routes are reachable without one, and they are the whole unauthenticated
surface: the login page, the form it posts to, and the verify endpoint nginx
itself calls.

Sessions last thirty days, are stored hashed (a copy of the file is not a
usable session), and survive a daemon restart — being signed out by a routine
upgrade would be its own small annoyance. Changing the password revokes them
all, which is usually the reason for changing it. So does losing a phone:

```
curl -X POST -H "Authorization: Bearer $(cat ~/.caden/token)" \
     http://127.0.0.1:7838/v1/web/logout-all
```

## What stands behind the password

Behind it is a service that runs arbitrary commands and holds your model API
keys, on a hostname that appeared in Certificate Transparency logs minutes
after the certificate was issued and is scanned continuously. Generate the
password; do not invent one.

If you use one you can remember anyway — and people do — three things make
that survivable, and the generator emits all of them.

**The verifier is slow on purpose.** pbkdf2-sha256 at 600k iterations is about
400ms on a small VPS. Paid once a month by whoever knows the password, and on
every guess by anyone else. (pbkdf2 rather than scrypt because `hashlib.scrypt`
needs a Python built against OpenSSL 1.1+, and this daemon's floor is whatever
a minimal container ships.)

**Rate limiting.** bcrypt at `htpasswd`'s default cost verifies in about ten
milliseconds and nginx will do it as fast as anyone asks, so a guessable
password falls in days. Raising the bcrypt cost is the wrong lever: a browser
sends basic auth on every stylesheet, font and poll, so the cost is paid on
every request by the person who *knows* the password. Capping the rate costs
that person nothing — an event stream is one connection, not a poll — and caps
the attacker at two attempts a second.

**fail2ban** is what actually ends it: five wrong guesses in ten minutes and
the address is gone for an hour. That is 120 attempts a day from one address,
which turns a hundred million combinations from days into longer than you will
be alive.

```
# /etc/fail2ban/filter.d/caden-login.conf
[Definition]
failregex = ^<HOST> .* "POST /v1/web/login HTTP/[0-9.]+" 401
ignoreregex =

# /etc/fail2ban/jail.d/caden.conf
[caden-auth]
enabled  = true
filter   = caden-login
port     = http,https
backend  = polling
logpath  = /var/log/nginx/access.log
maxretry = 5
findtime = 600
bantime  = 3600
```

`backend = polling` is not optional on Debian or Ubuntu. The default is
`systemd`, and a jail reading the journal never sees nginx, which logs to
files — the jail reports itself enabled and watches nothing.

Locking yourself out is a real possibility with `maxretry = 5`. It bans
`http,https` only, so ssh still works:

```
fail2ban-client set caden-auth unbanip <your address>
```

## Security, briefly

- The daemon still binds `127.0.0.1`. Nothing in this arrangement exposes it
  directly; the proxy is always in front.
- **Put an authenticating layer at the proxy.** `heartbeat.py` is hand-rolled
  stdlib HTTP that fronts an endpoint which runs arbitrary commands. What
  should face the internet is nginx, which has been shot at for twenty years.
  A password on the proxy means unauthenticated traffic never reaches the
  Python at all — that is most of the value here.
- An unauthenticated `/v1/ping` reports liveness and nothing else, so a
  misconfigured proxy does not hand out a version banner.
- Do not expect the hostname to be a secret. It is in Certificate Transparency
  logs within minutes of the certificate being issued.
