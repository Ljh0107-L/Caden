#!/usr/bin/env node
// The two installs must not touch each other, and the real one must not move.
//
// Production's paths are load-bearing history: `~/.caden`, `Application
// Support/Caden` and `app.caden.secrets` are where every machine and key
// already set up can be found. Deriving them from the flavor's name instead of
// spelling them out would be tidier and would stand all of them up empty, and
// nothing else in the suite would notice.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FLAVOR_JS = path.join(__dirname, '..', 'app', 'flavor.js');

/// Resolved in a child process: flavor.js reads the environment once, at
/// require time, so one process can only ever answer for one flavor.
function resolve(name) {
  const env = { ...process.env };
  if (name) env.CADEN_FLAVOR = name; else delete env.CADEN_FLAVOR;
  return JSON.parse(execFileSync(
    process.execPath,
    ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(FLAVOR_JS)})))`],
    // stderr piped rather than inherited: one case here is meant to fail, and
    // its stack does not belong in a passing run's output.
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

const home = (...p) => path.join(os.homedir(), ...p);
const prod = resolve('prod');
const dev = resolve('dev');

// Verbatim, not derived.
assert.equal(prod.support, home('Library', 'Application Support', 'Caden'));
assert.equal(prod.controlDir, home('.caden-ssh'));
assert.equal(prod.keychainService, 'app.caden.secrets');
assert.equal(prod.bundleId, 'app.caden.desktop');
assert.equal(prod.remoteHome, '~/.caden');
assert.equal(prod.defaultPort, 7838);

// Every axis on which the two could collide has to differ. A new field that
// names a path or an identifier belongs in this list.
for (const key of ['support', 'controlDir', 'keychainService', 'bundleId',
                   'icon', 'remoteHome', 'defaultPort', 'tunnelBase',
                   'localPortEnd', 'label']) {
  assert.notEqual(dev[key], prod[key], `dev and prod share ${key}`);
}

// A sibling, not a child: the daemon reports disk usage across its whole home
// and clears directories inside it, so a nested development home would be
// counted -- and eventually swept -- as part of production's.
assert.ok(!dev.remoteHome.startsWith(prod.remoteHome + '/'),
          `${dev.remoteHome} is inside ${prod.remoteHome}`);

// Far enough apart that neither install's search for a free local port can
// walk into the other's range. Each one only knows the servers in its own
// config, so they cannot avoid each other any other way.
// The gateway's loopback is the one place the two can meet on a machine
// neither of them owns: both walk up from their base consulting only their own
// config, so a shared gateway put dev's second server and production's third on
// the same port. Whichever tunnel bound it first owned it, and the other
// console reached a daemon holding a different token -- which reads as "bad or
// missing token" on a server that is running perfectly.
// Local forward ports are a block per install, not an open-ended walk. Both
// allocators start at their own `defaultPort` and consult only their own
// config, so an unbounded walk on the production side reaches 7938 -- the port
// the development daemon listens on -- and development stops working because
// of how many servers production happens to have. Which install is "just
// development" does not make it acceptable in either direction.
const block = f => ({ from: f.defaultPort, to: f.localPortEnd });
const P = block(prod), D = block(dev);
assert.ok(P.to > P.from && D.to > D.from, 'each install needs a usable block');
assert.ok(P.to < D.from || D.to < P.from,
          `the local port blocks overlap: ${P.from}-${P.to} vs ${D.from}-${D.to}`);
assert.ok(dev.defaultPort > prod.localPortEnd,
          "production's walk must never reach the development daemon's port");

assert.equal(prod.tunnelBase, 7901);
assert.ok(Math.abs(dev.tunnelBase - prod.tunnelBase) >= 100,
          'the tunnel port ranges have to be far enough apart that neither '
          + "walk reaches the other's");
assert.ok(dev.tunnelBase > prod.defaultPort && dev.tunnelBase > dev.defaultPort,
          'tunnel ports must not collide with either daemon port');

assert.ok(Math.abs(dev.defaultPort - prod.defaultPort) >= 100,
          'the local port bases are close enough to collide');

// Failing towards the empty install: a checkout carries no flavor.json, and
// forgetting to declare one must never resolve to the app holding real work.
assert.equal(resolve(null).id, 'dev', 'an undeclared flavor is not development');

// A typo should stop the process, not silently pick one.
let refused = null;
try { resolve('produciton'); } catch (err) { refused = err; }
assert.ok(refused, 'an unknown flavor resolved to something');
assert.match(String(refused.stderr || refused.message), /not a flavor/);

// The guard that makes the whole arrangement safe, exercised in this process --
// which is the development install, because a checkout carries no flavor.json.
//
// Writing heartbeat.py into a home takes effect without `--restart`: the
// supervisor's ExecStart names the file, not the build that put it there, so the
// next reboot would bring production's daemon back on development code, with the
// real sessions still sitting in that home. It has to refuse before it reaches
// ssh, which is why an unreachable host is a fine target here.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caden-flavor-'));
process.env.CADEN_CONFIG = path.join(tmp, 'config.json');
const host = require('../app/host');
assert.equal(require('../app/flavor').id, 'dev', 'a checkout is not development');

host.provision({ id: 'x', mode: 'tunnel', sshHost: 'nowhere.invalid',
                 remoteHome: prod.remoteHome, remotePort: prod.defaultPort })
  .then(() => { throw new Error('the development build provisioned the production home'); },
        err => assert.match(String(err.message), /will not provision/))
  .then(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('flavor_test: OK');
  })
  .catch(err => { console.error(err); process.exit(1); });
