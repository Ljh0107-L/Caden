#!/usr/bin/env node
// A forward has to prove which daemon is on the other end of it, not that
// something is.
//
// Every daemon answers /v1/ping, and answers it identically. So a local
// daemon of this Mac's own, holding the port a server's forward was
// configured for, was indistinguishable from that forward working -- and the
// app went on addressing the wrong machine for the rest of the session while
// reporting the right one as connected. It surfaced as a server that would
// not take an upgrade: the revision it reported was somebody else's.
//
// The token is what tells two daemons apart, being 264 bits and one per home,
// so identity is what gets checked where there is one.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { forwardUsable } = require('../app/host');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caden-forward-'));
const daemons = [];

const freePort = () => new Promise(res => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => {
    const p = srv.address().port;
    srv.close(() => res(p));
  });
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function daemon(name) {
  const home = path.join(tmp, name);
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'server', 'heartbeat.py'),
                  path.join(home, 'heartbeat.py'));
  const port = await freePort();
  const child = spawn('python3', [path.join(home, 'heartbeat.py'),
                                  '--foreground', '--port', String(port)],
                      { env: { ...process.env, CADEN_HOME: home }, stdio: 'ignore' });
  daemons.push(child);
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/ping`);
      if (r.ok) break;
    } catch {}
    await sleep(100);
  }
  return { home, port, tokenFile: path.join(home, 'token') };
}

/// What the config holds for a server: where its daemon is, and the token
/// that proves it is that daemon. `tokenFile` rather than the keychain, so
/// this runs the same on CI.
const entry = (id, port, tokenFile) => ({
  id, name: id, mode: 'tunnel', sshHost: 'nowhere.invalid',
  provisioned: true, remotePort: port, localPort: port, tokenFile,
});

(async () => {
  try {
    const a = await daemon('a');
    const b = await daemon('b');

    assert.ok(await forwardUsable(entry('a', a.port, a.tokenFile)),
              'a forward reaching its own daemon should be usable');
    console.log('  ok     a forward to its own daemon is usable');

    // The bug: b's daemon is listening where a's forward was configured. It
    // answers ping exactly as a's would.
    const wrong = entry('a', b.port, a.tokenFile);
    const ping = await fetch(`http://127.0.0.1:${b.port}/v1/ping`).then(r => r.json());
    assert.equal(ping.ok, true, 'the wrong daemon answers ping just the same');
    console.log('  ok     the wrong daemon answers ping identically');

    assert.equal(await forwardUsable(wrong), false,
                 'a different daemon on the port must not count as this forward');
    console.log('  ok     but is not mistaken for the right one');

    // Nothing listening is still nothing listening.
    assert.equal(await forwardUsable(entry('a', await freePort(), a.tokenFile)), false);
    console.log('  ok     a closed port is not usable');

    // Without a token there is nothing to check identity with, and liveness
    // is all that is left -- a server mid-provision, before it has one.
    const noToken = { ...entry('a', b.port, undefined), provisioned: false };
    assert.equal(await forwardUsable(noToken), true,
                 'an unprovisioned server has no identity to check yet');
    console.log('  ok     an unprovisioned server falls back to liveness');

    console.log('forward_identity_test: OK');
  } finally {
    for (const d of daemons) d.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error('forward_identity_test: FAILED\n  ' + e.message); process.exit(1); });
