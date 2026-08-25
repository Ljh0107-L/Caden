#!/usr/bin/env node
// Removing a server has to reach further than this Mac's config file.
//
// The gateway routes to it, the console lists it, and -- the part that
// actually matters -- a key of its own is authorised on the gateway to open a
// tunnel in. Dropping the local entry and calling it removed leaves a machine
// you have disowned still able to connect.
//
// What runs here is the half that needs no other machines: the local
// bookkeeping, and that the tunnel's port assignment goes with the server
// rather than being left to be handed out again while the old unit still
// holds it. The two-machine half -- withdrawing the key, stopping the unit,
// rewriting the proxy -- was verified against real ones.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caden-removal-'));
const configPath = path.join(tmp, 'config.json');
process.env.CADEN_CONFIG = configPath;

const write = cfg => fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

write({
  servers: [
    { id: 'keep', name: 'keep', mode: 'tunnel', sshHost: 'nowhere.invalid',
      provisioned: true, remotePort: 7938 },
    { id: 'drop', name: 'drop', mode: 'tunnel', sshHost: 'nowhere.invalid',
      provisioned: true, remotePort: 7938 },
  ],
  // No hostname: with no gateway configured there is nothing to reach out to,
  // which is what keeps this test on one machine.
  web: { hostname: '', gatewayHost: '', serverId: 'keep',
         tunnels: { keep: 7901, drop: 7902 } },
});

const { removeServer } = require('../app/host');

(async () => {
  try {
    await removeServer('drop');
    const cfg = read();
    assert.deepEqual(cfg.servers.map(s => s.id), ['keep'],
                     'the server should be gone from the list');
    assert.deepEqual(Object.keys(cfg.web.tunnels), ['keep'],
                     'and its tunnel port with it — left behind, the next '
                     + 'server is handed a port an old unit may still hold');
    console.log('  ok     the server and its tunnel port go together');

    // Removing the one the console is served from cannot rewrite the proxy
    // around it, so the choice is cleared and the address is left working
    // rather than half torn down.
    write({ ...read(), web: { hostname: 'x.invalid', gatewayHost: 'nowhere.invalid',
                              serverId: 'keep', tunnels: { keep: 7901 } } });
    await removeServer('keep');
    assert.equal(read().web.serverId, '',
                 'the console server should be unset, not left dangling');
    console.log('  ok     removing the console server clears the choice');

    console.log('web_removal_test: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => {
  console.error('web_removal_test: FAILED\n  ' + e.message);
  process.exit(1);
});
